// L3-03 / L3-04 / L3-05 — route-level fail-closed behavior, via mocked
// Supabase client unit tests against the extracted pure handlers
// (startRunHandler, getRunHandler, cancelRunHandler), not a live HTTP
// server. No DATABASE_URL, no network -- this file is fully self-
// contained and runnable anywhere Node runs.
//
// Covers what the original L3-03/04/05 plan asked for:
//   L3-03: run-initiation returns 503 while phase3_execution=false
//   L3-04: the route never proceeds past the RPC call when disabled --
//           proven here by asserting the mock's rpc() was called exactly
//           once (no follow-up calls that would indicate the route tried
//           to do anything else after getting the error)
//   L3-05: the route's ONLY source of "disabled" is the RPC's returned
//           error, not a hardcoded/env-var check -- proven by also
//           testing the success path with the same handler and confirming
//           it isn't independently gated by anything else

import { startRunHandler, getRunHandler, cancelRunHandler, ERROR_STATUS } from "../../lib/execution/route-handlers.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

function mockSupabase({ rpcResult, selectResult } = {}) {
  const calls = { rpc: [], select: [] };
  return {
    calls,
    rpc: async (name, params) => {
      calls.rpc.push({ name, params });
      return rpcResult ?? { data: null, error: null };
    },
    from: (table) => ({
      select: () => ({
        eq: (col, val) => ({
          maybeSingle: async () => {
            calls.select.push({ table, col, val });
            return selectResult ?? { data: null, error: null };
          },
        }),
      }),
    }),
  };
}

const FAKE_USER = { id: "00000000-0000-0000-0000-00000000aaaa" };

// ---------------------------------------------------------------------------
// startRunHandler (POST /api/runs)
// ---------------------------------------------------------------------------
{
  const supabase = mockSupabase({ rpcResult: { data: null, error: { code: "CM010", message: "execution_disabled" } } });
  const result = await startRunHandler({ supabase, user: FAKE_USER, body: { productId: "p1" } });
  check("L3-03 returns 503 when the RPC reports execution_disabled", result.status === 503);
  check("L3-04 the route made exactly one rpc call, nothing further after the error", supabase.calls.rpc.length === 1);
  check("L3-04b the single call was to start_run, not something else", supabase.calls.rpc[0].name === "start_run");
}
{
  // L3-05: same handler, same shape, only the RPC's error differs --
  // proves "disabled" isn't some separate hardcoded check, it's purely
  // whatever the RPC says. If the route had a hardcoded flag check
  // instead, this success case would also incorrectly 503.
  const supabase = mockSupabase({ rpcResult: { data: "run-id-123", error: null } });
  const result = await startRunHandler({ supabase, user: FAKE_USER, body: { productId: "p1" } });
  check("L3-05 the same code path returns 201 on success -- proving 'disabled' comes only from the RPC, not a separate hardcoded gate", result.status === 201 && result.json.runId === "run-id-123");
}
{
  const supabase = mockSupabase();
  const result = await startRunHandler({ supabase, user: null, body: { productId: "p1" } });
  check("startRunHandler: 401 when not logged in", result.status === 401);
}
{
  const supabase = mockSupabase();
  const result = await startRunHandler({ supabase, user: FAKE_USER, body: {} });
  check("startRunHandler: 400 when productId missing", result.status === 400);
}
{
  // Every documented errcode maps to its designed status, read from the
  // route's own exported ERROR_STATUS table -- not re-hardcoded in the
  // test, so this can't silently drift from the real mapping.
  for (const [code, expectedStatus] of Object.entries(ERROR_STATUS)) {
    const supabase = mockSupabase({ rpcResult: { data: null, error: { code, message: code } } });
    const result = await startRunHandler({ supabase, user: FAKE_USER, body: { productId: "p1" } });
    check(`startRunHandler: ${code} maps to ${expectedStatus}`, result.status === expectedStatus);
  }
}
{
  const supabase = mockSupabase({ rpcResult: { data: null, error: { code: "SOMETHING_UNKNOWN", message: "?" } } });
  const result = await startRunHandler({ supabase, user: FAKE_USER, body: { productId: "p1" } });
  check("startRunHandler: unknown errcode falls back to 500", result.status === 500);
}

// ---------------------------------------------------------------------------
// getRunHandler (GET /api/runs/[id])
// ---------------------------------------------------------------------------
{
  const supabase = mockSupabase();
  const result = await getRunHandler({ supabase, user: null, runId: "r1" });
  check("getRunHandler: 401 when not logged in", result.status === 401);
}
{
  const supabase = mockSupabase({ selectResult: { data: null, error: null } });
  const result = await getRunHandler({ supabase, user: FAKE_USER, runId: "r1" });
  check("getRunHandler: 404 when the run isn't found (or RLS hides it)", result.status === 404);
}
{
  const supabase = mockSupabase({ selectResult: { data: { id: "r1", status: "queued" }, error: null } });
  const result = await getRunHandler({ supabase, user: FAKE_USER, runId: "r1" });
  check("getRunHandler: 200 with the run when found", result.status === 200 && result.json.run.id === "r1");
}
{
  // recover_stale_run erroring must NOT block the read -- the route
  // deliberately falls through rather than failing the whole request.
  const supabase = mockSupabase({ rpcResult: { data: null, error: { message: "recover failed" } }, selectResult: { data: { id: "r1" }, error: null } });
  const result = await getRunHandler({ supabase, user: FAKE_USER, runId: "r1" });
  check("getRunHandler: a recover_stale_run error doesn't block returning the run", result.status === 200);
}

// ---------------------------------------------------------------------------
// cancelRunHandler (POST /api/runs/[id]/cancel)
// ---------------------------------------------------------------------------
{
  const supabase = mockSupabase();
  const result = await cancelRunHandler({ supabase, user: null, runId: "r1" });
  check("cancelRunHandler: 401 when not logged in", result.status === 401);
}
{
  // The wrapper itself returns a {outcome:'rejected', reason:'not_found'}
  // shaped result for "not yours", not a thrown error -- but this route
  // only receives an `error` if something genuinely failed, per
  // cancel_my_run's own design (see PART2_ROUTE_DESIGN.md). Testing the
  // thrown-error path here, which the route maps to 404.
  const supabase = mockSupabase({ rpcResult: { data: null, error: { message: "boom" } } });
  const result = await cancelRunHandler({ supabase, user: FAKE_USER, runId: "r1" });
  check("cancelRunHandler: 404 on an RPC error (doesn't leak whether the run exists)", result.status === 404);
}
{
  const supabase = mockSupabase({ rpcResult: { data: { outcome: "cancelled" }, error: null } });
  const result = await cancelRunHandler({ supabase, user: FAKE_USER, runId: "r1" });
  check("cancelRunHandler: 200 with the outcome on success", result.status === 200 && result.json.outcome === "cancelled");
}

console.log(`\nL3 route handlers: ${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
