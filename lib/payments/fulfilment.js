// lib/payments/fulfilment.js -- outcome vocabulary shared by the webhook and the browser verify path.
export const SUCCESS_OUTCOMES = ["fulfilled", "already_fulfilled"];
export const REVIEW_OUTCOMES = ["order_unknown", "order_user_mismatch", "amount_mismatch", "listing_unavailable", "duplicate_payment", "transfer_mismatch"];

export const isSuccess = (outcome) => SUCCESS_OUTCOMES.includes(outcome);

/** Buyer-facing result for /api/razorpay/verify-payment. Never leaks internals. */
export function verifyResponseFor(result) {
  const outcome = result?.outcome;
  if (isSuccess(outcome)) return { status: 200, json: { success: true, purchaseId: result.purchase_id } };
  if (outcome === "duplicate_payment") {
    // They already own it; the extra payment is flagged for a refund. Access is real, so this is a success.
    return { status: 200, json: { success: true, purchaseId: result.purchase_id, note: "You already owned this; the duplicate payment will be refunded." } };
  }
  if (outcome === "order_user_mismatch") return { status: 403, json: { error: "This payment belongs to a different account." } };
  if (outcome === "order_unknown") return { status: 404, json: { error: "We couldn't match this payment to an order. If you were charged, contact support with your payment id." } };
  if (outcome === "amount_mismatch" || outcome === "listing_unavailable" || outcome === "transfer_mismatch") {
    return { status: 409, json: { error: "We couldn't complete this purchase automatically. If you were charged, you'll be refunded or contacted — contact support with your payment id." } };
  }
  return { status: 500, json: { error: "Couldn't record the purchase." } };
}
