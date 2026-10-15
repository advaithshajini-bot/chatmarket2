// lib/payments/dispute-sync-handler.js -- "a dispute just changed, act on it now" (framework-free).
// The caller supplies NOTHING that influences the outcome: the purchase id only selects which dispute to look at, and what
// is done is derived from the database. So any signed-in party may trigger it; it can only ever do what is already due.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleDisputeSync({ userId, purchaseId, canSeeDispute, sync }) {
  if (!userId) return { status: 401, json: { error: "login required" } };
  if (typeof purchaseId !== "string" || !UUID_RE.test(purchaseId)) return { status: 400, json: { error: "invalid purchase" } };
  let visible = false;
  try { visible = await canSeeDispute(purchaseId); } catch { return { status: 500, json: { error: "temporary failure" } }; }
  if (!visible) return { status: 404, json: { error: "not found" } };
  try { await sync(purchaseId); } catch { /* the sweep will finish it */ }
  return { status: 200, json: { ok: true } };
}
