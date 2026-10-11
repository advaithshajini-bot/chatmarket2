// lib/domain/admin-reviews.js -- what the Moderation Desk PAGE needs to decide what to render. UX only: the real
// gate is private.is_admin_mfa() inside every review RPC (admin AND aal2), which a hand-crafted request cannot skip.

export async function getAdminGate(supabase, user) {
  if (!user) return { allowed: false, isAdmin: false, aal: null };
  try {
    const [{ data: profile }, mfa] = await Promise.all([
      supabase.from("profiles").select("is_admin").eq("id", user.id).maybeSingle(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    const isAdmin = profile?.is_admin === true;
    const aal = mfa?.data?.currentLevel ?? null;
    return { allowed: isAdmin && aal === "aal2", isAdmin, aal, canEnrol: mfa?.data?.nextLevel === "aal2" };
  } catch {
    return { allowed: false, isAdmin: false, aal: null };
  }
}

export async function getReviewQueue(supabase) {
  try {
    const { data, error } = await supabase.rpc("admin_review_queue", { p_limit: 100 });
    if (error) return { demos: [], blueprints: [] };
    return { demos: Array.isArray(data?.demos) ? data.demos : [], blueprints: Array.isArray(data?.blueprints) ? data.blueprints : [] };
  } catch {
    return { demos: [], blueprints: [] };
  }
}
