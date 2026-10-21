// lib/domain/seller-settlement.js -- Milestone 5.5: the seller's own earnings under MONTHLY manual settlement, in plain English.
// Earnings are paid once a month, by hand, to the seller's saved UPI ID. All sales are final and a payout is never taken back,
// so nothing here is ever a negative amount.
// The data comes from public.seller_settlement_status(): status CODES, integer paise, a payout date and a bank reference per past payout --
// never ids of batches/items/sellers, errors or internal notes. This file only turns codes into words.

export const SETTLEMENT_CODES = ["unsettled", "in_batch", "settled", "needs_upi", "under_review", "refunded"];

// "2026-11-01" -> "1 Nov 2026" (pinned to UTC so the date never shifts with the viewer's time zone)
export function formatPayoutDate(isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(isoDate)) return "";
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// -> { label, detail, tone }  tone: green | amber | red | grey
export function describeSettlement(item) {
  switch (item?.status) {
    case "settled":
      return { label: "Paid", detail: "Sent to your UPI ID in a monthly payout.", tone: "green" };
    case "in_batch":
      return { label: "Being paid", detail: "This month's payout is being sent to your UPI ID.", tone: "amber" };
    case "unsettled":
      return { label: "Unsettled", detail: "Included in your next monthly payout.", tone: "grey" };
    case "needs_upi":
      return { label: "Action needed: add your UPI ID", detail: "We can't pay you until you save a UPI ID.", tone: "red" };
    case "under_review":
      return { label: "Being reviewed by our team", detail: "We're looking at your payouts. You don't need to do anything.", tone: "amber" };
    case "refunded":
      return { label: "Refunded", detail: "This sale was refunded to the buyer before it was paid out, so no payout is due.", tone: "grey" };
    default:
      return { label: "Status unavailable", detail: "", tone: "grey" };
  }
}

export function describeSettlementAccount(accountStatus) {
  switch (accountStatus) {
    case "active": return { label: "UPI ID saved", tone: "green", needsAction: false };
    case "pending": return { label: "Payout setup in progress", tone: "amber", needsAction: false };
    case "suspended": return { label: "Payouts paused — contact support", tone: "red", needsAction: true };
    default: return { label: "No UPI ID saved", tone: "red", needsAction: true };
  }
}

const EMPTY = {
  account_status: "none", upi_masked: null, next_payout_date: null,
  summary: { unsettled_paise: 0, in_batch_paise: 0, settled_paise: 0, refunded_paise: 0, action_needed_paise: 0 },
  items: [], payouts: [], error: true,
};

export async function getSellerSettlementStatus(supabase) {
  try {
    const { data, error } = await supabase.rpc("seller_settlement_status", { p_limit: 100 });
    if (error || !data || !Array.isArray(data.items) || !Array.isArray(data.payouts)) return EMPTY;
    return data;
  } catch {
    return EMPTY;
  }
}
