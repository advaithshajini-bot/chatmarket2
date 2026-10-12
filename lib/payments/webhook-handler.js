// lib/payments/webhook-handler.js -- framework-free Razorpay webhook handler.
//
//   status 200  -> done (processed, ignored, duplicate, or needs a human: retrying will not help)
//   status 400  -> bad signature / unreadable body / missing event id (do not retry)
//   status 413  -> body too large
//   status 500  -> transient (config or database); Razorpay will retry and begin_webhook_event() lets it through
//
// We never log or store the payload: only ids and its SHA-256.
import { verifyWebhookSignature, sha256Hex } from "./webhook-signature.js";

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

export async function handleRazorpayWebhook({ rawBody, headers, secret, feePct, db }) {
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
  const rawPaymentId = str(body?.payload?.payment?.entity?.id), rawOrderId = str(body?.payload?.payment?.entity?.order_id);

  try {
    const begun = await db.beginEvent({ eventId, eventType, orderId: payment?.orderId ?? rawOrderId, paymentId: payment?.paymentId ?? rawPaymentId, sha256: sha256Hex(rawBody) });
    if (begun === "duplicate") return { status: 200, json: { ok: true, duplicate: true } };

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
    return { status: 200, json: { ok: true, outcome: result?.outcome ?? null } };
  } catch {
    return { status: 500, json: { error: "temporary failure" } };
  }
}
