// lib/domain/direct-upi.js -- direct seller-to-buyer UPI payments (flag `direct_upi_checkout`).
// The platform never receives the money: the buyer pays the seller's UPI ID and submits the 12-digit UTR; the SELLER confirms.
// Every rule here is enforced again by the database functions (migration 20261024100000); this file is the friendly layer:
// validation messages, the UPI payment link, plain-English wording, and loaders that never throw.

export const UTR_REGEX = /^[0-9]{12}$/;
export const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const ID_TYPES = [
  { value: "aadhaar", label: "Aadhaar", hint: "12 digits" },
  { value: "voter_id", label: "Voter ID", hint: "3 letters + 7 digits" },
  { value: "passport", label: "Passport", hint: "1 letter + 7 digits" },
];
const ID_NUMBER = { aadhaar: /^[2-9][0-9]{11}$/, voter_id: /^[A-Z]{3}[0-9]{7}$/, passport: /^[A-Z][0-9]{7}$/ };

export const stripSpaces = (v) => String(v ?? "").replace(/[\s-]/g, "");

/** @returns {{ ok: boolean, value: string, error: string|null }} */
export function validateUtr(raw) {
  const value = String(raw ?? "").replace(/\s/g, "");
  if (value === "") return { ok: false, value, error: null };
  if (!/^[0-9]+$/.test(value)) return { ok: false, value, error: "A UTR is 12 digits, with no letters." };
  if (value.length !== 12) return { ok: false, value, error: "A UTR has exactly 12 digits." };
  return { ok: true, value, error: null };
}

/** Normalises an Indian mobile number the way the database does. */
export function normalizePhone(raw) {
  let p = stripSpaces(raw);
  if (/^\+91[0-9]{10}$/.test(p)) p = p.slice(3);
  else if (/^91[0-9]{10}$/.test(p)) p = p.slice(2);
  else if (/^0[0-9]{10}$/.test(p)) p = p.slice(1);
  return p;
}

/**
 * Validates the step-1 identity form. Returns { ok, errors: { field: message }, values } where values are normalised exactly like the database does.
 * The government-ID number is validated here and in the database, then discarded: only its type and last 4 characters are ever stored.
 */
export function validateIdentity(f) {
  const errors = {};
  const first = String(f.first ?? "").trim(), last = String(f.last ?? "").trim();
  const email = String(f.email ?? "").trim().toLowerCase();
  const phone = normalizePhone(f.phone);
  const address = String(f.address ?? "").trim();
  const pan = String(f.pan ?? "").trim().toUpperCase();
  const idType = String(f.idType ?? "");
  const idNumber = stripSpaces(f.idNumber).toUpperCase();
  if (!first || first.length > 60 || /[0-9<>@]/.test(first)) errors.first = "Enter your legal first name.";
  if (!last || last.length > 60 || /[0-9<>@]/.test(last)) errors.last = "Enter your legal last name.";
  if (email.length > 254 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) errors.email = "Enter a valid e-mail address.";
  if (!/^[6-9][0-9]{9}$/.test(phone)) errors.phone = "Enter a 10-digit Indian mobile number.";
  if (address.length < 5 || address.length > 300 || /[<>]/.test(address)) errors.address = "Enter your street address (at least 5 characters).";
  if (!PAN_REGEX.test(pan)) errors.pan = "A PAN has 10 characters, like ABCDE1234F.";
  if (!ID_TYPES.some((t) => t.value === idType)) errors.idType = "Choose an ID type.";
  else if (!ID_NUMBER[idType].test(idNumber)) errors.idNumber = `That doesn't look like a valid ${ID_TYPES.find((t) => t.value === idType).label} number (${ID_TYPES.find((t) => t.value === idType).hint}).`;
  return { ok: Object.keys(errors).length === 0, errors, values: { first, last, email, phone, address, country: "India", pan, idType, idNumber } };
}

/** Plain-English message for an error from the identity / UPI / claim functions. */
export function explainDirectError(error) {
  const m = String(error?.message || "");
  const map = {
    identity_required: "Please complete your identity and tax details before setting up your UPI payout ID.",
    too_many_changes: "You've changed this several times today. Please try again tomorrow.",
    invalid_first_name: "Check your first name.", invalid_last_name: "Check your last name.", invalid_email: "Check your e-mail address.",
    invalid_phone: "Check your mobile number.", invalid_address: "Check your address.", invalid_country: "Only India is supported for now.",
    invalid_pan: "Check your PAN.", invalid_id_type: "Choose an ID type.", invalid_id_number: "Check your ID number.",
    invalid_utr: "A UTR has exactly 12 digits.", too_many_claims: "You've submitted several payment claims today. Please try again tomorrow.",
    claim_already_pending: "You've already submitted a claim for this listing. Waiting for the seller to confirm.",
    utr_already_used: "That UTR has already been used for another claim. Check the number in your UPI app.",
    own_listing: "You can't buy your own listing.", already_purchased: "You already own this.", previously_refunded: "This purchase was refunded earlier, so it can't be bought again.",
    seller_not_ready: "This seller hasn't finished setting up payments yet.", upi_in_cooldown: "This seller changed their UPI ID recently. Payments reopen shortly.",
    listing_unavailable: "This listing isn't available for purchase.", feature_off: "Direct payments aren't switched on yet.",
    claim_not_found: "We couldn't find that payment claim.", claim_not_pending: "That claim has already been dealt with.",
    buyer_already_owns: "This buyer already has access to the listing.", reason_too_long: "Please keep the reason under 200 characters.",
    seller_setup_incomplete: "Finish your identity details and UPI ID before listing.",
  };
  if (map[m]) return map[m];
  if (error?.code === "42501") return "Please log in again.";
  return "That didn't work just now. Please try again in a moment.";
}

