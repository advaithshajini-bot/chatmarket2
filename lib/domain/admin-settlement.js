// lib/domain/admin-settlement.js -- Milestone 5.5: what the admin "Monthly settlement" tab reads, does and exports.
// UX only: the real gate is private.is_admin_mfa() (admin AND aal2) inside every admin_settlement_* function. Money is integer paise.
//
// The monthly routine is: preview -> freeze a batch -> export the CSV -> pay each seller by bank transfer (bank/app bulk transfer) -> record the bank
// reference -> done. Nothing here sends money: the platform never calls an outgoing payout API.

export { formatPaise } from "./paise.js";

async function rpc(supabase, fn, args, fallback) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error || data == null) return { ...fallback, error: true };
    return data;
  } catch {
    return { ...fallback, error: true };
  }
}

async function act(supabase, fn, args, fallbackMessage) {
  try {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) return { error: explainSettlementError(error, fallbackMessage) };
    return { ok: true, data };
  } catch {
    return { error: fallbackMessage };
  }
}

const EMPTY_PENDING = { min_payout_paise: 0, bank_cooldown_hours: 0, totals: { payable_paise: 0, payable_sellers: 0, payable_purchases: 0, blocked_paise: 0, blocked_sellers: 0 }, payable: [], blocked: [], open_batch_id: null };

export const getSettlementPending = (supabase, periodEndIso = null) => rpc(supabase, "admin_settlement_pending", { p_period_end: periodEndIso, p_limit: 500 }, EMPTY_PENDING);
export const getSettlementBatches = (supabase) => rpc(supabase, "admin_settlement_batches", { p_limit: 24 }, { items: [] });
export const getSettlementBatch = (supabase, batchId) => rpc(supabase, "admin_settlement_batch", { p_batch_id: batchId }, { found: false, items: [] });

export const createSettlementBatch = (supabase, { label, periodEndIso }) =>
  act(supabase, "admin_create_settlement_batch", { p_label: label, p_period_end: periodEndIso }, "Could not create the batch.");
/** Record that the money was sent. itemIds = null -> every pending item in the batch. reference = the bank / bulk-transfer UTR. */
export const settleItems = (supabase, batchId, reference, itemIds = null) =>
  act(supabase, "admin_settle_items", { p_batch_id: batchId, p_reference: reference, p_item_ids: itemIds }, "Could not record the payment.");
/** A manual transfer bounced: put that seller's sales back to unsettled (they join the next batch). */
export const releaseSettlementItem = (supabase, itemId, reason) =>
  act(supabase, "admin_release_settlement_item", { p_item_id: itemId, p_reason: reason }, "Could not release the item.");
/** Mark ONE seller's pending line as paid. paymentDate = "YYYY-MM-DD" (IST day it was sent; default today). Needs the bank reference. */
export const settleSingleItem = (supabase, itemId, reference, paymentDate = null) =>
  act(supabase, "admin_settle_single_item", { p_item_id: itemId, p_reference: reference, p_payment_date: paymentDate || null }, "Could not record the payment.");
/** "Payout Completed" from the seller's summary row: freezes that seller's eligible sales (up to the cut-off) into a one-seller batch that is
 *  already completed and paid, with the bank reference and payment date. Their /sell/earnings shows it as Paid straight away. */
export const completeSellerPayout = (supabase, sellerId, periodEndIso, reference, paymentDate = null) =>
  act(supabase, "admin_complete_seller_payout", { p_seller_id: sellerId, p_period_end: periodEndIso, p_reference: reference, p_payment_date: paymentDate || null }, "Could not record the payout.");
/** Full bank details of one seller for a single-seller transfer file (admin + MFA only; the read is written to the audit log). */
export const getSellerBankDetails = async (supabase, sellerId) => {
  const r = await act(supabase, "admin_seller_bank_details", { p_seller_id: sellerId }, "Could not load the bank details.");
  return r.error ? r : r.data?.found ? { ok: true, data: r.data } : { error: "This seller has no complete bank account saved." };
};
export const cancelSettlementBatch = (supabase, batchId) =>
  act(supabase, "admin_cancel_settlement_batch", { p_batch_id: batchId }, "Could not cancel the batch.");

export function explainSettlementError(error, fallback = "Something went wrong.") {
  const m = String(error?.message || "");
  if (/open_batch_exists/.test(m)) return "A batch is already open. Finish or cancel it first.";
  if (/label_taken/.test(m)) return "A batch with that label already exists.";
  if (/nothing_to_settle/.test(m)) return "Nothing to settle for that period: no seller with a saved bank account is owed anything.";
  if (/batch_not_open/.test(m)) return "That batch (or item) can no longer be changed. A paid item is final.";
  if (/invalid_items/.test(m)) return "Some of the selected items are not pending in this batch.";
  if (/invalid_settlement_input|CM076/.test(m) || error?.code === "CM076") return "Please check the label, date and reference you entered. The payment date can't be in the future or more than 90 days ago.";
  if (error?.code === "42501") return "Your admin MFA session is required. Complete your second-factor check and reload.";
  return fallback;
}

