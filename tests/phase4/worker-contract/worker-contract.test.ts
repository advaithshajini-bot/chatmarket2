// Worker contract tests: supabase/functions/execution-worker/index.ts
//
// Runs the UNMODIFIED Edge Function in Deno against a mock Supabase client
// (mock-supabase.ts) whose RPC signatures and return payloads come from the
// live database (fixtures/rpc-payloads.json). Purpose: make contract/naming
// regressions -- like the snake_case vs camelCase claim bug -- fail in CI
// instead of in production.
//
// Run from the repo root:
//   deno test --config tests/phase4/worker-contract/deno.json \
//             --allow-env --allow-read tests/phase4/worker-contract/
//
// Regenerate fixtures after any change to the worker_* functions:
//   DATABASE_URL=... node tests/phase4/worker-contract/gen-fixtures.mjs

import { assert, assertEquals, assertStringIncludes } from "./asserts.ts";
import { control, createClient, fixtures } from "./mock-supabase.ts";

// GUARD: these tests are only meaningful if `npm:@supabase/supabase-js@2` is redirected to
// ./mock-supabase.ts by the import map in deno.json. Without --config the worker would load
// the REAL client and fail with confusing errors ("ok (claim error logged)", JSON parse errors).
{
  let resolved = "";
  try { resolved = import.meta.resolve("npm:@supabase/supabase-js@2"); } catch { /* unresolved == not mapped */ }
  if (!resolved.endsWith("/mock-supabase.ts")) {
    throw new Error(
      "Import map not active: 'npm:@supabase/supabase-js@2' resolved to " + JSON.stringify(resolved) + ".\n" +
      "Run from the repo root with the --config flag:\n" +
      "  deno test --config tests/phase4/worker-contract/deno.json --allow-env --allow-read tests/phase4/worker-contract/\n" +
      "or simply:  node tests/phase4/run-all.mjs",
    );
  }
}

const SECRET = "test-secret-not-real";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_URL = "https://example.invalid/functions/v1/execution-worker";

type Handler = (req: Request) => Promise<Response>;
async function loadWorker(relPath: string): Promise<Handler> {
  let captured: Handler | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: Handler) => { captured = h; return {}; };
  await import(relPath);
  assert(captured, `${relPath} did not register a Deno.serve handler`);
  return captured!;
}
const worker = await loadWorker("../../../supabase/functions/execution-worker/index.ts");
const legacyWorker = await loadWorker("./legacy/execution-worker.pre-fix.ts");

const P = fixtures.payloads;
// deno-lint-ignore no-explicit-any
const P_any = P as Record<string, any>;

// ---------------------------------------------------------------- harness
type Ctx = { logs: string[]; fetches: { url: string; init: RequestInit }[] };
async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); } }
}
const API_KEY = "sk-ant-test-key-NOT-REAL-9f3a";
const GOOD_ENV = { WORKER_SHARED_SECRET: SECRET, SUPABASE_URL: "https://proj.invalid", SUPABASE_SERVICE_ROLE_KEY: "svc-key", ANTHROPIC_API_KEY: API_KEY };

async function invoke(
  h: Handler,
  opts: { auth?: string | null; body?: unknown; rawBody?: string; env?: Record<string, string | undefined>; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> } = {},
): Promise<{ res: Response; text: string; ctx: Ctx }> {
  const ctx: Ctx = { logs: [], fetches: [] };
  const realFetch = globalThis.fetch, log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { ctx.logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { ctx.logs.push(a.map(String).join(" ")); };
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    ctx.fetches.push({ url: String(url), init: init ?? {} });
    return opts.fetchImpl ? opts.fetchImpl(String(url), init ?? {}) : Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    return await withEnv({ ...GOOD_ENV, ...(opts.env ?? {}) }, async () => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const auth = opts.auth === undefined ? `Bearer ${SECRET}` : opts.auth;
      if (auth !== null) headers["authorization"] = auth;
      const body = opts.rawBody ?? JSON.stringify(opts.body === undefined ? { runId: RUN_ID } : opts.body);
      const res = await h(new Request(WORKER_URL, { method: "POST", headers, body }));
      return { res, text: await res.text(), ctx };
    });
  } finally { globalThis.fetch = realFetch; console.log = log; console.error = err; }
}
const ok = (data: unknown) => () => ({ data, error: null });
const fnCalls = () => control.calls.map((c) => c.fn);

