// lib/domain/entitlements.js
//
// Generalizes "does this user have access to this product" across
// purchase/subscription/usage-based access (public.entitlements). Read
// paths only in Phase 1 -- there is deliberately no createEntitlement()
// here yet. Granting an entitlement must happen through a checked,
// server-verified path (extending the existing Razorpay verify-payment
// flow, and later subscription webhooks), which is Phase 7 (billing), not
// Phase 1. Until then only the service role can write to this table, so a
// client-side call here would just fail RLS -- better not to offer the
// footgun at all.

export async function getMyEntitlement(supabase, productId) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("entitlements")
    .select("id, kind, status, current_period_end, source_purchase_id, created_at")
    .eq("product_id", productId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function listMyEntitlements(supabase) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("entitlements")
    .select("id, product_id, kind, status, current_period_end, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * True if the current user has an active entitlement to a product, in
 * whatever form (purchase, subscription, or usage access). Does NOT check
 * `purchases` directly -- once Phase 7 wires checkout to write
 * entitlements going forward (this migration already backfilled existing
 * paid purchases), this becomes the one place access-gating logic reads
 * from. Existing checkout/library access-gating code is untouched in
 * Phase 1 and continues to use `purchases` directly until that wiring
 * happens.
 */
export async function hasActiveEntitlement(supabase, productId) {
  const entitlement = await getMyEntitlement(supabase, productId);
  return entitlement?.status === "active";
}
