// lib/domain/bank-payout.js -- seller bank account for MANUAL monthly payouts (IMPS / NEFT sent by the admin). Framework-free: no network, no database.
// The SAME rules are enforced again in the database function set_my_bank_payout (migration 20261029100000), so this is only the friendly layer.
// The full account number is stored (the admin needs it to pay) but is never readable by the seller's own API role: screens only ever get the last 4 digits.

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[0-9]{9,18}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,119}$/;

const clean = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const digits = (v) => (typeof v === "string" ? v.replace(/[\s-]/g, "") : "");

/** @returns {{ ok: boolean, errors: Record<string,string>, value: { beneficiaryName, accountNumber, ifsc, accountType } }} */
export function validateBankPayoutForm(raw) {
  const f = raw ?? {};
  const errors = {};
  const beneficiaryName = clean(f.beneficiaryName, 120);
  if (!NAME_RE.test(beneficiaryName)) errors.beneficiaryName = "Enter the account holder's name exactly as the bank has it.";
  const accountNumber = digits(f.accountNumber);
  if (!ACCOUNT_RE.test(accountNumber)) errors.accountNumber = "A bank account number has 9 to 18 digits.";
  const confirmAccountNumber = digits(f.confirmAccountNumber);
  if (confirmAccountNumber !== accountNumber) errors.confirmAccountNumber = "The two account numbers don't match.";
  const ifsc = clean(f.ifsc, 11).toUpperCase();
  if (!IFSC_RE.test(ifsc)) errors.ifsc = "An IFSC looks like HDFC0001234.";
  const accountType = f.accountType === "current" ? "current" : "savings";
  return { ok: Object.keys(errors).length === 0, errors, value: { beneficiaryName, accountNumber, ifsc, accountType } };
}

/** "****1234" from the last 4 digits (or from a full number). "" when there is nothing sensible to show. */
export function maskBankAccount(value) {
  const s = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return s.length >= 4 ? `****${s.slice(-4)}` : "";
}

export function describeBankPayout(status) {
  if (status?.configured) return { label: "Bank Account Configured for Payouts", tone: "green" };
  return { label: "No bank account saved yet", tone: "red" };
}

export function explainBankPayoutError(error) {
  const m = String(error?.message || error?.error || "");
  if (/too_many_changes/.test(m)) return "You've changed your bank details several times today. Please try again tomorrow.";
  if (/invalid_bank_details|CM080/.test(m) || error?.code === "CM080") return "Please check the bank details and try again.";
  if (error?.code === "42501" || /login_required/.test(m)) return "Please log in again to save your bank details.";
  return typeof error?.error === "string" && error.error.length < 200 ? error.error : "We couldn't save that just now. Please try again in a moment.";
}

const EMPTY = { configured: false, last4: null, ifsc: null, beneficiary_name: null, account_type: null, bank_cooldown_hours: 0, bank_unlocks_at: null };

/** What /sell/payout needs about the seller's saved account. Never the full number. Never throws. */
export async function getMyBankPayout(supabase) {
  try {
    const { data, error } = await supabase.rpc("my_bank_payout");
    if (error || !data || typeof data !== "object") return EMPTY;
    return { ...EMPTY, ...data };
  } catch { return EMPTY; }
}