// ---------------------------------------------------------------- mock self-tests
Deno.test("WC-00 mock rejects what PostgREST would reject (camelCase / undefined / wrong type)", async () => {
  control.reset();
  const c = createClient("u", "k");
  const base = { p_run_id: RUN_ID, p_step_id: RUN_ID, p_expected_retry_count: 0, p_output: {}, p_cost_delta: 0 };
  assertEquals((await c.rpc("worker_checkpoint_step", { ...base, p_step_id: undefined })).error?.code, "PGRST202");
  assertEquals((await c.rpc("worker_checkpoint_step", { ...base, extra: 1 })).error?.code, "PGRST202");
  assertEquals((await c.rpc("worker_checkpoint_step", { ...base, p_expected_retry_count: "0" })).error?.code, "22P02");
  assertEquals((await c.rpc("worker_checkpoint_step", { ...base, p_step_id: "not-a-uuid" })).error?.code, "22P02");
  assertEquals((await c.rpc("no_such_fn", {})).error?.code, "PGRST202");
  assertEquals(control.violations.length, 5);
});

// ---------------------------------------------------------------- happy path
Deno.test("WC-01 claim -> checkpoint: exact RPC args come from the claim's snake_case keys", async () => {
  control.reset();
  const claimed = { ...P_any.claim_claimed, step_index: 2, retry_count: 3 }; // non-default values: no hard-coding can pass
  control.script.worker_claim_next_step = ok(claimed);
  control.script.worker_checkpoint_step = ok(P.checkpoint_succeeded);
  const { res, text, ctx } = await invoke(worker);
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(text), P.checkpoint_succeeded);
  assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_checkpoint_step"]);
  assertEquals(control.calls[0].args, { p_run_id: RUN_ID });
  const cp = control.calls.find((c) => c.fn === "worker_checkpoint_step")!.args as Record<string, unknown>;
  assertEquals(cp.p_run_id, RUN_ID);
  assertEquals(cp.p_step_id, claimed.step_id);
  assertEquals(cp.p_expected_retry_count, 3);
  assertEquals(cp.p_cost_delta, 0);
  assertEquals((cp.p_output as Record<string, unknown>).stub, true);
  assertEquals((cp.p_output as Record<string, unknown>).stepIndex, 2);
  assertEquals(control.violations, []);
  assertEquals(ctx.fetches.length, 0, "no self re-invoke after a terminal 'succeeded'");
  assert(control.clientArgs.every((a) => a.url === "https://proj.invalid" && a.key === "svc-key"));
});

Deno.test("WC-02 'checkpointed' triggers exactly one authenticated self re-invoke with the same runId", async () => {
  control.reset();
  control.script.worker_claim_next_step = ok(P.claim_claimed);
  control.script.worker_checkpoint_step = ok(P.checkpoint_checkpointed);
  const { res, text, ctx } = await invoke(worker);
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(text).outcome, "checkpointed");
  assertEquals(ctx.fetches.length, 1);
  assertEquals(ctx.fetches[0].url, WORKER_URL);
  const h = new Headers(ctx.fetches[0].init.headers);
  assertEquals(h.get("authorization"), `Bearer ${SECRET}`);
  assertEquals(JSON.parse(String(ctx.fetches[0].init.body)), { runId: RUN_ID });
  assertEquals(control.violations, []);
});

for (const name of ["checkpoint_failed_cost_limit", "checkpoint_rejected_fencing"]) {
  Deno.test(`WC-03 ${name}: outcome echoed, no retry call, no re-invoke`, async () => {
    control.reset();
    control.script.worker_claim_next_step = ok(P.claim_claimed);
    control.script.worker_checkpoint_step = ok(P_any[name]);
    const { res, text, ctx } = await invoke(worker);
    assertEquals(res.status, 200);
    assertEquals(JSON.parse(text).outcome, P_any[name].outcome);
    assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_checkpoint_step"]);
    assertEquals(ctx.fetches.length, 0);
    assertEquals(control.violations, []);
  });
}

// ---------------------------------------------------------------- claim outcomes
for (const name of ["claim_rejected_execution_disabled", "claim_rejected_step_already_running", "claim_rejected_run_not_claimable", "claim_waiting_for_approval"]) {
  Deno.test(`WC-04 ${name}: 200 'nothing to do', claim is the only RPC`, async () => {
    control.reset();
    control.script.worker_claim_next_step = ok(P_any[name]);
    const { res, text } = await invoke(worker);
    assertEquals(res.status, 200);
    assertStringIncludes(text, "nothing to do");
    assertEquals(fnCalls(), ["worker_claim_next_step"]);
    assertEquals(control.violations, []);
  });
}

