// lib/payments/transfer-events.js -- normalise a Razorpay transfer entity (from an API response OR a webhook).
// State is read from the entity itself, never from the event NAME, so it does not matter which transfer.* event
// Razorpay fires: the entity says what the transfer is now.
export const TRANSFER_EVENT_RE = /^transfer\.[a-z_]{1,40}$/;
export const TRANSFER_STATUSES = ["created", "pending", "processed", "partially_reversed", "reversed", "failed"];
const SETTLEMENT_STATUSES = ["pending", "on_hold", "settled"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns {null | {id, source, recipient, amountPaise, status, settlementStatus, onHold, amountReversedPaise, purchaseId}} */
export function normalizeTransferEntity(e) {
  if (!e || typeof e !== "object") return null;
  if (typeof e.id !== "string" || !/^trf_[A-Za-z0-9]{6,40}$/.test(e.id)) return null;
  if (!Number.isInteger(e.amount) || e.amount <= 0) return null;
  if (e.currency !== undefined && e.currency !== "INR") return null;
  const status = e.transfer_status ?? e.status;
  if (!TRANSFER_STATUSES.includes(status)) return null;
  const settlementStatus = e.settlement_status ?? null;
  if (settlementStatus !== null && !SETTLEMENT_STATUSES.includes(settlementStatus)) return null;
  const reversed = e.amount_reversed ?? 0;
  if (!Number.isInteger(reversed) || reversed < 0 || reversed > e.amount) return null;
  if (e.on_hold !== undefined && typeof e.on_hold !== "boolean") return null;
  const recipient = typeof e.recipient === "string" && /^acc_[A-Za-z0-9]{6,40}$/.test(e.recipient) ? e.recipient : null;
  const source = typeof e.source === "string" && e.source.length > 0 && e.source.length <= 100 ? e.source : null;
  const pid = e.notes && typeof e.notes === "object" ? e.notes.purchase_id : null;
  return {
    id: e.id, source, recipient, amountPaise: e.amount, status, settlementStatus,
    onHold: typeof e.on_hold === "boolean" ? e.on_hold : null, amountReversedPaise: reversed,
    purchaseId: typeof pid === "string" && UUID_RE.test(pid) ? pid.toLowerCase() : null,
  };
}

/** From a webhook body: the normalised entity plus the event's own timestamp (unix seconds), or null. */
export function extractTransferEvent(body) {
  const t = normalizeTransferEntity(body?.payload?.transfer?.entity);
  if (!t) return null;
  const at = body?.created_at;
  return { ...t, eventAt: Number.isInteger(at) && at > 0 ? at : null };
}
