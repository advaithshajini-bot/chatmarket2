// A67-L -- 2-step payout onboarding, bank display facts, IFSC lookup, and seller-transparency text. No database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import * as R from "../../lib/domain/route.js";
import { onboardLinkedAccount } from "../../lib/payments/route-onboarding.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const noComments = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const good = { legalName: "Asha Rao", email: "asha@example.com", phone: "9876543210", pan: "ABCDE1234F", businessType: "proprietorship", street: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001",
  beneficiaryName: "Asha Rao", accountNumber: "123456789012", confirmAccountNumber: "123456789012", ifsc: "HDFC0001234", accountType: "current" };

// ---- steps
check("S01 step 1 validates ONLY identity fields: bank fields left empty do not block it", R.validateRouteStep({ ...good, beneficiaryName: "", accountNumber: "", confirmAccountNumber: "", ifsc: "" }, 1).ok);
check("S02 step 1 reports bad PAN / phone / PIN, and nothing about the bank", (() => { const r = R.validateRouteStep({ ...good, pan: "x", phone: "1", postalCode: "9", accountNumber: "" }, 1); return !r.ok && r.errors.pan && r.errors.phone && r.errors.postalCode && !r.errors.accountNumber; })());
check("S03 step 2 validates ONLY bank fields and enforces the confirm-account-number equality", (() => { const a = R.validateRouteStep({ ...good, confirmAccountNumber: "123456789013" }, 2); const b = R.validateRouteStep({ ...good, legalName: "" }, 2); return !a.ok && a.errors.confirmAccountNumber && b.ok; })());
check("S04 IFSC and account number are validated (format), beneficiary name required", (() => { const r = R.validateRouteStep({ ...good, ifsc: "HDFC1001234", accountNumber: "12", confirmAccountNumber: "12", beneficiaryName: "" }, 2); return r.errors.ifsc && r.errors.accountNumber && r.errors.beneficiaryName; })());
check("S05 the full validation passes for a good form and normalises account type and business type", (() => { const v = R.validateRouteForm(good); return v.ok && v.value.accountType === "current" && v.value.businessType === "proprietorship"; })() && R.validateRouteForm({ ...good, accountType: "x", businessType: "y" }).value.accountType === "savings" && R.validateRouteForm({ ...good, businessType: "y" }).value.businessType === "individual");
check("S06 the account number and its confirmation may be typed with spaces or dashes", R.validateRouteForm({ ...good, accountNumber: "1234 5678-9012", confirmAccountNumber: "123456789012" }).ok);
check("S07 business type reaches the linked-account payload (individual / proprietorship); type stays 'route', PAN under legal_info", (() => { const v = R.validateRouteForm(good).value; const p = R.buildLinkedAccountPayload(v); const q = R.buildLinkedAccountPayload({ ...v, businessType: "individual" }); return p.business_type === "proprietorship" && q.business_type === "individual" && p.type === "route" && p.legal_info.pan === "ABCDE1234F"; })());

// ---- bank display + onboarding
const v = R.validateRouteForm(good).value;
check("S10 only display facts are derived from the bank details: last 4, IFSC, beneficiary, type; masking is ****1234", (() => { const d = R.buildBankDisplay(v); return d.last4 === "9012" && d.ifsc === "HDFC0001234" && d.accountType === "current" && !JSON.stringify(d).includes("123456789012") && R.maskAccount("9012") === "****9012" && R.maskAccount("12") === "" && R.maskAccount(null) === ""; })());
const saves = [], banks = [];
const db = { routeSaveAccount: async (a) => { saves.push(a); return { ready: a.routeStatus === "activated" }; }, routeSaveBank: async (a) => { banks.push(a); return { outcome: "saved" }; } };
const rzp = { createLinkedAccount: async () => ({ ok: true, accountId: "acc_BankTest00001" }), requestRouteProduct: async () => ({ ok: true, productId: "acc_prd_x" }), updateRouteProduct: async () => ({ ok: true, status: "under_review", requirements: [] }) };
const r = await onboardLinkedAccount({ db, rzp, userId: "u1", value: v, bankName: "HDFC Bank" });
check("S11 after the settlement step the display facts are saved with the bank name", r.ok && banks.length === 1 && banks[0].last4 === "9012" && banks[0].ifsc === "HDFC0001234" && banks[0].bankName === "HDFC Bank" && banks[0].accountType === "current");
check("S12 the full account number and the PAN reach NEITHER database call", !JSON.stringify([saves, banks]).match(/123456789012|ABCDE1234F/));
const r2 = await onboardLinkedAccount({ db: { ...db, routeSaveBank: async () => { throw new Error("boom"); } }, rzp, userId: "u1", value: v });
check("S13 a failure saving the display facts does not fail the onboarding (the account is already saved)", r2.ok === true);
check("S14 onboarding status wording: draft / submitted / activated / action_required", R.onboardingStatusFor("created") === "draft" && R.onboardingStatusFor(null) === "draft" && R.onboardingStatusFor("under_review") === "submitted" && R.onboardingStatusFor("activated") === "activated" && ["needs_clarification", "rejected", "suspended"].every((s) => R.onboardingStatusFor(s) === "action_required"));

