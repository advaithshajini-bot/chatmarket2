// lib/domain/runs.js
//
// Execution records (public.runs, public.run_steps). Read paths only in
// Phase 1 -- there is deliberately no createRun()/advanceRun() here.
// Creating a run requires the execution engine (Phase 3) to first
// validate entitlement, usage limits, and configuration; building a
// client-callable create path now, without the engine behind it, would
// let a client create 'queued' runs nothing will ever process. There is
// also no RLS INSERT policy on `runs` yet for exactly this reason -- a
// call to createRun() here would fail today regardless.

export async function getRun(supabase, runId) {
  const { data, error } = await supabase
    .from("runs")
    .select(
      "id, user_id, product_id, product_version, status, is_sandbox, input, output, error, cost, started_at, completed_at, created_at"
    )
    .eq("id", runId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listMyRuns(supabase, { limit = 50 } = {}) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("runs")
    .select("id, product_id, status, is_sandbox, cost, started_at, completed_at, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/**
 * Runs of a given product -- visible to that product's creator (via
 * private.owns_product) and to admins, per RLS. Anyone else's call
 * returns an empty array, not an error.
 */
export async function listProductRuns(supabase, productId, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("runs")
    .select("id, user_id, status, is_sandbox, cost, started_at, completed_at, created_at")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function listRunSteps(supabase, runId) {
  const { data, error } = await supabase
    .from("run_steps")
    .select("id, step_index, tool_id, status, input, output, error, started_at, completed_at")
    .eq("run_id", runId)
    .order("step_index", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