/**
 * The standard UPI payment link. Only the seller's own UPI ID, the price from the SERVER, and a short note go in it.
 * @param {{ vpa: string, payeeName?: string, amountPaise: number, listingId: string }} p
 */
export function buildUpiUri({ vpa, payeeName, amountPaise, listingId }) {
  if (typeof vpa !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$/.test(vpa)) return "";
  if (!Number.isInteger(amountPaise) || amountPaise < 1) return "";
  const pn = encodeURIComponent(String(payeeName || "Seller").slice(0, 40));
  const tn = encodeURIComponent(`Chatmarket-${String(listingId || "").replace(/-/g, "").slice(0, 8)}`);
  return `upi://pay?pa=${vpa}&pn=${pn}&am=${(amountPaise / 100).toFixed(2)}&cu=INR&tn=${tn}`;
}

/** App-specific deep links for mobile ("UPI intent buttons"): same payload, different scheme. */
export const UPI_APPS = [
  { id: "gpay", label: "Google Pay", scheme: "tez://upi/pay" },
  { id: "phonepe", label: "PhonePe", scheme: "phonepe://pay" },
  { id: "paytm", label: "Paytm", scheme: "paytmmp://pay" },
  { id: "cred", label: "CRED", scheme: "cred://upi/pay" },
];
export function appLink(appId, uri) {
  const app = UPI_APPS.find((a) => a.id === appId);
  if (!app || !uri.startsWith("upi://pay?")) return "";
  return `${app.scheme}?${uri.slice("upi://pay?".length)}`;
}

/** Why a listing can't be bought directly right now, in words for the buyer. */
export function describeTargetReason(target) {
  switch (target?.reason) {
    case "own_listing": return "This is your own listing.";
    case "already_purchased": return "You already own this.";
    case "previously_refunded": return "This purchase was refunded earlier, so it can't be bought again.";
    case "seller_not_ready": return "This seller is still finishing their payment setup. Please check back soon.";
    case "upi_in_cooldown": return `The seller changed their payment details recently, so buying reopens ${formatUnlockTime(target.unlocks_at) || "shortly"}. This protects buyers from payments going to the wrong person.`;
    case "listing_unavailable": return "This listing isn't available for purchase.";
    default: return "Buying isn't available for this listing right now.";
  }
}

export function formatUnlockTime(iso) {
  const d = typeof iso === "string" ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return `after ${d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })}`;
}

/** Wording for the buyer's latest claim on a listing. */
export function describeClaim(claim) {
  switch (claim?.status) {
    case "pending":
      return claim.overdue
        ? { tone: "amber", label: "Still waiting for the seller", detail: "The seller hasn't confirmed yet. You can message them, or submit your UTR again if you typed it wrong." }
        : { tone: "amber", label: "Payment claim submitted", detail: "Waiting for the seller to verify and unlock your playbook." };
    case "rejected":
      return { tone: "red", label: "The seller couldn't match your payment", detail: claim.reject_reason ? `Reason: ${claim.reject_reason}. Check the UTR and submit it again.` : "Check the UTR and submit it again." };
    case "expired":
      return { tone: "grey", label: "That claim expired", detail: "You can submit a new one." };
    case "confirmed":
      return { tone: "green", label: "Payment confirmed", detail: "Your playbook is unlocked." };
    default:
      return null;
  }
}

/** What the seller sees for a claim row. */
export function describeSellerClaim(c) {
  if (c?.status === "pending") return c.overdue ? { label: "Overdue", tone: "red" } : { label: "Awaiting you", tone: "amber" };
  if (c?.status === "confirmed") return { label: "Confirmed", tone: "green" };
  if (c?.status === "rejected") return { label: "Rejected", tone: "grey" };
  return { label: "Expired", tone: "grey" };
}

// ---------------------------------------------------------------- loaders (never throw)
export async function isDirectCheckoutEnabled(supabase) {
  try { const { data, error } = await supabase.rpc("direct_upi_checkout_enabled"); return !error && data === true; } catch { return false; }
}
export async function getDirectTarget(supabase, listingId) {
  try {
    const { data, error } = await supabase.rpc("get_direct_payment_target", { p_listing_id: listingId });
    if (error || !data) return { enabled: false, error: true };
    return data;
  } catch { return { enabled: false, error: true }; }
}
export async function getMyDirectSellerStatus(supabase) {
  const EMPTY = { flag_on: false, identity_complete: false, has_upi: false, upi_active: false, upi_unlocks_at: null, upi_cooldown_hours: 0 };
  try {
    const { data, error } = await supabase.rpc("my_direct_seller_status");
    if (error || !data) return EMPTY;
    return { ...EMPTY, ...data };
  } catch { return EMPTY; }
}
export async function getSellerDirectClaims(supabase) {
  try {
    const { data, error } = await supabase.rpc("seller_direct_claims", { p_limit: 100 });
    if (error || !data || !Array.isArray(data.claims)) return { claims: [], pending_count: 0, error: true };
    return data;
  } catch { return { claims: [], pending_count: 0, error: true }; }
}
