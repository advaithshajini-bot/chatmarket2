// supabase/functions/execution-worker/index.ts
//
// NOT DEPLOYED. This is a skeleton matching PART3_WORKER_PLAN.md, written
// so its shape can be reviewed before anything here is real. AI-provider
// calls are stubbed, per Gate 7's own instruction (Step 9: no real
// production execution). verify_jwt is set false at the function-config
// level (not shown here -- that's a `supabase functions deploy` flag /
// config.toml setting, not something this file controls) and this
// function checks its own bearer secret instead, matching the
// already-agreed "secret key" worker model from earlier in this project.
//
// Env vars this expects (none set anywhere yet -- listed for review):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   -- only usable because the 6 wrapper
//                                  functions from Part 2 grant EXECUTE to
//                                  service_role specifically for this
//   WORKER_SHARED_SECRET        -- the bearer secret this function checks
//                                  itself, since verify_jwt is off

import { createClient } from "npm:@supabase/supabase-js@2";

const WORKER_INTERNAL_BUDGET_MS = 90_000; // matches the 90s system ceiling, not the 150s platform limit

Deno.serve(async (req) => {
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${Deno.env.get("WORKER_SHARED_SECRET")}`) {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const { runId } = body ?? {};
  if (!runId) return new Response("runId required", { status: 400 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const startedAt = Date.now();

  const { data: claim, error: claimErr } = await supabase.rpc("worker_claim_next_step", { p_run_id: runId });
  if (claimErr) {
    console.error("claim rpc error", claimErr);
    return new Response("ok (claim error logged)", { status: 200 });
  }
  if (claim.outcome !== "claimed") {
    // rejected/failed -- nothing to do, not an error. See PART3_WORKER_PLAN.md step 2.
    console.log("claim outcome:", claim.outcome, claim.reason);
    return new Response("ok (nothing to do)", { status: 200 });
  }

  const { stepId, stepIndex, expectedRetryCount, input } = claim;

  let output, costDelta, providerError;
  try {
    // --- STUBBED. Never a real AI provider call in Gate 7 or this plan. ---
    // Real version: plain fetch() to the provider, per the earlier-agreed
    // Deno/Node-portable design. Left as a stub deliberately.
    if (Date.now() - startedAt > WORKER_INTERNAL_BUDGET_MS) {
      throw new Error("internal_budget_exceeded");
    }
    output = { stub: true, stepIndex, note: "mocked provider response, Gate 7 plan only" };
    costDelta = 0;
    // --- end stub ---
  } catch (e) {
    providerError = e.message ?? String(e);
  }

  if (providerError) {
    const { data: retry, error: retryErr } = await supabase.rpc("worker_retry_or_fail_step", {
      p_run_id: runId,
      p_step_id: stepId,
      p_expected_retry_count: expectedRetryCount,
      p_error: providerError,
    });
    if (retryErr) console.error("retry rpc error", retryErr);
    else console.log("retry outcome:", retry.outcome);
    return new Response("ok (failure handled)", { status: 200 });
  }

  const { data: checkpoint, error: checkpointErr } = await supabase.rpc("worker_checkpoint_step", {
    p_run_id: runId,
    p_step_id: stepId,
    p_expected_retry_count: expectedRetryCount,
    p_output: output,
    p_cost_delta: costDelta,
  });
  if (checkpointErr) {
    console.error("checkpoint rpc error", checkpointErr);
    return new Response("ok (checkpoint error logged)", { status: 200 });
  }

  if (checkpoint.outcome === "checkpointed") {
    // Fire-and-forget re-invocation for the next step -- keeps each
    // invocation short. Not awaited.
    fetch(req.url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ runId }),
    }).catch((e) => console.error("self re-invoke failed", e));
  }

  return new Response(JSON.stringify({ outcome: checkpoint.outcome }), { status: 200 });
});
