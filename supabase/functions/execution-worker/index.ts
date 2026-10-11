// supabase/functions/execution-worker/index.ts
//
// Phase 4.2 execution worker. Invoked by the dispatch triggers (pg_net) and by its own
// fire-and-forget re-invocation between steps.
//
// WHAT RUNS WHERE
//   * DEMO runs (public.start_demo_run): each step is a real Anthropic Messages call, capped
//     and pre-flighted against the run's remaining INR budget, priced from private.model_pricing.
//   * every other run: still the stub (unchanged from 4.1). The business model is BYOK -- buyers
//     run blueprints on their own infrastructure -- so the platform worker never executes
//     entitled customers' workloads against the platform's API key.
//
// CONTRACT with the database (all RPCs are public.worker_*; service_role only):
//   worker_claim_next_step(p_run_id)                         -> {outcome:'claimed', step_id, step_index, retry_count} | ...
//   worker_get_step_context(p_run_id, p_step_id, p_expected_retry_count)
//                                                            -> {outcome:'ok', mode:'stub'|'demo', ...} | {outcome:'rejected', reason}
//   worker_checkpoint_step(p_run_id, p_step_id, p_expected_retry_count, p_output, p_cost_delta)
//   worker_retry_or_fail_step(p_run_id, p_step_id, p_expected_retry_count, p_error)
// Key names are snake_case exactly as the DB returns them (see tests/phase4/worker-contract).
//
// SECRETS / ENV: WORKER_SHARED_SECRET, ANTHROPIC_API_KEY (function secrets); SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by the platform. Prompts, responses and keys are NEVER logged.
//
// IDEMPOTENCY: the key  runId:stepIndex:retryCount  is sent as an `Idempotency-Key` header and
// stored in the step output. I found no evidence that Anthropic's own API deduplicates on it
// (third-party routers do), so it is NOT relied on: the real protection is the DB fence
// (expected_retry_count) which discards a stale worker's result. A duplicate provider call is
// therefore possible in a crash/redelivery race; its cost is bounded by the per-run cap.

import { createClient } from "npm:@supabase/supabase-js@2";

const WORKER_INTERNAL_BUDGET_MS = 90_000; // matches the 90 s system ceiling, not the 150 s platform limit
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const INPUT_OVERHEAD_TOKENS = 128; // message framing allowance on top of the byte bound
const MAX_OUTPUT_CHARS = 20_000; // defensive; the DB's own 50 KiB step limit still applies

// ---------------------------------------------------------------- types
type ClaimResult =
  | { outcome: "claimed"; step_id: string; step_index: number; retry_count: number }
  | { outcome: string; reason?: string };

type CheckpointResult = { outcome: string; reason?: string };
type RetryResult = { outcome: string; reason?: string };

type DemoContext = {
  outcome: "ok";
  mode: "demo";
  model: string;
  system: string;
  input_text: string;
  previous_output_text: string | null;
  max_output_tokens: number;
  timeout_seconds: number;
  budget_remaining_inr: number;
  price: { input_inr_per_mtok: number; output_inr_per_mtok: number };
};
type StepContext = DemoContext | { outcome: "ok"; mode: "stub" } | { outcome: "rejected"; reason?: string };