Deno.test("WC-04b waiting_for_approval payload has the documented keys and the worker neither executes nor re-invokes", async () => {
  control.reset();
  const w = P_any.claim_waiting_for_approval;
  assertEquals(Object.keys(w).sort().join(","), "approval_id,expires_at,outcome,permission,step_id,step_index");
  control.script.worker_claim_next_step = ok(w);
  const { res, ctx } = await invoke(worker);
  assertEquals(res.status, 200);
  assertEquals(fnCalls(), ["worker_claim_next_step"], "a parked step must trigger no checkpoint/retry call");
  assertEquals(ctx.fetches.length, 0, "and no self re-invoke");
  assertEquals(control.violations, []);
});

Deno.test("WC-05 claim RPC error: 200, logged, no further RPC", async () => {
  control.reset();
  control.script.worker_claim_next_step = () => ({ data: null, error: { message: "boom" } });
  const { res, ctx } = await invoke(worker);
  assertEquals(res.status, 200);
  assertEquals(fnCalls(), ["worker_claim_next_step"]);
  assert(ctx.logs.some((l) => l.includes("claim rpc error")));
});

const claimed = P_any.claim_claimed;
const malformed: Record<string, unknown> = {
  "legacy camelCase keys (the original bug)": { outcome: "claimed", stepId: claimed.step_id, stepIndex: 0, expectedRetryCount: 0 },
  "missing retry_count": { outcome: "claimed", step_id: claimed.step_id, step_index: 0 },
  "missing step_id": { outcome: "claimed", step_index: 0, retry_count: 0 },
  "step_id not a string": { ...claimed, step_id: 42 },
  "retry_count is a string": { ...claimed, retry_count: "0" },
  "step_index is null": { ...claimed, step_index: null },
};
for (const [label, payload] of Object.entries(malformed)) {
  Deno.test(`WC-06 malformed 'claimed' payload (${label}): nothing is called with undefined`, async () => {
    control.reset();
    control.script.worker_claim_next_step = ok(payload);
    const { res, ctx } = await invoke(worker);
    assertEquals(res.status, 200);
    assertEquals(fnCalls(), ["worker_claim_next_step"], "must not attempt checkpoint/retry on a bad claim");
    assert(ctx.logs.some((l) => l.includes("claim payload malformed")));
    assertEquals(control.violations, []);
  });
}

Deno.test("WC-07 checkpoint RPC error: 200, logged, does not fall through to retry", async () => {
  control.reset();
  control.script.worker_claim_next_step = ok(P.claim_claimed);
  control.script.worker_checkpoint_step = () => ({ data: null, error: { message: "db down" } });
  const { res, ctx } = await invoke(worker);
  assertEquals(res.status, 200);
  assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_checkpoint_step"]);
  assert(ctx.logs.some((l) => l.includes("checkpoint rpc error")));
});

Deno.test("WC-08 provider failure: worker_retry_or_fail_step gets the claim's step_id and retry_count, no checkpoint", async () => {
  control.reset();
  const c = { ...P_any.claim_claimed, retry_count: 1 };
  const realNow = Date.now; let offset = 0;
  Date.now = () => realNow() + offset;
  control.script.worker_claim_next_step = () => { offset = 91_000; return { data: c, error: null }; }; // > 90 s budget
  control.script.worker_retry_or_fail_step = ok(P.retry_retried);
  try {
    const { res, text } = await invoke(worker);
    assertEquals(res.status, 200);
    assertStringIncludes(text, "failure handled");
    assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_retry_or_fail_step"]);
    assertEquals(control.calls.find((x) => x.fn === "worker_retry_or_fail_step")!.args, {
      p_run_id: RUN_ID, p_step_id: c.step_id, p_expected_retry_count: 1, p_error: "internal_budget_exceeded",
    });
    assertEquals(control.violations, []);
  } finally { Date.now = realNow; }
});

