// lib/payments/webhook-handler.js -- framework-free Razorpay webhook handler.
//
//   status 200  -> done (processed, ignored, duplicate, or needs a human: retrying will not help)
//   status 400  -> bad signature / unreadable body / missing event id (do not retry)
//   status 413  -> body too large
//   status 500  -> transient (config or database); Razorpay will retry and begin_webhook_event() lets it through
//
// We never log or store the payload: only ids and its SHA-256.
import { verifyWebhookSignature, sha256Hex } from "./webhook-signature.js";
import { TRANSFER_EVENT_RE, extractTransferEvent } from "./transfer-events.js";
import { REFUND_EVENT_RE, extractRefundEvent } from "./refund-events.js";
import { PAYOUT_EVENT_RE, extractPayoutEvent } from "./payout-events.js";

export const MAX_BODY_BYTES = 512 * 1024;
export const HANDLED_EVENTS = ["payment.captured", "order.paid"];

const str = (v, max = 100) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** Pull the payment entity out of a Razorpay payload; null if it isn't a usable captured payment. */
export function extractPayment(body) {
  const p = body?.payload?.payment?.entity;
  if (!p || typeof p !== "object") return null;
  const id = str(p.id), orderId = str(p.order_id);
  if (!id || !orderId) return null;
  if (!Number.isInteger(p.amount) || p.amount <= 0) return null;
  if (p.currency !== "INR") return null;
  if (p.status !== "captured") return null;
  return { paymentId: id, orderId, amountPaise: p.amount, currency: p.currency, method: typeof p.method === "string" ? p.method : null };
}

// afterFulfil({ purchaseId }) is an optional best-effort hook (5.2: start the Route transfer). It runs only after a
// successful fulfilment, can never change the answer sent to Razorpay, and its errors are swallowed.
export async function handleRazorpayWebhook({ rawBody, headers, secret, feePct, db, afterFulfil }) {
  const h = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) ?? null;

  if (!secret) return { status: 500, json: { error: "webhook not configured" } };
  if (typeof rawBody !== "string" || rawBody.length === 0) return { status: 400, json: { error: "empty body" } };
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return { status: 413, json: { error: "body too large" } };

  if (!verifyWebhookSignature(rawBody, h("x-razorpay-signature"), secret)) return { status: 400, json: { error: "invalid signature" } };

  const eventId = str(h("x-razorpay-event-id"), 200);
  if (!eventId) return { status: 400, json: { error: "missing event id" } };

  let body;
  try { body = JSON.parse(rawBody); } catch { return { status: 400, json: { error: "invalid json" } }; }
  const eventType = str(body?.event);
  if (!eventType) return { status: 400, json: { error: "missing event type" } };

  const isTransfer = TRANSFER_EVENT_RE.test(eventType);
  const payment = HANDLED_EVENTS.includes(eventType) ? extractPayment(body) : null;
  const transfer = isTransfer ? extractTransferEvent(body) : null;
  const isRefund = REFUND_EVENT_RE.test(eventType);
  const refund = isRefund ? extractRefundEvent(body) : null;
  const isPayout = PAYOUT_EVENT_RE.test(eventType);
  const payout = isPayout ? extractPayoutEvent(body) : null;
  const rawPaymentId = str(body?.payload?.payment?.entity?.id) ?? (isTransfer ? str(body?.payload?.transfer?.entity?.source) : isRefund ? str(body?.payload?.refund?.entity?.payment_id) : null);
  const rawOrderId = str(body?.payload?.payment?.entity?.order_id);

  try {
    const begun = await db.beginEvent({ eventId, eventType, orderId: payment?.orderId ?? rawOrderId, paymentId: payment?.paymentId ?? rawPaymentId, sha256: sha256Hex(rawBody) });
    if (begun === "duplicate") return { status: 200, json: { ok: true, duplicate: true } };

    if (isTransfer) {
      if (!transfer) {
        await db.finishEvent({ eventId, status: "needs_review", outcome: "malformed_payload" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      let applied;
      try {
        applied = await db.applyTransferEvent({
          transferId: transfer.id, purchaseId: transfer.purchaseId, status: transfer.status, settlementStatus: transfer.settlementStatus,
          onHold: transfer.onHold, amountReversedPaise: transfer.amountReversedPaise, eventAt: transfer.eventAt,
          amountPaise: transfer.amountPaise, recipient: transfer.recipient, eventId,
        });
      } catch (e) {
        try { await db.finishEvent({ eventId, status: "failed", outcome: "transfer_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
        throw e;
      }
      return { status: 200, json: { ok: true, outcome: applied?.outcome ? `transfer_${applied.outcome}` : null } };
    }

    if (isPayout) {
      if (!payout) {
        await db.finishEvent({ eventId, status: "needs_review", outcome: "malformed_payload" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      let applied;
      try {
        applied = await db.applyVpaPayoutEvent({
          payoutId: payout.id, purchaseId: payout.purchaseId, status: payout.status, utr: payout.utr, eventAt: payout.eventAt,
          amountPaise: payout.amountPaise, reason: payout.reason, eventId,
        });
      } catch (e) {
        try { await db.finishEvent({ eventId, status: "failed", outcome: "payout_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
        throw e;
      }
      return { status: 200, json: { ok: true, outcome: applied?.outcome ? `payout_${applied.outcome}` : null } };
    }

    if (isRefund) {
      if (!refund) {
        await db.finishEvent({ eventId, status: "needs_review", outcome: "malformed_payload" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      let applied;
      try {
        applied = await db.applyRefundEvent({
          refundId: refund.id, purchaseId: refund.purchaseId, status: refund.status, amountPaise: refund.amountPaise,
          paymentId: refund.paymentId, eventAt: refund.eventAt, eventId,
        });
      } catch (e) {
        try { await db.finishEvent({ eventId, status: "failed", outcome: "refund_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
        throw e;
      }
      return { status: 200, json: { ok: true, outcome: applied?.outcome ? `refund_${applied.outcome}` : null } };
    }

    if (!HANDLED_EVENTS.includes(eventType)) {
      await db.finishEvent({ eventId, status: "ignored", outcome: "unhandled_event" });
      return { status: 200, json: { ok: true, ignored: true } };
    }
    if (!payment) {
      // a captured-payment event we cannot read: money may have moved, so make it visible rather than silent
      await db.finishEvent({ eventId, status: "needs_review", outcome: "malformed_payload" });
      return { status: 200, json: { ok: true, needsReview: true } };
    }

    let result;
    try {
      result = await db.fulfil({ ...payment, signature: null, feePct, expectedUserId: null, eventId });
    } catch (e) {
      try { await db.finishEvent({ eventId, status: "failed", outcome: "fulfil_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
      throw e;
    }
    if (typeof afterFulfil === "function" && (result?.outcome === "fulfilled" || result?.outcome === "already_fulfilled") && result?.purchase_id) {
      try { await afterFulfil({ purchaseId: result.purchase_id }); } catch { /* never affects the webhook answer */ }
    }
    return { status: 200, json: { ok: true, outcome: result?.outcome ?? null } };
  } catch {
    return { status: 500, json: { error: "temporary failure" } };
  }
}
