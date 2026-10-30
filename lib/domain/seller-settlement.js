// lib/domain/seller-settlement.js -- Milestone 5.5: the seller's own earnings under MONTHLY manual settlement, in plain English.
// Earnings are paid once a month, by hand, to the seller's saved bank account. All sales are final and a payout is never taken back,
// so nothing here is ever a negative amount.
// The data comes from public.seller_settlement_status(): status CODES, integer paise, a payout date and a bank reference per past payout --
// never ids of batches/items/sellers, errors or internal notes. This file only turns codes into words.

export const SETTLEMENT_CODES = ["unsettled", "in_batch", "settled", "needs_bank", "under_review", "refunded", "bank_cooldown"];

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
      return { label: "Paid", detail: "Sent to your bank account in a monthly payout.", tone: "green" };
    case "in_batch":
      return { label: "Being paid", detail: "This month's payout is being sent to your bank account.", tone: "amber" };
    case "unsettled":
      return { label: "Unsettled", detail: "Included in your next monthly payout.", tone: "grey" };
    case "needs_bank":
      return { label: "Action needed: add your bank account", detail: "We can't pay you until you save your bank details.", tone: "red" };
    case "under_review":
      return { label: "Being reviewed by our team", detail: "We're looking at your payouts. You don't need to do anything.", tone: "amber" };
    case "bank_cooldown":
      return { label: "Waiting: bank account changed", detail: "You changed your bank account recently. This sale joins the next payout once the new account unlocks.", tone: "amber" };
    case "refunded":
      return { label: "Refunded", detail: "This sale was refunded to the buyer before it was paid out, so no payout is due.", tone: "grey" };
    default:
      return { label: "Status unavailable", detail: "", tone: "grey" };
  }
}

export function describeSettlementAccount(accountStatus) {
  switch (accountStatus) {
    case "active": return { label: "Bank account saved", tone: "green", needsAction: false };
    case "pending": return { label: "Payout setup in progress", tone: "amber", needsAction: false };
    case "suspended": return { label: "Payouts paused — contact support", tone: "red", needsAction: true };
    default: return { label: "No bank account saved", tone: "red", needsAction: true };
  }
}

const EMPTY = {
  account_status: "none", bank_masked: null, next_payout_date: null, min_payout_paise: 0, bank_cooldown_hours: 0, bank_unlocks_at: null,
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

// "25 Oct 2026, 3:30 pm IST" -- pinned to India time so the date never shifts with the viewer's time zone. "" when the input is not a date.
export function formatUnlockAt(iso) {
  const d = typeof iso === "string" || iso instanceof Date ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  return `${date}, ${time} IST`;
}

/** The notice shown after a seller changes their UPI ID. null when there is nothing to say (no cooldown, or it has already ended). */
export function describeUpiCooldown(unlocksAt, now = new Date()) {
  const t = typeof unlocksAt === "string" ? new Date(unlocksAt) : null;
  if (!t || Number.isNaN(t.getTime()) || t.getTime() <= now.getTime()) return null;
  return `UPI ID updated. Payouts to this ID will unlock after ${formatUnlockAt(unlocksAt)}.`;
}

/** What /sell/payout needs: the cooldown length and, if one is running, when it ends. Never throws. */
export async function getSellerUpiCooldown(supabase) {
  try {
    const { data, error } = await supabase.rpc("seller_upi_cooldown");
    if (error || !data) return { upi_cooldown_hours: 0, upi_unlocks_at: null };
    return { upi_cooldown_hours: Number.isInteger(data.upi_cooldown_hours) ? data.upi_cooldown_hours : 0, upi_unlocks_at: typeof data.upi_unlocks_at === "string" ? data.upi_unlocks_at : null };
  } catch {
    return { upi_cooldown_hours: 0, upi_unlocks_at: null };
  }
}

/** The notice shown while a changed bank account is waiting out its cooldown. null when there is nothing to say. */
export function describeBankCooldown(unlocksAt, now = new Date()) {
  const t = typeof unlocksAt === "string" ? new Date(unlocksAt) : null;
  if (!t || Number.isNaN(t.getTime()) || t.getTime() <= now.getTime()) return null;
  return `Bank account updated. Payouts to this account will unlock after ${formatUnlockAt(unlocksAt)}. Earnings made meanwhile are paid in the next monthly payout after that.`;
}