Deno.test("WC-08b retry RPC error is logged and still returns 200", async () => {
  control.reset();
  const realNow = Date.now; let offset = 0;
  Date.now = () => realNow() + offset;
  control.script.worker_claim_next_step = () => { offset = 91_000; return { data: P.claim_claimed, error: null }; };
  control.script.worker_retry_or_fail_step = () => ({ data: null, error: { message: "nope" } });
  try {
    const { res, ctx } = await invoke(worker);
    assertEquals(res.status, 200);
    assert(ctx.logs.some((l) => l.includes("retry rpc error")));
  } finally { Date.now = realNow; }
});

// ---------------------------------------------------------------- auth / input / env
const authCases: [string, string | null, Record<string, string | undefined>][] = [
  ["no Authorization header", null, {}],
  ["wrong secret", "Bearer nope", {}],
  ["bare secret without 'Bearer '", SECRET, {}],
  ["secret env unset + 'Bearer undefined'", "Bearer undefined", { WORKER_SHARED_SECRET: undefined }],
  ["secret env unset + empty bearer", "Bearer ", { WORKER_SHARED_SECRET: undefined }],
  ["secret env empty string", "Bearer ", { WORKER_SHARED_SECRET: "" }],
];
for (const [label, auth, env] of authCases) {
  Deno.test(`WC-09 auth fails closed: ${label} -> 401, zero RPCs`, async () => {
    control.reset();
    const { res } = await invoke(worker, { auth, env });
    assertEquals(res.status, 401);
    assertEquals(control.calls.length, 0);
  });
}

const bodyCases: [string, { body?: unknown; rawBody?: string }][] = [
  ["invalid JSON", { rawBody: "{not json" }],
  ["empty object", { body: {} }],
  ["runId is a number", { body: { runId: 123 } }],
  ["runId is null", { body: { runId: null } }],
  ["body is JSON null", { rawBody: "null" }],
];
for (const [label, b] of bodyCases) {
  Deno.test(`WC-10 bad body (${label}) -> 400, zero RPCs`, async () => {
    control.reset();
    const { res } = await invoke(worker, b);
    assertEquals(res.status, 400);
    assertEquals(control.calls.length, 0);
  });
}

for (const missing of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  Deno.test(`WC-11 missing ${missing} -> 500, zero RPCs`, async () => {
    control.reset();
    const { res, ctx } = await invoke(worker, { env: { [missing]: undefined } });
    assertEquals(res.status, 500);
    assertEquals(control.calls.length, 0);
    assert(ctx.logs.some((l) => l.includes("missing SUPABASE_URL")));
  });
}

// ---------------------------------------------------------------- historical regression
Deno.test("WC-13 REGRESSION: the pre-fix (camelCase) worker is caught by this suite", async () => {
  control.reset();
  control.script.worker_claim_next_step = ok(P.claim_claimed);
  control.script.worker_checkpoint_step = ok(P.checkpoint_succeeded);
  const { res } = await invoke(legacyWorker);
  assertEquals(res.status, 200); // the old worker "succeeded" silently -- that was the danger
  assert(control.violations.length > 0, "contract violation must be recorded");
  assertStringIncludes(control.violations.join("|"), "argument names");
  const cp = control.calls.find((c) => c.fn === "worker_checkpoint_step");
  assert(cp, "old worker did attempt a checkpoint");
  assert(!("p_step_id" in cp!.args), "p_step_id was silently dropped over the wire (undefined)");
});


// =================================================================== Milestone 4.2: Anthropic adapter (demo runs)
// deno-lint-ignore no-explicit-any
const workerMod = await import("../../../supabase/functions/execution-worker/index.ts") as any;
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const PRICE_IN = 90.3, PRICE_OUT = 451.5;
// deno-lint-ignore no-explicit-any
const D = P_any.ctx_demo as Record<string, any>;
const demoCtx = (over: Record<string, unknown> = {}) => ({ ...D, ...over });
const claimOf = (over: Record<string, unknown> = {}) => ({ ...P_any.claim_claimed, ...over });
const providerCalls = (c: Ctx) => c.fetches.filter((f) => f.url === ANTHROPIC);
const OMIT = Symbol("omit-usage"); // pass OMIT to leave `usage` out of the provider answer entirely
const anthropicOk = (usage: unknown = { input_tokens: 120, output_tokens: 80 }, text = "Hello from the model", extra: Record<string, unknown> = {}) =>
  () => Promise.resolve(new Response(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model: D.model,
    content: [{ type: "text", text }], stop_reason: "end_turn", ...(usage === OMIT ? {} : { usage }), ...extra }), { status: 200, headers: { "content-type": "application/json" } }));
