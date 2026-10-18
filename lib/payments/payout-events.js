// lib/payments/payout-events.js -- normalise a Razorpay (RazorpayX) payout entity (API response OR webhook).
// State is read from the entity, never from the event name. Shapes follow Razorpay's docs but are UNVERIFIED against a live account.
export const PAYOUT_EVENT_RE = /^payout\.[a-z_]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Razorpay status -> our ledger status. "pending" (awaiting approval) is treated as queued; "rejected" is a failure.
const STATUS_MAP = { queued: "queued", pending: "queued", processing: "processing", processed: "processed", rejected: "failed", failed: "failed", cancelled: "cancelled", reversed: "reversed" };

/** @returns {null | {id, amountPaise, status, utr, fundAccountId, purchaseId, reason}} */
export function normalizePayoutEntity(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || !/^pout_[A-Za-z0-9]{6,40}$/.test(e.id)) return null;
  if (!Number.isInteger(e.amount) || e.amount <= 0) return null;
  if (e.currency !== undefined && e.currency !== "INR") return null;
  const status = STATUS_MAP[e.status];
  if (!status) return null;
  const ref = typeof e.reference_id === "string" ? e.reference_id.slice(0, 36) : null;
  const reason = typeof e.status_details?.reason === "string" ? e.status_details.reason.slice(0, 200) : (typeof e.failure_reason === "string" ? e.failure_reason.slice(0, 200) : null);
  return {
    id: e.id, amountPaise: e.amount, status,
    utr: typeof e.utr === "string" && e.utr.length > 0 && e.utr.length <= 60 ? e.utr : null,
    fundAccountId: typeof e.fund_account_id === "string" && /^fa_[A-Za-z0-9]{6,40}$/.test(e.fund_account_id) ? e.fund_account_id : null,
    purchaseId: ref && UUID_RE.test(ref) ? ref.toLowerCase() : null,
    reason,
  };
}

export function extractPayoutEvent(body) {
  const p = normalizePayoutEntity(body?.payload?.payout?.entity);
  if (!p) return null;
  const at = body?.created_at;
  return { ...p, eventAt: Number.isInteger(at) && at > 0 ? at : null };
}
