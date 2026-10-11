// lib/execution/route-handlers.js
//
// Framework-free. No `next/server`, no `@/` aliases, nothing that only
// resolves inside Next.js's own bundler -- deliberately, so this file can
// be imported directly by a plain `node` script (tests/phase3/
// l3-route-handlers.test.mjs) with zero module-resolution issues. The
// three app/api/runs/**/route.js files import these and wrap them with
// real Next.js glue (createClient, getVerifiedUser, NextResponse); this
// file is the actual logic under test.

export const ERROR_STATUS = {
  CM010: 503, // execution_disabled (flag off)
  CM011: 404, // product_not_found
  CM012: 400, // product_not_executable
  CM013: 403, // not_entitled
  CM014: 403, // product_not_live
  CM015: 429, // daily_run_quota_exceeded
};

export async function startRunHandler({ supabase, user, body }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in to start a run." } };
  }

  const { productId, input, isSandbox } = body || {};
  if (!productId || typeof productId !== "string") {
    return { status: 400, json: { error: "productId is required." } };
  }

  const { data, error } = await supabase.rpc("start_run", {
    p_product_id: productId,
    p_input: input ?? {},
    p_is_sandbox: Boolean(isSandbox),
  });

  if (error) {
    const status = ERROR_STATUS[error.code] ?? 500;
    return { status, json: { error: error.message } };
  }

  return { status: 201, json: { runId: data } };
}

export async function getRunHandler({ supabase, user, runId }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in." } };
  }

  const { error: recoverErr } = await supabase.rpc("worker_recover_stale_run", { p_run_id: runId });
  if (recoverErr) {
    console.error("recover_stale_run rpc error", recoverErr);
  }

  const { data: run, error } = await supabase.from("runs").select("*").eq("id", runId).maybeSingle();
  if (error || !run) {
    return { status: 404, json: { error: "Run not found." } };
  }

  return { status: 200, json: { run } };
}

export async function cancelRunHandler({ supabase, user, runId }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in to cancel a run." } };
  }

  const { data, error } = await supabase.rpc("cancel_my_run", { p_run_id: runId });

  if (error) {
    return { status: 404, json: { error: "Run not found." } };
  }

  return { status: 200, json: { outcome: data?.outcome ?? "cancelled" } };
}