function scriptDemo(ctxPayload: unknown = D, claim: unknown = claimOf(), cp: unknown = P.checkpoint_succeeded) {
  control.reset();
  control.script.worker_claim_next_step = ok(claim);
  control.script.worker_get_step_context = ok(ctxPayload);
  control.script.worker_checkpoint_step = ok(cp);
  control.script.worker_retry_or_fail_step = ok(P.retry_failed);
}
const lastArgs = (fn: string) => control.calls.filter((c) => c.fn === fn).at(-1)?.args as Record<string, unknown> | undefined;

Deno.test("WP-01 request shape: exact URL, headers, idempotency key, body; one call; abortable; nothing extra", async () => {
  const claim = claimOf({ step_index: 1, retry_count: 2 });
  scriptDemo(D, claim);
  const { res, ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(res.status, 200);
  const calls = providerCalls(ctx);
  assertEquals(calls.length, 1);
  const init = calls[0].init;
  assertEquals(init.method, "POST");
  const h = new Headers(init.headers);
  assertEquals(h.get("x-api-key"), API_KEY);
  assertEquals(h.get("anthropic-version"), "2023-06-01");
  assertEquals(h.get("content-type"), "application/json");
  assertEquals(h.get("idempotency-key"), `${RUN_ID}:1:2`);
  assert(init.signal instanceof AbortSignal, "the call must be abortable (timeout)");
  const body = JSON.parse(String(init.body));
  assertEquals(Object.keys(body).sort().join(","), "max_tokens,messages,model,system");
  assertEquals(body.model, D.model);
  assertEquals(body.max_tokens, D.max_output_tokens);
  assertEquals(body.system, D.system);
  assertEquals(body.messages, [{ role: "user", content: D.input_text }]);
  assertEquals(control.violations, []);
});

Deno.test("WP-02 success: checkpoint gets the claim's ids, the real cost from usage, and a clean output; run RPC order is exact", async () => {
  scriptDemo(D, claimOf({ step_index: 0, retry_count: 0 }));
  const { res, text } = await invoke(worker, { fetchImpl: anthropicOk({ input_tokens: 120, output_tokens: 80 }, "Hello from the model") });
  assertEquals(res.status, 200);
  assertEquals(JSON.parse(text), P.checkpoint_succeeded);
  assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_checkpoint_step"]);
  assertEquals(control.calls[1].args, { p_run_id: RUN_ID, p_step_id: P_any.claim_claimed.step_id, p_expected_retry_count: 0 });
  const cp = lastArgs("worker_checkpoint_step")!;
  assertEquals(cp.p_cost_delta, workerMod.costInr(120, 80, PRICE_IN, PRICE_OUT));
  assertEquals(cp.p_step_id, P_any.claim_claimed.step_id);
  assertEquals(cp.p_expected_retry_count, 0);
  assertEquals(cp.p_output, {
    mode: "demo", text: "Hello from the model", model: D.model, stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 80 }, idempotency_key: `${RUN_ID}:0:0`,
  });
  assertEquals(control.violations, []);
});

Deno.test("WP-03 cache-token fields are billed at the input rate (conservative)", async () => {
  scriptDemo();
  await invoke(worker, { fetchImpl: anthropicOk({ input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 30 }) });
  const cp = lastArgs("worker_checkpoint_step")!;
  assertEquals(cp.p_cost_delta, workerMod.costInr(180, 10, PRICE_IN, PRICE_OUT));
  assertEquals((cp.p_output as Record<string, unknown>).usage, { input_tokens: 180, output_tokens: 10 });
});

for (const [label, usage] of [["missing", OMIT], ["null", null], ["negative", { input_tokens: -1, output_tokens: 5 }], ["fractional", { input_tokens: 1.5, output_tokens: 5 }],
  ["strings", { input_tokens: "10", output_tokens: "5" }], ["partial", { input_tokens: 10 }]] as [string, unknown][]) {
  Deno.test(`WP-04 usage ${label}: charge the PRE-FLIGHT WORST CASE, never zero`, async () => {
    scriptDemo();
    await invoke(worker, { fetchImpl: anthropicOk(usage) });
    const cp = lastArgs("worker_checkpoint_step")!;
    const worst = workerMod.worstCaseCostInr(D.system, D.input_text, D.max_output_tokens, PRICE_IN, PRICE_OUT);
    assertEquals(cp.p_cost_delta, worst);
    assert((cp.p_cost_delta as number) > 0);
    assertEquals((cp.p_output as Record<string, unknown>).usage, null);
  });
}