function isClaimed(c: unknown): c is Extract<ClaimResult, { outcome: "claimed" }> {
  if (c === null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  return o.outcome === "claimed" && typeof o.step_id === "string" &&
    typeof o.step_index === "number" && typeof o.retry_count === "number";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function isDemoContext(c: unknown): c is DemoContext {
  if (c === null || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  const p = o.price as Record<string, unknown> | undefined;
  return o.outcome === "ok" && o.mode === "demo" && typeof o.model === "string" && typeof o.system === "string" &&
    typeof o.input_text === "string" && (o.previous_output_text === null || typeof o.previous_output_text === "string") &&
    Number.isInteger(o.max_output_tokens) && (o.max_output_tokens as number) > 0 &&
    Number.isInteger(o.timeout_seconds) && (o.timeout_seconds as number) > 0 &&
    isNum(o.budget_remaining_inr) && !!p && isNum(p.input_inr_per_mtok) && isNum(p.output_inr_per_mtok);
}

// ---------------------------------------------------------------- pure helpers (exported for tests)
/** UTF-8 byte length. A token covers at least one byte, so bytes is a strict upper bound on tokens. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Cost in INR, rounded UP to 4 decimals. Exact integer arithmetic (rates have 4 decimals), identical
 * to private.model_cost_inr in the database: ceil((in*rIn + out*rOut) / 1e6 * 1e4) / 1e4.
 */
export function costInr(inputTokens: number, outputTokens: number, inRate: number, outRate: number): number {
  for (const v of [inputTokens, outputTokens]) {
    if (!Number.isInteger(v) || v < 0) throw new Error("invalid_token_counts");
  }
  if (!isNum(inRate) || !isNum(outRate) || inRate < 0 || outRate < 0) throw new Error("invalid_rates");
  const n = BigInt(inputTokens) * BigInt(Math.round(inRate * 1e4)) + BigInt(outputTokens) * BigInt(Math.round(outRate * 1e4));
  const q = (n + 999_999n) / 1_000_000n;
  return Number(q) / 1e4;
}

export function buildUserMessage(inputText: string, previousOutput: string | null): string {
  return previousOutput ? `Previous step output:\n${previousOutput}\n\nUser input:\n${inputText}` : inputText;
}

/** Worst case for ONE call: every input byte is a token and the model uses its whole output allowance. */
export function worstCaseCostInr(system: string, userMessage: string, maxOutputTokens: number, inRate: number, outRate: number): number {
  const inputBound = utf8Bytes(system) + utf8Bytes(userMessage) + INPUT_OVERHEAD_TOKENS;
  return costInr(inputBound, maxOutputTokens, inRate, outRate);
}

export const idempotencyKey = (runId: string, stepIndex: number, retryCount: number): string =>
  `${runId}:${stepIndex}:${retryCount}`;

// ---------------------------------------------------------------- Anthropic adapter
type ProviderOk = { ok: true; text: string; stopReason: string | null; usage: { input: number; output: number } | null };
type ProviderErr = { ok: false; error: string };

async function callAnthropic(
  apiKey: string, ctx: DemoContext, userMessage: string, idemKey: string, timeoutMs: number,
): Promise<ProviderOk | ProviderErr> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "idempotency-key": idemKey,
      },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: ctx.max_output_tokens,
        system: ctx.system,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `provider_http_${res.status}` }; // status only; never the body
    }
    let body: Record<string, unknown>;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "provider_bad_response" };
    }
    const blocks = Array.isArray(body.content) ? body.content as Array<Record<string, unknown>> : null;
    if (!blocks) return { ok: false, error: "provider_bad_response" };
    const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string)
      .join("").slice(0, MAX_OUTPUT_CHARS);
    const u = body.usage as Record<string, unknown> | undefined;
    const nat = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
    const inTok = nat(u?.input_tokens), outTok = nat(u?.output_tokens);
    const usage = inTok !== null && outTok !== null
      ? { input: inTok + (nat(u?.cache_creation_input_tokens) ?? 0) + (nat(u?.cache_read_input_tokens) ?? 0), output: outTok }
      : null;
    return { ok: true, text, stopReason: typeof body.stop_reason === "string" ? body.stop_reason : null, usage };
  } catch (e) {
    if (ac.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return { ok: false, error: "provider_timeout" };
    return { ok: false, error: "provider_network_error" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req: Request) => {
  const secret = Deno.env.get("WORKER_SHARED_SECRET");
  const auth = req.headers.get("authorization") ?? "";
  if (!secret || auth !== `Bearer ${secret}`) return new Response("unauthorized", { status: 401 });

  let body: { runId?: string } | null;
  try { body = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
  const runId = body?.runId;
  if (!runId || typeof runId !== "string") return new Response("runId required", { status: 400 });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return new Response("server misconfigured", { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();

  // --- 1. Claim ---------------------------------------------------------------
  const { data: claimRaw, error: claimErr } = await supabase.rpc("worker_claim_next_step", { p_run_id: runId });
  if (claimErr) {
    console.error("claim rpc error", claimErr);
    return new Response("ok (claim error logged)", { status: 200 });
  }
  const claim = claimRaw as ClaimResult;
  if (claim?.outcome !== "claimed") {
    console.log("claim outcome:", claim?.outcome, (claim as { reason?: string })?.reason);
    return new Response("ok (nothing to do)", { status: 200 });
  }
  if (!isClaimed(claim)) {
    console.error("claim payload malformed", JSON.stringify(claim));
    return new Response("ok (malformed claim logged)", { status: 200 });
  }
  const stepId = claim.step_id, stepIndex = claim.step_index, expectedRetryCount = claim.retry_count;

  // Fail the claimed step (the DB decides retry vs terminal failure).
  const failStep = async (error: string): Promise<Response> => {
    const { data: retry, error: retryErr } = await supabase.rpc("worker_retry_or_fail_step", {
      p_run_id: runId, p_step_id: stepId, p_expected_retry_count: expectedRetryCount, p_error: error,
    });
    if (retryErr) console.error("retry rpc error", retryErr);
    else console.log("retry outcome:", (retry as RetryResult)?.outcome, "error:", error);
    return new Response("ok (failure handled)", { status: 200 });
  };

  const checkpoint = async (output: Record<string, unknown>, costDelta: number): Promise<Response> => {
    const { data: cpRaw, error: checkpointErr } = await supabase.rpc("worker_checkpoint_step", {
      p_run_id: runId, p_step_id: stepId, p_expected_retry_count: expectedRetryCount,
      p_output: output, p_cost_delta: costDelta,
    });
    if (checkpointErr) {
      console.error("checkpoint rpc error", checkpointErr);
      return new Response("ok (checkpoint error logged)", { status: 200 });
    }
    const cp = cpRaw as CheckpointResult;
    console.log("checkpoint outcome:", cp?.outcome, cp?.reason ?? "");
    if (cp?.outcome === "checkpointed") {
      // the next step row's INSERT also dispatches; this re-invoke is redundant but harmless
      fetch(req.url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ runId }) })
        .catch((e) => console.error("self re-invoke failed", e));
    }
    return new Response(JSON.stringify({ outcome: cp?.outcome }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // --- 2. Step context (fenced) ------------------------------------------------
  const { data: ctxRaw, error: ctxErr } = await supabase.rpc("worker_get_step_context", {
    p_run_id: runId, p_step_id: stepId, p_expected_retry_count: expectedRetryCount,
  });
  if (ctxErr) {
    console.error("context rpc error", ctxErr);
    return await failStep("context_unavailable:rpc_error");
  }
  const ctx = ctxRaw as StepContext;
  if (ctx?.outcome !== "ok") return await failStep(`context_unavailable:${(ctx as { reason?: string })?.reason ?? "unknown"}`);

  // --- 3a. STUB path (every non-demo run) ----------------------------------------
  if ((ctx as { mode?: string }).mode === "stub") {
    if (Date.now() - startedAt > WORKER_INTERNAL_BUDGET_MS) return await failStep("internal_budget_exceeded");
    return await checkpoint({ stub: true, stepIndex, note: "mocked provider response, Phase 3.2 stub" }, 0);
  }

  // --- 3b. DEMO path: real provider call ------------------------------------------
  if (!isDemoContext(ctx)) return await failStep("context_malformed");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return await failStep("provider_unconfigured");

  const userMessage = buildUserMessage(ctx.input_text, ctx.previous_output_text);
  const inRate = ctx.price.input_inr_per_mtok, outRate = ctx.price.output_inr_per_mtok;

  let worst: number;
  try { worst = worstCaseCostInr(ctx.system, userMessage, ctx.max_output_tokens, inRate, outRate); }
  catch { return await failStep("context_malformed"); }
  if (worst > ctx.budget_remaining_inr) return await failStep("preflight_budget_exceeded"); // nothing was sent

  const remainingMs = WORKER_INTERNAL_BUDGET_MS - (Date.now() - startedAt);
  const timeoutMs = Math.min(ctx.timeout_seconds * 1000, remainingMs);
  if (timeoutMs <= 0) return await failStep("internal_budget_exceeded");

  const idemKey = idempotencyKey(runId, stepIndex, expectedRetryCount);
  const t0 = Date.now();
  const result = await callAnthropic(apiKey, ctx, userMessage, idemKey, timeoutMs);
  console.log("provider call:", result.ok ? "ok" : result.error, `${Date.now() - t0}ms`);
  if (!result.ok) return await failStep(result.error);

  // actual cost from reported usage; if usage is missing, charge the pre-flight worst case (never under-count)
  let cost: number;
  try { cost = result.usage ? costInr(result.usage.input, result.usage.output, inRate, outRate) : worst; }
  catch { cost = worst; }

  return await checkpoint({
    mode: "demo",
    text: result.text,
    model: ctx.model,
    stop_reason: result.stopReason,
    usage: result.usage ? { input_tokens: result.usage.input, output_tokens: result.usage.output } : null,
    idempotency_key: idemKey,
  }, cost);
});
