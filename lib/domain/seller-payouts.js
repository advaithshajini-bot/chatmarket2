// lib/domain/seller-payouts.js -- Milestone 5.3 part 2: the seller's own payout status, in plain English.
// 5.4: payouts are instant UPI sends; there is no hold and no clawback, so nothing here is ever a negative amount.
// The data comes from public.seller_payout_status(), which returns status CODES, integer paise and a release date -- never ids,
// errors or internal notes. This file only turns those codes into words; it never receives anything sensitive to leak.

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

export const STATUS_CODES = ["needs_account", "account_pending", "queued", "processing", "held", "dispute", "releasing", "paid", "reversed", "under_review", "instant_paid", "instant_in_progress", "action_needed"];

// -> { label, detail, tone }  tone: green | amber | red | grey
export function describeStatus(item) {
  switch (item?.status) {
    case "paid":
      return { label: "Paid", detail: "This sale has been paid out to your account.", tone: "green" };
    // 5.4: instant UPI payouts. All sales are final: nothing here ever turns into a debt or a deduction.
    case "instant_paid":
      return { label: "Instant payout: Paid", detail: "Sent to your UPI ID.", tone: "green" };
    case "instant_in_progress":
      return { label: "Instant payout: In progress", detail: "Your payout is on its way to your UPI ID.", tone: "amber" };
    case "action_needed":
      return { label: "Action needed: check your UPI ID", detail: "We couldn't send this payout. Check that your UPI ID is saved and correct, and our team will retry it.", tone: "red" };
    case "held":
      return { label: item.release_date ? `Held until ${fmtDate(item.release_date)}` : "Held", detail: "Payouts are held for 48 hours after a sale so buyers can raise an issue.", tone: "amber" };
    case "dispute":
      return { label: "On hold: dispute raised", detail: "The buyer raised an issue. Your payout is on hold until it is resolved.", tone: "amber" };
    case "releasing":
      return { label: "On its way", detail: "The hold has ended and the payout is being released to your account.", tone: "amber" };
    case "processing":
      return { label: "Processing", detail: "Your payout is being prepared.", tone: "amber" };
    case "queued":
      return { label: "Payout not started", detail: "Your payout account is ready. This sale will be paid out once payouts are switched on.", tone: "grey" };
    case "reversed":
      return { label: "Refunded", detail: "This sale was refunded to the buyer, so no payout is due.", tone: "red" };
    case "needs_account":
      return { label: "Action needed: link your payout account", detail: "We can't pay you until a payout account is linked.", tone: "red" };
    case "account_pending":
      return { label: "Payout account being set up", detail: "Your payout account isn't active yet. We'll pay this sale out once it is.", tone: "amber" };
    case "under_review":
      return { label: "Being reviewed by our team", detail: "We're looking at this payout. You don't need to do anything.", tone: "amber" };
    default:
      return { label: "Status unavailable", detail: "", tone: "grey" };
  }
}

export function describeAccount(accountStatus) {
  switch (accountStatus) {
    case "active": return { label: "UPI ID saved", tone: "green", needsAction: false };
    case "pending": return { label: "Payout setup in progress", tone: "amber", needsAction: false };
    case "suspended": return { label: "Payouts paused — contact support", tone: "red", needsAction: true };
    default: return { label: "No UPI ID saved", tone: "red", needsAction: true };
  }
}

export async function getSellerPayoutStatus(supabase) {
  const empty = { account_status: "none", summary: { held_paise: 0, releasing_paise: 0, paid_paise: 0, reversed_paise: 0, waiting_paise: 0, in_progress_paise: 0, action_needed_paise: 0 }, items: [], error: true };
  try {
    const { data, error } = await supabase.rpc("seller_payout_status", { p_limit: 100 });
    if (error || !data || !Array.isArray(data.items)) return empty;
    return data;
  } catch {
    return empty;
  }
}