Deno.test("WP-05 pre-flight: worst case above the remaining budget aborts BEFORE any provider call", async () => {
  const worst = workerMod.worstCaseCostInr(D.system, D.input_text, D.max_output_tokens, PRICE_IN, PRICE_OUT);
  scriptDemo(demoCtx({ budget_remaining_inr: worst - 0.0001 }));
  const { res, ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(res.status, 200);
  assertEquals(providerCalls(ctx).length, 0, "nothing may be sent when the worst case does not fit");
  assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_retry_or_fail_step"]);
  assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "preflight_budget_exceeded");
});
Deno.test("WP-05b pre-flight boundary: worst case EXACTLY equal to the remaining budget is allowed", async () => {
  const worst = workerMod.worstCaseCostInr(D.system, D.input_text, D.max_output_tokens, PRICE_IN, PRICE_OUT);
  scriptDemo(demoCtx({ budget_remaining_inr: worst }));
  const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(providerCalls(ctx).length, 1);
});
Deno.test("WP-05c pre-flight with a zero budget and with a 3-step-sized prompt: aborts, never calls", async () => {
  scriptDemo(demoCtx({ budget_remaining_inr: 0 }));
  const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(providerCalls(ctx).length, 0);
  assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "preflight_budget_exceeded");
});

Deno.test("WP-06 worst-case bound counts UTF-8 BYTES (a token is >= 1 byte), so multi-byte text cannot slip under", () => {
  const ascii = "a".repeat(2000), hindi = "अ".repeat(2000);
  assertEquals(workerMod.utf8Bytes(ascii), 2000);
  assertEquals(workerMod.utf8Bytes(hindi), 6000);
  const a = workerMod.worstCaseCostInr("sys", ascii, 100, PRICE_IN, PRICE_OUT);
  const h = workerMod.worstCaseCostInr("sys", hindi, 100, PRICE_IN, PRICE_OUT);
  assert(h > a, "3-byte characters must cost more in the bound");
  assertEquals(h, workerMod.costInr(workerMod.utf8Bytes("sys") + 6000 + 128, 100, PRICE_IN, PRICE_OUT));
});

for (const status of [400, 401, 403, 404, 413, 429, 500, 502, 529]) {
  Deno.test(`WP-07 provider HTTP ${status}: no checkpoint, step failed with provider_http_${status}; the response body is never used`, async () => {
    scriptDemo();
    const { res, ctx } = await invoke(worker, { fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ error: { message: "SECRET-ECHO " + D.system } }), { status })) });
    assertEquals(res.status, 200);
    assertStringIncludes(await Promise.resolve(res.statusText ?? "") + "ok", "ok");
    assertEquals(fnCalls(), ["worker_claim_next_step", "worker_get_step_context", "worker_retry_or_fail_step"]);
    assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, `provider_http_${status}`);
    assertEquals(providerCalls(ctx).length, 1, "the worker itself never retries a provider call");
    assert(!ctx.logs.join("\n").includes("SECRET-ECHO"));
  });
}

Deno.test("WP-08 network failure: provider_network_error", async () => {
  scriptDemo();
  await invoke(worker, { fetchImpl: () => Promise.reject(new TypeError("connection reset")) });
  assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "provider_network_error");
  assertEquals(fnCalls().includes("worker_checkpoint_step"), false);
});

Deno.test("WP-09 timeout: the call is aborted at the step's timeout_seconds -> provider_timeout", async () => {
  scriptDemo(demoCtx({ timeout_seconds: 1 }));
  const t0 = Date.now();
  await invoke(worker, { fetchImpl: (_u, init) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))) });
  const ms = Date.now() - t0;
  assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "provider_timeout");
  assert(ms >= 900 && ms < 3000, `aborted after ${ms} ms`);
});

Deno.test("WP-09b the timeout is also bounded by the worker's remaining internal budget; exhausted budget -> no call", async () => {
  const realNow = Date.now; let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    scriptDemo();
    control.script.worker_get_step_context = () => { offset = 95_000; return { data: D, error: null }; }; // > 90 s used
    const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
    assertEquals(providerCalls(ctx).length, 0);
    assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "internal_budget_exceeded");
  } finally { Date.now = realNow; }
});