// ---- IST month helpers. India has no daylight saving: IST is always UTC+05:30.
const IST_MS = 5.5 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** The instant (ISO) at which the IST calendar month containing `now` began. */
export function startOfIstMonthIso(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_MS).toISOString();
}

/** Default monthly run: settle every sale made BEFORE the 1st of this IST month, labelled with the month that just ended ("2026-10"). */
export function defaultSettlementPeriod(now = new Date()) {
  const ist = new Date(now.getTime() + IST_MS);
  const prev = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
  return {
    label: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`,
    cutoffDate: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-01`,   // exclusive: sales before this day (IST)
    todayDate: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`,
  };
}

/** "2026-11-01" (a calendar day in IST) -> the ISO instant that day starts. null when the input is not a valid date. */
export function istDateToIso(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(`${dateStr}T00:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- CSV for the manual bank transfer (IMPS / NEFT; upload to a corporate net-banking portal or read it by hand)
// paise (integer) -> "492.00" without ever going through floating point
export function paiseToRupeesString(paise) {
  if (!Number.isInteger(paise) || paise < 0) return "";
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

// Spreadsheet formula injection: a cell that starts with = + - @ (or a tab / carriage return) is executed by Excel and Sheets. Display names are
// free text written by sellers, so every text cell is neutralised with a leading apostrophe, then quoted if needed.
export function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["Beneficiary Name", "Account Number", "IFSC Code", "Account Type", "Net Payout (INR)", "Remarks"];

// The account number is always quoted: a bank portal reads it as text, and a cell that starts with 0 stays one string.
// (Excel itself may still drop leading zeros when the file is double-clicked: open it in a text editor or import the column as Text.)
const csvText = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/** Rows of a batch -> CSV text. Pending items only by default (what is still to be paid). Line endings are CRLF for Excel.
 *  Columns: Beneficiary Name, Account Number, IFSC Code, Account Type, Net Payout (INR), Remarks. An item without a bank snapshot (an old UPI batch) is skipped. */
export function buildSettlementCsv(batch, items, { onlyPending = true } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((i) => (!onlyPending || i.status === "pending") && i.bank_account_number);
  const remarks = `Chatmarket payout ${batch?.label ?? ""}`.trim();
  const lines = [CSV_HEADER.join(",")];
  for (const i of rows) {
    lines.push([
      csvCell(i.bank_beneficiary_name || i.seller_name || "Seller"), csvText(i.bank_account_number), csvCell(i.bank_ifsc),
      i.bank_account_type === "current" ? "Current" : "Savings", paiseToRupeesString(i.amount_paise), csvCell(i.utr ? `${remarks} - Ref ${i.utr}` : remarks),
    ].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** One seller, one row, same six columns as the full CSV. Remarks: "Chatmarket payout <label> - <Seller Name>". The account number is always quoted (leading zeros). */
export function buildSellerPayoutCsv({ label, sellerName, beneficiaryName, accountNumber, ifsc, accountType, amountPaise }) {
  const remarks = `Chatmarket payout ${label ?? ""}`.trim() + ` - ${sellerName || beneficiaryName || "Seller"}`;
  const row = [
    csvCell(beneficiaryName || sellerName || "Seller"), csvText(accountNumber), csvCell(ifsc),
    accountType === "current" ? "Current" : "Savings", paiseToRupeesString(amountPaise), csvCell(remarks),
  ].join(",");
  return [CSV_HEADER.join(","), row].join("\r\n") + "\r\n";
}

export function sellerCsvFilename(label, sellerName) {
  const slug = (v, d) => String(v ?? d).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || d;
  return `chatmarket-payout-${slug(label, "batch")}-${slug(sellerName, "seller")}.csv`;
}

export function csvFilename(batch) {
  const slug = String(batch?.label ?? "batch").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "batch";
  return `chatmarket-settlement-${slug}.csv`;
}

export const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._/ -]{0,79}$/;   // mirrors the database check in admin_settle_items
export const isValidReference = (s) => REFERENCE_RE.test(String(s ?? "").trim());

export const BLOCKED_LABELS = {
  no_bank_account: "No bank account saved",
  account_pending: "Payout setup not finished",
  account_suspended: "Payouts paused",
  below_minimum: "Below the minimum payout: rolls over",
  bank_in_cooldown: "Bank account changed recently: rolls over",
};