// ---- the form and page
const form = read("components/RouteOnboardingForm.jsx"), fc = noComments(form), page = read("app/sell/payout/page.jsx");
check("S20 the form is a 2-step flow: 'Step 1 of 2' basic & identity details, then bank settlement details, with a Back button", /Step \{step\} of 2/.test(form) && /Basic & identity details/.test(form) && /Bank settlement details/.test(form) && />Back</.test(form) && /validateRouteStep\(form, 1\)/.test(form));
check("S21 step 1 has legal name, individual/proprietor, PAN, email, phone and the address fields", ["legalName", "pan", "email", "phone", "street", "city", "state", "postalCode"].every((k) => form.includes(`id="${k}"`)) && /Individual/.test(form) && /Proprietor/.test(form));
check("S22 step 2 has beneficiary (prefilled from the legal name), account number with a show/hide toggle, confirm account number, IFSC and Savings/Current", /id="beneficiaryName"/.test(form) && /beneficiaryTouched/.test(form) && /v\.value\.legalName/.test(form) && /type=\{show \? "text" : "password"\}/.test(form) && /Show account number/.test(form) && /id="confirmAccountNumber"/.test(form) && /id="ifsc"/.test(form) && /Savings/.test(form) && /Current/.test(form));
check("S23 the IFSC field is upper-cased and limited to 11 characters, and looks up the bank and branch through our own API", /toUpperCase\(\)\.replace\(\/\[\^A-Z0-9\]\/g, ""\)\.slice\(0, 11\)/.test(form) && /\/api\/ifsc\//.test(form) && /bank\.branch/.test(form));
check("S24 the penny-drop micro-copy is shown exactly as specified", /Razorpay will verify your bank details via an automated ₹1 penny-drop\. Payouts from thread sales settle automatically to this account\./.test(form));
check("S25 there is NO UPI ID field anywhere in the Route flow", !/upi|vpa/i.test(fc.replace(/UPI/g, "")) && !/id="upi"|set_my_payout_vpa/.test(form));
check("S26 /sell/payout is the bank-only screen (manual payouts): no Route/UPI branch is left in the page", /BankPayoutForm/.test(page) && !/set_my_payout_vpa|route_enabled|validateUpi/.test(page));
check("S27 the form shows the saved settlement account masked (****1234 · IFSC · bank · type)", /maskAccount\(status\.bank_account_last4\)/.test(form) && /Settlement account/.test(form));
check("S28 the form posts to our own API only and never keeps the account number after submit", /\/api\/razorpay\/route-onboard/.test(form) && !/api\.razorpay\.com/.test(form) && /setForm\(EMPTY\)/.test(form) && !/localStorage|sessionStorage/.test(form));

// ---- IFSC route
const ifsc = read("app/api/ifsc/[code]/route.js");
check("S30 the IFSC lookup validates the code, needs a login, times out fast and fails soft (404 'found: false')", /IFSC_RE\.test\(code\)/.test(ifsc) && /auth\.getUser/.test(ifsc) && /AbortController/.test(ifsc) && /found: false/.test(ifsc));

// ---- migration
const MIG = "20261028100000_seller_bank_details.sql";
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const m = read(`supabase/migrations/${MIG}`), low = m.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").toLowerCase();
check("S40 the migration exists and is additive: nothing is dropped, deleted or truncated", migs.includes(MIG) && !/\b(drop\s+(table|column|function|trigger|constraint|index|policy)|delete\s+from|truncate)\b/.test(low));
check("S41 idempotent: every column / constraint / generated column is guarded (if not exists)", (low.match(/add column if not exists/g) || []).length >= 1 && /if not exists \(select 1 from pg_constraint/.test(low) && /if not exists \(select 1 from information_schema\.columns/.test(low));
check("S42 it stores NO full account number or PAN (no such column is added)", !/bank_account_number|\bpan\b\s+text/.test(low) && /bank_account_last4/.test(low));
check("S43 the writer is service_role only and pins search_path", /revoke all on function public\.route_save_bank_display\([^)]*\) from public, anon, authenticated/.test(low) && /grant execute on function public\.route_save_bank_display\([^)]*\) to service_role/.test(low) && (m.match(/security definer/gi) || []).length === (m.match(/set search_path = ''/g) || []).length);

// ---- seller transparency (payer-payee audit)
const co = read("components/ListingCheckout.jsx"), lp = read("app/listing/[id]/page.jsx"), ph = read("components/PurchaseHistoryClient.jsx"), pp = read("app/purchases/page.jsx");
check("T01 the listing page shows 'Sold & Fulfilled by: <seller>' next to the title, before the rating row", /Sold &amp; Fulfilled by:/.test(lp) && /listing\.seller_name/.test(lp) && lp.indexOf("Sold &amp; Fulfilled by:") > lp.indexOf("{listing.title}") && lp.indexOf("Sold &amp; Fulfilled by:") < lp.indexOf("reviews.length > 0"));
check("T02 the checkout card repeats it next to the price", /data-testid="sold-by"/.test(co) && /Sold &amp; Fulfilled by:/.test(co) && /sellerName/.test(co));
check("T03 above the Pay button: 'Payment settled directly to <seller> via authorized settlement rails. Access is delivered instantly upon confirmation.'", /Payment settled directly to \{sellerName\} via authorized settlement rails\. Access is delivered instantly upon confirmation\./.test(co) && co.indexOf("settlement-note") < co.indexOf("onClick={handlePay}"));
check("T04 that settlement sentence is shown ONLY when the Route flag is ON (it would be untrue otherwise)", /\{route && \(\s*<p[^>]*data-testid="settlement-note"/.test(co));
check("T05 the old 'Funds held for 48 hrs' line is gone and replaced with the all-sales-final line", !/Funds held for 48/.test(co) && /All sales are final/.test(co));
check("T06 the seller name falls back to 'the seller' instead of printing 'null'", /\|\| "the seller"/.test(co) && /\|\| "the seller"/.test(lp));
check("T07 the purchase receipt shows the seller in the row and an Order reference in the details, from the purchase's own order id", /Sold &amp; fulfilled by \{order\.seller\}/.test(ph) && /Order reference/.test(ph) && /order\.orderRef/.test(ph) && /razorpay_order_id/.test(pp) && /orderRef: p\.razorpay_order_id \|\| p\.id/.test(pp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
