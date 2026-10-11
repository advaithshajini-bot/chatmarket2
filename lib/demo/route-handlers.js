// lib/demo/route-handlers.js
//
// Framework-free (no next/server, no @/ aliases) so plain `node` tests can import it, exactly like
// lib/execution/route-handlers.js. app/api/demo/runs/route.js is the thin Next.js glue.
//
// Starts a "try before you buy" demo run via public.start_demo_run. Polling the run afterwards uses the
// EXISTING GET /api/runs/[id] (the demo user is the run's creator). Demo runs never expose the seller's
// prompt: runs.execution_config is prompt-free by construction (see migration 20260930100500).

export const DEMO_ERROR_STATUS = {
  "28000": 401, // not_authenticated
  CM010: 503,   // execution_disabled
  CM011: 404,   // product_not_found
  CM012: 400,   // product_not_executable
  CM014: 403,   // product_not_live
  CM030: 503,   // demo_disabled (flag off)
  CM031: 404,   // demo_not_available (no / disabled / unapproved demo)
  CM032: 400,   // invalid_demo_input
  CM033: 429,   // demo_daily_limit
  CM034: 503,   // demo_budget_exhausted (platform budget: try again tomorrow)
  CM036: 503,   // demo_setting_missing (misconfiguration; fail closed)
};

import { classifyDemoFailure } from "./failure.js";

export const DEMO_MAX_INPUT_CHARS = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_STEP_TEXT_CHARS = 20_000;

export async function startDemoRunHandler({ supabase, user, body }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in to try a demo." } };
  }
  const { listingId, text } = body || {};
  if (!listingId || typeof listingId !== "string") {
    return { status: 400, json: { error: "listingId is required." } };
  }
  if (typeof text !== "string" || text.trim() === "" || [...text].length > DEMO_MAX_INPUT_CHARS) {
    return { status: 400, json: { error: `text is required (max ${DEMO_MAX_INPUT_CHARS} characters).` } };
  }

  const { data, error } = await supabase.rpc("start_demo_run", {
    p_listing_id: listingId,
    p_input: { text },
  });
  if (error) {
    const status = DEMO_ERROR_STATUS[error.code] ?? 500;
    // `reason` is the DB's machine string (e.g. demo_daily_limit); the UI maps it to copy (lib/demo/failure.js)
    return status === 500
      ? { status, json: { error: "Could not start the demo." } }
      : { status, json: { error: error.message, reason: error.message } };
  }
  return { status: 201, json: { runId: data } };
}

// ---------------------------------------------------------------- polling endpoint
// GET /api/demo/runs/[id] -> { run: { id, status, done, failure, costInr, steps:[{index,status,text}], result } }
// A SANITISED view of one demo run for the page that started it. It exists (instead of reusing GET
// /api/runs/[id]) because that endpoint returns no steps and select("*") on runs; this one returns only what
// the demo widget draws, never execution_config, never the raw error string, and 404s for non-demo runs.
// It does the same recovery-on-read as the Phase 3 endpoint, so a dead worker is recovered by the poll.

export function toPublicDemoRun(run, steps) {
  const status = run.status;
  const done = TERMINAL.has(status);
  const publicSteps = (steps || []).map((s) => ({
    index: s.step_index,
    status: s.status,
    text: s.status === "succeeded" && typeof s.output?.text === "string" ? s.output.text.slice(0, MAX_STEP_TEXT_CHARS) : null,
  }));
  let failure = null;
  if (status === "failed") failure = classifyDemoFailure(run.error);
  else if (status === "cancelled") failure = "cancelled";
  else if (status === "timed_out") failure = "slow";
  const last = [...publicSteps].reverse().find((s) => s.status === "succeeded" && s.text !== null);
  return {
    id: run.id,
    status,
    done,
    failure,
    costInr: Math.round(Number(run.cost ?? 0) * 10000) / 10000,
    steps: publicSteps,
    result: status === "succeeded" && last ? last.text : null,
  };
}

export async function getDemoRunHandler({ supabase, user, runId }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in." } };
  }
  if (typeof runId !== "string" || !UUID_RE.test(runId)) {
    return { status: 404, json: { error: "Run not found." } };
  }

  const { error: recoverErr } = await supabase.rpc("worker_recover_stale_run", { p_run_id: runId });
  if (recoverErr) console.error("recover_stale_run rpc error", recoverErr);

  const { data: run, error } = await supabase
    .from("runs")
    .select("id, status, error, cost, is_demo")
    .eq("id", runId)
    .maybeSingle();
  if (error) return { status: 500, json: { error: "Could not load the demo run." } };
  if (!run || !run.is_demo) return { status: 404, json: { error: "Run not found." } };

  const { data: steps, error: stepsErr } = await supabase
    .from("run_steps")
    .select("step_index, status, output")
    .eq("run_id", runId)
    .order("step_index", { ascending: true });
  if (stepsErr) console.error("run_steps read error", stepsErr);

  return { status: 200, json: { run: toPublicDemoRun(run, stepsErr ? [] : steps) } };
}
