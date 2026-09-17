// lib/domain/payouts.js
//
// Real creator payout ledger (public.payouts). Read-only in Phase 1 -- no
// money moves through this table yet; rows will only ever be written by
// trusted server-side code (Route webhook handling, a later phase), never
// by a client, so there is no createPayout() here.

export async function listMyPayouts(supabase, { limit = 50 } = {}) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("payouts")
    .select("id, amount, currency, status, related_purchase_id, related_run_id, created_at, paid_at")
    .eq("creator_id", user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
