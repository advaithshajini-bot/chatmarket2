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
  };
}
