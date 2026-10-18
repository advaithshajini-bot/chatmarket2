// lib/domain/admin-payments.js -- Milestone 5.3: what the /admin/payments desk reads and shows. UX only: the real gate is
// private.is_admin_mfa() inside every admin_* reporting function (admin AND aal2). Read-only; money is integer paise.

export const ATTENTION_LABELS = {
  parked_transfer: "Transfer parked for review",
  transfer_failed: "Transfer failed",
  transfer_stuck: "Transfer stuck creating",
  refund_failed: "Refund failed",
  refund_stuck: "Refund not confirmed",
  dispute_hold_pending: "Dispute open, hold not applied",
  webhook_needs_review: "Payment event needs review",
  webhook_failed: "Payment event failed",
  // 5.4 instant UPI payouts
  payout_failed: "UPI payout failed",
  payout_parked: "UPI payout parked for review",
  payout_returned: "UPI payout returned by the bank",
  payout_stuck: "UPI payout not started",
  payout_queued: "UPI payout queued (check RazorpayX balance)",
  payout_slow: "UPI payout taking too long",
};

export const PAYOUT_FILTERS = ["all", "creating", "queued", "processing", "processed", "failed", "reversed", "cancelled"];
export const RETRYABLE_PAYOUT_STATUSES = ["failed", "cancelled", "reversed"];

export const BUCKET_LABELS = {
  held: "Held (dispute window)",
  releasing: "Releasing",
  settled: "Settled",
  reversed: "Reversed",
  failed: "Failed",
  parked: "Parked for review",
  creating: "Creating",
};

export const DISPUTE_FILTERS = ["all", "open", "resolved_refunded", "resolved_denied"];
export const LEDGER_FILTERS = ["all", "held", "releasing", "settled", "reversed", "failed", "parked", "creating"];

export { formatPaise } from "./paise.js";

export function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function rpc(supabase, fn, args, fallback) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error || data == null) return { ...fallback, error: true };
    return data;
  } catch {
    return { ...fallback, error: true };
  }
}

export const getAttention = (supabase) => rpc(supabase, "admin_payment_attention", { p_limit: 200 }, { total: 0, items: [] });
export const getLedger = (supabase, bucket = null, offset = 0) =>
  rpc(supabase, "admin_transfers_ledger", { p_bucket: bucket === "all" ? null : bucket, p_limit: 100, p_offset: offset }, { total: 0, items: [] });
export const getDisputes = (supabase, status = null, offset = 0) =>
  rpc(supabase, "admin_disputes_refunds", { p_status: status === "all" ? null : status, p_limit: 100, p_offset: offset }, { total: 0, items: [] });
export const getBalances = (supabase) => rpc(supabase, "admin_seller_balances", { p_limit: 200 }, { total: 0, items: [] });
export const getTimeline = (supabase, purchaseId) => rpc(supabase, "admin_purchase_timeline", { p_purchase_id: purchaseId }, { found: false });

// null when the caller is not a verified admin (the badge is simply not drawn)
export async function getAttentionCount(supabase) {
  try {
    const { data, error } = await supabase.rpc("admin_payment_attention_count");
    return error || !Number.isInteger(data) ? null : data;
  } catch {
    return null;
  }
}

export async function clearTransferReview(supabase, purchaseId) {
  const { error } = await supabase.rpc("admin_clear_transfer_review", { p_purchase_id: purchaseId });
  return error ? { error: error.message || "Could not clear the review." } : { ok: true };
}

export async function setSellerPayoutAccount(supabase, userId, accountId, status) {
  const { error } = await supabase.rpc("admin_set_seller_payout_account", { p_user_id: userId, p_account_id: accountId, p_status: status });
  return error ? { error: error.message || "Could not save the payout account." } : { ok: true };
}

// ---- 5.4: instant UPI payouts (admin + MFA RPCs)
export const getPayouts = (supabase, status = null, offset = 0) =>
  rpc(supabase, "admin_vpa_payouts_ledger", { p_status: status === "all" ? null : status, p_limit: 100, p_offset: offset }, { total: 0, items: [] });

/** Re-queue a FAILED / CANCELLED / RETURNED payout under a new idempotency key. Only after checking the RazorpayX dashboard that the money did not leave. */
export async function retryPayout(supabase, purchaseId) {
  const { error } = await supabase.rpc("admin_retry_vpa_payout", { p_purchase_id: purchaseId });
  return error ? { error: error.message || "Could not retry the payout." } : { ok: true };
}

export async function setSellerPayoutStatus(supabase, userId, status) {
  const { error } = await supabase.rpc("admin_set_seller_payout_status", { p_user_id: userId, p_status: status });
  return error ? { error: error.message || "Could not change the seller's payout status." } : { ok: true };
}
