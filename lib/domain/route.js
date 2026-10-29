// lib/domain/route.js -- Razorpay Route (linked accounts + order-level split transfers). Framework-free: no network, no database.
// Used by the browser form (validation / wording) AND by the server routes (payload builders), so both sides agree.
//
// Money: integer paise. chatmarket commission is 0: the order carries ONE transfer for 100% of the amount to the seller's linked account.

export const ROUTE_STATUSES = ["created", "under_review", "needs_clarification", "activated", "suspended", "rejected"];
export const ACCOUNT_ID_RE = /^acc_[A-Za-z0-9]{6,40}$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

// Razorpay requires a business profile even for an individual seller. These are fixed, platform-chosen values (not asked from the seller).
export const ROUTE_PROFILE = { category: "services", subcategory: "professional_services" };

// ---------------------------------------------------------------------------------------------- order payload (create-order)
/** The body for POST /v1/orders. With an accountId the order carries a 100% transfer to that linked account. */
export function buildOrderBody({ amountPaise, listingId, userId, accountId, now = Date.now() }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new Error("invalid_amount");
  const body = {
    amount: amountPaise,
    currency: "INR",
    receipt: `l_${String(listingId).replace(/-/g, "").slice(0, 20)}_${now.toString(36)}`,   // Razorpay caps receipt at 40 chars
    notes: { listingId, userId },
  };
  if (accountId) {
    if (!ACCOUNT_ID_RE.test(accountId)) throw new Error("invalid_account");
    body.transfers = [{ account: accountId, amount: amountPaise, currency: "INR", on_hold: false, notes: { listingId } }];
  }
  return body;
}

// ---------------------------------------------------------------------------------------------- onboarding form
const clean = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const digits = (v) => (typeof v === "string" ? v.replace(/[\s-]/g, "") : "");

