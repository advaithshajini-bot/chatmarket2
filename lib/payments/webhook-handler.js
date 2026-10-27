// lib/payments/webhook-handler.js -- framework-free Razorpay webhook handler.
//
//   status 200  -> done (processed, ignored, duplicate, or needs a human: retrying will not help)
//   status 400  -> bad signature / unreadable body / missing event id (do not retry)
//   status 413  -> body too large
//   status 500  -> transient (config or database); Razorpay will retry and begin_webhook_event() lets it through
//
// We never log or store the payload: only ids and its SHA-256.
import { verifyWebhookSignature, sha256Hex } from "./webhook-signature.js";
import { REFUND_EVENT_RE, extractRefundEvent } from "./refund-events.js";
import { routeStatusForAccountEvent, ACCOUNT_ID_RE } from "../domain/route.js";

export const MAX_BODY_BYTES = 512 * 1024;
export const HANDLED_EVENTS = ["payment.captured", "order.paid"];

const str = (v, max = 100) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** Route: a transfer.processed event. Carries the payment id (source) and the linked account, not the order id. */
export function extractTransfer(body) {
  const t = body?.payload?.transfer?.entity;
  if (!t || typeof t !== "object") return null;
  const id = str(t.id), source = str(t.source), recipient = str(t.recipient);
  if (!id || !source || !source.startsWith("pay_") || !recipient || !ACCOUNT_ID_RE.test(recipient)) return null;
  if (!Number.isInteger(t.amount) || t.amount <= 0 || t.currency !== "INR") return null;
  if (t.status !== undefined && t.status !== "processed") return null;
  return { transferId: id, paymentId: source, accountId: recipient, transferPaise: t.amount, currency: t.currency };
}

/** Route: account.* status events. */
export function extractAccountEvent(eventType, body) {
  const routeStatus = routeStatusForAccountEvent(eventType);
  const id = str(body?.payload?.account?.entity?.id);
  if (!routeStatus || !id || !ACCOUNT_ID_RE.test(id)) return null;
  return { accountId: id, routeStatus };
}

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

// afterFulfil({ purchaseId }) is an optional best-effort hook (no production caller since the Route transfers were retired). It runs only after a
// successful fulfilment, can never change the answer sent to Razorpay, and its errors are swallowed.
export async function handleRazorpayWebhook({ rawBody, headers, secret, feePct, db, afterFulfil, rzp }) {
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

  const payment = HANDLED_EVENTS.includes(eventType) ? extractPayment(body) : null;
  const isRefund = REFUND_EVENT_RE.test(eventType);
  const refund = isRefund ? extractRefundEvent(body) : null;
  const rawPaymentId = str(body?.payload?.payment?.entity?.id) ?? (isRefund ? str(body?.payload?.refund?.entity?.payment_id) : null);
  const rawOrderId = str(body?.payload?.payment?.entity?.order_id);

  try {
    const begun = await db.beginEvent({ eventId, eventType, orderId: payment?.orderId ?? rawOrderId, paymentId: payment?.paymentId ?? rawPaymentId, sha256: sha256Hex(rawBody) });
    if (begun === "duplicate") return { status: 200, json: { ok: true, duplicate: true } };

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

    // ---- Route: linked-account status
    if (/^account\./.test(eventType)) {
      const ev = extractAccountEvent(eventType, body);
      if (!ev) { await db.finishEvent({ eventId, status: "ignored", outcome: "unhandled_event" }); return { status: 200, json: { ok: true, ignored: true } }; }
      let upd;
      try { upd = await db.routeUpdateAccount({ accountId: ev.accountId, routeStatus: ev.routeStatus, note: null }); }
      catch (e) {
        try { await db.finishEvent({ eventId, status: "failed", outcome: "route_account_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
        throw e;
      }
      await db.finishEvent({ eventId, status: upd?.outcome === "unknown_account" ? "ignored" : "processed", outcome: `route_account_${upd?.outcome ?? "unknown"}` });
      return { status: 200, json: { ok: true, outcome: `route_account_${upd?.outcome ?? "unknown"}` } };
    }

    // ---- Route: transfer.processed -> the same idempotent fulfilment, recorded as payment_method 'route' with platform_fee 0
    if (eventType === "transfer.processed") {
      const tr = extractTransfer(body);
      if (!tr || !rzp) {
        await db.finishEvent({ eventId, status: "needs_review", outcome: tr ? "route_lookup_unavailable" : "malformed_payload" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      let pay;
      try { pay = await rzp.fetchPayment(tr.paymentId); }
      catch { pay = { ok: false, retryable: true }; }
      if (!pay.ok) {
        if (pay.retryable) throw new Error("payment_lookup_failed");        // 500 -> Razorpay retries later
        await db.finishEvent({ eventId, status: "needs_review", outcome: "payment_lookup_failed" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      if (pay.payment.status !== "captured" || pay.payment.currency !== "INR") {
        await db.finishEvent({ eventId, status: "needs_review", outcome: "payment_not_captured" });
        return { status: 200, json: { ok: true, needsReview: true } };
      }
      let result;
      try {
        result = await db.fulfilRouteTransfer({
          orderId: pay.payment.orderId, paymentId: pay.payment.id, accountId: tr.accountId, transferPaise: tr.transferPaise,
          amountPaise: pay.payment.amountPaise, currency: pay.payment.currency, eventId,
        });
      } catch (e) {
        try { await db.finishEvent({ eventId, status: "failed", outcome: "fulfil_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }
        throw e;
      }
      if (typeof afterFulfil === "function" && (result?.outcome === "fulfilled" || result?.outcome === "already_fulfilled") && result?.purchase_id) {
        try { await afterFulfil({ purchaseId: result.purchase_id }); } catch { /* never affects the webhook answer */ }
      }
      return { status: 200, json: { ok: true, outcome: result?.outcome ?? null } };
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
