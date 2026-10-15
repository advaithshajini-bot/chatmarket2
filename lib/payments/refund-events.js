// lib/payments/refund-events.js -- normalise a Razorpay refund entity (API response OR webhook).
export const REFUND_EVENT_RE = /^refund\.[a-z_]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {null | {id, paymentId, amountPaise, status, purchaseId}} */
export function normalizeRefundEntity(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || !/^rfnd_[A-Za-z0-9]{6,40}$/.test(e.id)) return null;
  if (!Number.isInteger(e.amount) || e.amount <= 0) return null;
  if (e.currency !== undefined && e.currency !== "INR") return null;
  const status = e.status === "created" ? "pending" : e.status;
  if (!["pending", "processed", "failed"].includes(status)) return null;
  const paymentId = typeof e.payment_id === "string" && e.payment_id.length > 0 && e.payment_id.length <= 100 ? e.payment_id : null;
  const pid = e.notes && typeof e.notes === "object" ? e.notes.purchase_id : null;
  return { id: e.id, paymentId, amountPaise: e.amount, status, purchaseId: typeof pid === "string" && UUID_RE.test(pid) ? pid.toLowerCase() : null };
}

export function extractRefundEvent(body) {
  const r = normalizeRefundEntity(body?.payload?.refund?.entity);
  if (!r) return null;
  const at = body?.created_at;
  return { ...r, eventAt: Number.isInteger(at) && at > 0 ? at : null };
}