/** @returns {{ ok: boolean, errors: Record<string,string>, value: object }} value is normalised (PAN/IFSC upper-case, phone 10 digits). */
export function validateRouteForm(raw) {
  const f = raw ?? {};
  const errors = {};
  const legalName = clean(f.legalName, 120);
  if (!/^[A-Za-z][A-Za-z .'-]{1,119}$/.test(legalName)) errors.legalName = "Enter your full name exactly as it appears on your PAN.";
  const email = clean(f.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  let phone = digits(f.phone).replace(/^\+?91/, "");
  if (!/^[6-9][0-9]{9}$/.test(phone)) errors.phone = "Enter a 10-digit Indian mobile number.";
  const pan = clean(f.pan, 10).toUpperCase();
  if (!PAN_RE.test(pan)) errors.pan = "A PAN looks like ABCDE1234F.";
  const beneficiaryName = clean(f.beneficiaryName, 120);
  if (!/^[A-Za-z][A-Za-z .'-]{1,119}$/.test(beneficiaryName)) errors.beneficiaryName = "Enter the account holder's name as per the bank.";
  const accountNumber = digits(f.accountNumber);
  if (!/^[0-9]{9,18}$/.test(accountNumber)) errors.accountNumber = "A bank account number has 9 to 18 digits.";
  const ifsc = clean(f.ifsc, 11).toUpperCase();
  if (!IFSC_RE.test(ifsc)) errors.ifsc = "An IFSC looks like HDFC0001234.";
  const confirmAccountNumber = digits(f.confirmAccountNumber);
  if (confirmAccountNumber !== accountNumber) errors.confirmAccountNumber = "The two account numbers don't match.";
  const accountType = f.accountType === "current" ? "current" : "savings";
  const businessType = f.businessType === "proprietorship" ? "proprietorship" : "individual";
  const street = clean(f.street, 100);
  if (street.length < 5) errors.street = "Enter your street address.";
  const city = clean(f.city, 60);
  if (city.length < 2) errors.city = "Enter your city.";
  const state = clean(f.state, 60);
  if (state.length < 2) errors.state = "Enter your state.";
  const postalCode = digits(f.postalCode);
  if (!/^[1-9][0-9]{5}$/.test(postalCode)) errors.postalCode = "A PIN code has 6 digits.";
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { legalName, email, phone, pan, beneficiaryName, accountNumber, ifsc, accountType, businessType, street, city, state, postalCode },
  };
}

// The 2-step form: step 1 = identity, step 2 = bank settlement. Each step validates only its own fields.
export const STEP1_FIELDS = ["legalName", "email", "phone", "pan", "street", "city", "state", "postalCode"];
export const STEP2_FIELDS = ["beneficiaryName", "accountNumber", "confirmAccountNumber", "ifsc"];
export function validateRouteStep(raw, step) {
  const v = validateRouteForm(raw);
  const keys = step === 1 ? STEP1_FIELDS : STEP2_FIELDS;
  const errors = Object.fromEntries(Object.entries(v.errors).filter(([k]) => keys.includes(k)));
  return { ok: Object.keys(errors).length === 0, errors, value: v.value };
}

/** The only bank facts we keep: last 4 digits, IFSC, beneficiary name, account type. The full account number goes to the payment partner and is never stored. */
export function buildBankDisplay(v) {
  return { last4: v.accountNumber.slice(-4), ifsc: v.ifsc, beneficiaryName: v.beneficiaryName, accountType: v.accountType };
}
export const maskAccount = (last4) => (/^[0-9]{4}$/.test(last4 ?? "") ? `****${last4}` : "");

/** draft | submitted | activated | action_required (mirrors the database's generated onboarding_status column). */
export function onboardingStatusFor(routeStatus) {
  if (routeStatus === "activated") return "activated";
  if (routeStatus === "under_review") return "submitted";
  if (routeStatus === "needs_clarification" || routeStatus === "rejected" || routeStatus === "suspended") return "action_required";
  return "draft";
}

// ---------------------------------------------------------------------------------------------- Razorpay v2 payloads
/** POST /v2/accounts -- an individual seller's Route linked account. */
export function buildLinkedAccountPayload(v, { referenceId } = {}) {
  return {
    email: v.email,
    phone: v.phone,
    type: "route",
    reference_id: referenceId ? String(referenceId).replace(/-/g, "").slice(0, 20) : undefined,
    legal_business_name: v.legalName,
    business_type: v.businessType === "proprietorship" ? "proprietorship" : "individual",
    contact_name: v.legalName,
    profile: {
      category: ROUTE_PROFILE.category,
      subcategory: ROUTE_PROFILE.subcategory,
      addresses: {
        registered: { street1: v.street, street2: v.street, city: v.city, state: v.state.toUpperCase(), postal_code: v.postalCode, country: "IN" },
      },
    },
    legal_info: { pan: v.pan },
  };
}

/** POST /v2/accounts/:id/products -- request the Route product (terms accepted by the seller on the form). */
export const buildProductRequestPayload = () => ({ product_name: "route", tnc_accepted: true });

/** PATCH /v2/accounts/:id/products/:pid -- where the seller's money is settled. */
export function buildSettlementPayload(v) {
  return { settlements: { account_number: v.accountNumber, ifsc_code: v.ifsc, beneficiary_name: v.beneficiaryName }, tnc_accepted: true };
}

// ---------------------------------------------------------------------------------------------- status mapping
/** Razorpay account/product status -> our route_status. Anything we do not recognise stays 'created' (never silently 'activated'). */
export function mapRazorpayStatus(s) {
  const v = typeof s === "string" ? s.toLowerCase() : "";
  if (v === "activated" || v === "instantly_activated") return "activated";
  if (v === "under_review" || v === "activated_kyc_pending") return "under_review";
  if (v === "needs_clarification") return "needs_clarification";
  if (v === "suspended") return "suspended";
  if (v === "rejected") return "rejected";
  return "created";
}

/** Webhook event name (account.*) -> our route_status, or null if it is not an account status event. */
export function routeStatusForAccountEvent(eventType) {
  const m = /^account\.(instantly_activated|activated_kyc_pending|under_review|needs_clarification|activated|rejected|suspended)$/.exec(eventType ?? "");
  return m ? mapRazorpayStatus(m[1]) : null;
}

export function describeRouteStatus(status) {
  switch (status) {
    case "activated": return { label: "Active", tone: "green", detail: "You're set up. Buyers pay you through chatmarket and the money is split to your bank account." };
    case "under_review": return { label: "Under review", tone: "amber", detail: "Razorpay is reviewing your details. You can list once it is active." };
    case "needs_clarification": return { label: "More information needed", tone: "amber", detail: "Razorpay needs a correction. Check your details and submit again." };
    case "suspended": return { label: "Suspended", tone: "red", detail: "Payouts to this account are paused. Please contact support." };
    case "rejected": return { label: "Not approved", tone: "red", detail: "Razorpay couldn't approve these details. Check them and submit again, or contact support." };
    case "created": return { label: "Setting up", tone: "amber", detail: "Your account was created but isn't finished yet. Submit the form again to continue." };
    default: return { label: "Not started", tone: "gray", detail: "Add your details to start receiving payments." };
  }
}

export function explainRouteError(error) {
  const m = error?.message || error?.error || "";
  if (/route_account_exists/.test(m)) return "You already have an active payment account.";
  if (/too_many_route_attempts/.test(m)) return "You've tried several times today. Please try again tomorrow.";
  if (/route_disabled/.test(m)) return "Payment onboarding isn't open yet.";
  if (/seller_not_ready/.test(m)) return "This seller hasn't finished setting up payments yet.";
  return typeof error?.error === "string" && error.error.length < 200 ? error.error : "We couldn't complete that just now. Please try again in a moment.";
}

// ---------------------------------------------------------------------------------------------- app-side loaders (RLS / RPC only)
export async function getMyRouteStatus(supabase) {
  const empty = { route_enabled: false, has_account: false, route_status: null, route_note: null, ready: false };
  try {
    const { data, error } = await supabase.rpc("my_route_status");
    if (error || !data || typeof data !== "object") return empty;
    return { ...empty, ...data };
  } catch { return empty; }
}

export async function isRouteCheckoutEnabled(supabase) {
  try {
    const { data, error } = await supabase.rpc("route_checkout_enabled");
    return !error && data === true;
  } catch { return false; }
}