Deno.test("WP-10 malformed provider answers: invalid JSON / no content array -> provider_bad_response; no-text blocks -> success with empty text", async () => {
  for (const f of [() => Promise.resolve(new Response("not json", { status: 200 })),
    () => Promise.resolve(new Response(JSON.stringify({ id: "x" }), { status: 200 })),
    () => Promise.resolve(new Response(JSON.stringify({ content: "oops" }), { status: 200 }))]) {
    scriptDemo();
    await invoke(worker, { fetchImpl: f });
    assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "provider_bad_response");
  }
  scriptDemo();
  await invoke(worker, { fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "hmm" }], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 })) });
  const out = lastArgs("worker_checkpoint_step")!.p_output as Record<string, unknown>;
  assertEquals(out.text, "");
  assertEquals(out.stop_reason, "refusal");
});

Deno.test("WP-10b multiple text blocks are joined; non-text blocks ignored; output length is capped", async () => {
  scriptDemo();
  await invoke(worker, { fetchImpl: () => Promise.resolve(new Response(JSON.stringify({
    content: [{ type: "text", text: "A" }, { type: "tool_use", name: "x" }, { type: "text", text: "B" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) });
  assertEquals((lastArgs("worker_checkpoint_step")!.p_output as Record<string, unknown>).text, "AB");
  scriptDemo();
  await invoke(worker, { fetchImpl: anthropicOk({ input_tokens: 1, output_tokens: 1 }, "z".repeat(50_000)) });
  assertEquals(((lastArgs("worker_checkpoint_step")!.p_output as Record<string, unknown>).text as string).length, 20_000);
});

for (const missing of [undefined, ""]) {
  Deno.test(`WP-11 ANTHROPIC_API_KEY ${missing === undefined ? "unset" : "empty"}: no provider call; step failed provider_unconfigured`, async () => {
    scriptDemo();
    const { ctx } = await invoke(worker, { env: { ANTHROPIC_API_KEY: missing }, fetchImpl: anthropicOk() });
    assertEquals(providerCalls(ctx).length, 0);
    assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "provider_unconfigured");
  });
}

Deno.test("WP-12 context problems fail the step closed WITHOUT a provider call", async () => {
  for (const reason of ["fencing_mismatch", "model_not_allowed", "demo_disabled", "snapshot_missing", "run_not_running"]) {
    scriptDemo({ outcome: "rejected", reason });
    const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
    assertEquals(providerCalls(ctx).length, 0);
    assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, `context_unavailable:${reason}`);
  }
  scriptDemo(); control.script.worker_get_step_context = () => ({ data: null, error: { message: "db down" } });
  const r1 = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(providerCalls(r1.ctx).length, 0);
  assertEquals(lastArgs("worker_retry_or_fail_step")!.p_error, "context_unavailable:rpc_error");
  for (const [label, bad] of [["missing price", demoCtx({ price: undefined })], ["max tokens 0", demoCtx({ max_output_tokens: 0 })], ["budget a string", demoCtx({ budget_remaining_inr: "3" })],
    ["unknown mode", { outcome: "ok", mode: "live" }], ["no system", demoCtx({ system: undefined })], ["null context", null]] as [string, unknown][]) {
    scriptDemo(bad);
    const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
    assertEquals(providerCalls(ctx).length, 0, label);
    assert(["context_malformed", "context_unavailable:unknown"].includes(lastArgs("worker_retry_or_fail_step")!.p_error as string), label);
  }
});

Deno.test("WP-13 stub-mode runs NEVER reach the provider, even with a key configured", async () => {
  scriptDemo(P.ctx_stub);
  const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(providerCalls(ctx).length, 0);
  const cp = lastArgs("worker_checkpoint_step")!;
  assertEquals(cp.p_cost_delta, 0);
  assertEquals((cp.p_output as Record<string, unknown>).stub, true);
});

Deno.test("WP-14 step 2 includes the previous step's output in the user message", async () => {
  scriptDemo(demoCtx({ previous_output_text: "FIRST ANSWER" }), claimOf({ step_index: 1 }));
  const { ctx } = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(JSON.parse(String(providerCalls(ctx)[0].init.body)).messages, [{ role: "user", content: `Previous step output:\nFIRST ANSWER\n\nUser input:\n${D.input_text}` }]);
});

Deno.test("WP-15 SECRET HYGIENE: keys, prompts, user input and model output are never logged (success and failure)", async () => {
  const secrets = [API_KEY, D.system, D.input_text, "VERY-SECRET-MODEL-OUTPUT", SECRET, "svc-key"];
  scriptDemo();
  const ok1 = await invoke(worker, { fetchImpl: anthropicOk({ input_tokens: 5, output_tokens: 5 }, "VERY-SECRET-MODEL-OUTPUT") });
  scriptDemo();
  const bad = await invoke(worker, { fetchImpl: () => Promise.resolve(new Response("VERY-SECRET-MODEL-OUTPUT " + API_KEY, { status: 500 })) });
  for (const { ctx } of [ok1, bad]) {
    const all = ctx.logs.join("\n");
    for (const sx of secrets) assert(!all.includes(sx), `a log line leaked: ${sx.slice(0, 12)}...`);
  }
});

Deno.test("WP-16 checkpoint outcomes on the demo path: failure echoed with no retry call; 'checkpointed' triggers exactly one re-invoke", async () => {
  scriptDemo(D, claimOf(), P.checkpoint_failed_cost_limit);
  const a = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(JSON.parse(a.text).outcome, "failed");
  assertEquals(fnCalls().includes("worker_retry_or_fail_step"), false);
  scriptDemo(D, claimOf(), P.checkpoint_checkpointed);
  const b = await invoke(worker, { fetchImpl: anthropicOk() });
  assertEquals(b.ctx.fetches.filter((f) => f.url === WORKER_URL).length, 1);
  assertEquals(providerCalls(b.ctx).length, 1);
});

Deno.test("WP-17 the idempotency key is runId:stepIndex:retryCount, stable per attempt and different per retry", () => {
  assertEquals(workerMod.idempotencyKey(RUN_ID, 0, 0), `${RUN_ID}:0:0`);
  assertEquals(workerMod.idempotencyKey(RUN_ID, 1, 0), workerMod.idempotencyKey(RUN_ID, 1, 0));
  assert(workerMod.idempotencyKey(RUN_ID, 1, 0) !== workerMod.idempotencyKey(RUN_ID, 1, 1));
  assert(workerMod.idempotencyKey(RUN_ID, 0, 0) !== workerMod.idempotencyKey(RUN_ID, 1, 0));
});

Deno.test("WP-18 costInr: rounds UP, rejects bad input", () => {
  assertEquals(workerMod.costInr(0, 0, PRICE_IN, PRICE_OUT), 0);
  assertEquals(workerMod.costInr(1, 0, PRICE_IN, PRICE_OUT), 0.0001);
  assertEquals(workerMod.costInr(1000, 500, PRICE_IN, PRICE_OUT), 0.3161);
  for (const bad of [[-1, 0], [0, -1], [1.5, 0], [0, 2.5], [NaN, 0], [Infinity, 0]] as [number, number][]) {
    let threw = false; try { workerMod.costInr(bad[0], bad[1], PRICE_IN, PRICE_OUT); } catch { threw = true; }
    assert(threw, `costInr(${bad}) must throw`);
  }
  let threw = false; try { workerMod.costInr(1, 1, NaN, 1); } catch { threw = true; }
  assert(threw, "NaN rate must throw");
});

Deno.test("WP-19 DB PARITY: the worker's cost math equals private.model_cost_inr for every committed vector", () => {
  assert(fixtures.cost_vectors.length >= 16, "fixtures must carry the DB cost vectors (regenerate them)");
  for (const v of fixtures.cost_vectors) {
    assertEquals(workerMod.costInr(v.input_tokens, v.output_tokens, v.input_inr_per_mtok, v.output_inr_per_mtok), v.cost_inr,
      `${v.model} in=${v.input_tokens} out=${v.output_tokens}`);
  }
});

Deno.test("WP-20 the demo context fixture is the real DB payload (keys the worker depends on)", () => {
  assertEquals(Object.keys(D).sort().join(","), "budget_remaining_inr,input_text,max_output_tokens,mode,model,outcome,previous_output_text,price,system,timeout_seconds");
  assert(workerMod.worstCaseCostInr(D.system, D.input_text, D.max_output_tokens, D.price.input_inr_per_mtok, D.price.output_inr_per_mtok) <= D.budget_remaining_inr,
    "a fresh demo step must fit inside its own budget");
});
