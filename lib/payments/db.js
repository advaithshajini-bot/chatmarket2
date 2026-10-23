// lib/payments/db.js -- thin wrapper over the four service_role-only RPCs (migration 20261012100000).
// Every method throws on a transport/DB error so callers can decide retry-vs-not; business outcomes are RETURNED.
function unwrap({ data, error }) {
  if (error) { const e = new Error(error.message || "rpc_error"); e.code = error.code; throw e; }
  return data;
}

export function createPaymentsDb(client) {
  return {
    recordPaymentOrder: async ({ orderId, userId, listingId, amountPaise }) =>
      unwrap(await client.rpc("record_payment_order", {
        p_order_id: orderId, p_user_id: userId, p_listing_id: listingId, p_amount_paise: amountPaise,
      })),
    beginEvent: async ({ eventId, eventType, orderId, paymentId, sha256 }) =>
      unwrap(await client.rpc("begin_webhook_event", {
        p_event_id: eventId, p_event_type: eventType, p_order_id: orderId ?? null, p_payment_id: paymentId ?? null, p_sha256: sha256,
      })),
    finishEvent: async ({ eventId, status, outcome, error }) =>
      unwrap(await client.rpc("finish_webhook_event", {
        p_event_id: eventId, p_status: status, p_outcome: outcome ?? null, p_error: error ?? null,
      })),
    fulfil: async ({ orderId, paymentId, amountPaise, currency, method, signature, feePct, expectedUserId, eventId }) =>
      unwrap(await client.rpc("fulfil_captured_payment", {
        p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: amountPaise ?? null, p_currency: currency ?? "INR",
        p_method: method ?? null, p_signature: signature ?? null, p_fee_pct: feePct,
        p_expected_user_id: expectedUserId ?? null, p_event_id: eventId ?? null,
      })),
    listDisputeWork: async ({ limit }) => unwrap(await client.rpc("list_dispute_work", { p_limit: limit ?? 20 })),
    planRefund: async ({ purchaseId }) => unwrap(await client.rpc("plan_refund", { p_purchase_id: purchaseId })),
    applyRefundEvent: async ({ refundId, purchaseId, status, amountPaise, paymentId, eventAt, eventId }) =>
      unwrap(await client.rpc("apply_refund_event", {
        p_refund_id: refundId, p_purchase_id: purchaseId ?? null, p_status: status, p_amount_paise: amountPaise ?? null,
        p_payment_id: paymentId ?? null, p_event_at: eventAt ?? null, p_event_id: eventId ?? null,
      })),
    recordRefundFailure: async ({ purchaseId, error, retryable }) =>
      unwrap(await client.rpc("record_refund_failure", { p_purchase_id: purchaseId, p_error: error ?? null, p_retryable: !!retryable })),
  };
}
