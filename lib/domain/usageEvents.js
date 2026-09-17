// lib/domain/usageEvents.js
//
// Billable usage ledger (public.usage_events, PRD S24). Read paths only
// -- nothing generates usage events yet (requires the execution engine,
// Phase 3) and no billing logic reads this table yet (Phase 7). Exists so
// future billing code has a stable place to read from rather than
// querying the table shape directly everywhere.

export async function listMyUsageEvents(supabase, { limit = 100 } = {}) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("usage_events")
    .select("id, product_id, run_id, metric, quantity, unit_price, currency, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function listProductUsageEvents(supabase, productId, { limit = 100 } = {}) {
  const { data, error } = await supabase
    .from("usage_events")
    .select("id, user_id, run_id, metric, quantity, unit_price, currency, created_at")
    .eq("product_id", productId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
