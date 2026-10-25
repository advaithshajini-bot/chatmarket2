// A63-L -- direct UPI payments: helpers, screens and migration guardrails. No database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import * as D from "../../lib/domain/direct-upi.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };

// ---- UTR
check("L01 UTR: 12 digits ok, spaces ignored", D.validateUtr("4123 4567 8901").ok && D.validateUtr("412345678901").value === "412345678901");
check("L02 UTR: empty is silent; letters / short / long give messages", D.validateUtr("").error === null && !D.validateUtr("").ok && !!D.validateUtr("12345678901a").error && !!D.validateUtr("123").error && !!D.validateUtr("1234567890123").error);
// ---- UPI link
const uri = D.buildUpiUri({ vpa: "asha@okhdfcbank", payeeName: "Asha & Co", amountPaise: 49950, listingId: "11111111-2222-3333-4444-555555555555" });
check("L03 the UPI link carries payee, amount with 2 decimals, INR and a short note", uri === "upi://pay?pa=asha@okhdfcbank&pn=Asha%20%26%20Co&am=499.50&cu=INR&tn=Chatmarket-11111111", uri);
check("L04 a bad UPI ID or amount gives no link", D.buildUpiUri({ vpa: "bad", amountPaise: 100, listingId: "x" }) === "" && D.buildUpiUri({ vpa: "a1@ybl", amountPaise: 0, listingId: "x" }) === "" && D.buildUpiUri({ vpa: "a1@ybl", amountPaise: 1.5, listingId: "x" }) === "");
check("L05 a payee name cannot inject extra parameters", !D.buildUpiUri({ vpa: "a1@ybl", payeeName: "x&am=1", amountPaise: 500, listingId: "z" }).includes("&am=1&"));
check("L06 app links reuse the same payload", D.UPI_APPS.map((a) => D.appLink(a.id, uri)).every((l) => l.includes("pa=asha@okhdfcbank&pn=") && !l.startsWith("upi://")) && D.appLink("nope", uri) === "");
// ---- identity
const good = { first: "Asha", last: "Rao", email: "A@B.com", phone: "+91 98765 43210", address: "12 MG Road", pan: "abcde1234f", idType: "aadhaar", idNumber: "2345 6789 0123" };
const gv = D.validateIdentity(good);
check("L10 a good form validates and is normalised like the database", gv.ok && gv.values.phone === "9876543210" && gv.values.pan === "ABCDE1234F" && gv.values.email === "a@b.com" && gv.values.idNumber === "234567890123" && gv.values.country === "India", gv);
for (const [k, o] of [["first", { first: "" }], ["last", { last: "R2" }], ["email", { email: "x" }], ["phone", { phone: "123" }], ["address", { address: "ab" }], ["pan", { pan: "ABCDE12345" }], ["idType", { idType: "x" }], ["idNumber", { idNumber: "123" }]])
  check(`L11 invalid ${k} is reported on that field`, !!D.validateIdentity({ ...good, ...o }).errors[k] && !D.validateIdentity({ ...good, ...o }).ok);
check("L12 each ID type has its own number format", D.validateIdentity({ ...good, idType: "voter_id", idNumber: "ABC1234567" }).ok && D.validateIdentity({ ...good, idType: "passport", idNumber: "K1234567" }).ok && !D.validateIdentity({ ...good, idType: "passport", idNumber: "ABC1234567" }).ok);
check("L13 phone forms 0… and 91… normalise", D.normalizePhone("09876543210") === "9876543210" && D.normalizePhone("919876543210") === "9876543210");
// ---- wording
check("L20 every database refusal code has plain wording", ["identity_required", "invalid_pan", "invalid_utr", "claim_already_pending", "utr_already_used", "seller_not_ready", "upi_in_cooldown", "claim_not_pending", "buyer_already_owns", "feature_off", "own_listing"].every((c) => D.explainDirectError({ message: c }).length > 10 && !D.explainDirectError({ message: c }).includes("_")));
check("L21 unknown errors never leak raw text", !D.explainDirectError({ message: "relation x does not exist" }).includes("relation"));
check("L22 claim wording: waiting, overdue, rejected(+reason), expired, confirmed", D.describeClaim({ status: "pending" }).label.includes("submitted") && D.describeClaim({ status: "pending", overdue: true }).label.includes("Still waiting") && D.describeClaim({ status: "rejected", reject_reason: "No money" }).detail.includes("No money") && D.describeClaim({ status: "expired" }) && D.describeClaim({ status: "confirmed" }).tone === "green" && D.describeClaim(null) === null);
check("L23 the cooldown reason names the unlock time and never a UPI ID", /reopens after /.test(D.describeTargetReason({ reason: "upi_in_cooldown", unlocks_at: "2026-11-01T10:00:00Z" })) && !D.describeTargetReason({ reason: "upi_in_cooldown", vpa: "a@b" }).includes("@"));
const mk = (res) => ({ rpc: async () => res });
check("L24 loaders never throw and fail closed", (await D.isDirectCheckoutEnabled(mk({ data: null, error: { message: "x" } }))) === false && (await D.isDirectCheckoutEnabled({ rpc: async () => { throw new Error("net"); } })) === false && (await D.getDirectTarget(mk({ data: null, error: {} }), "x")).enabled === false && (await D.getSellerDirectClaims(mk({ data: null, error: {} }))).claims.length === 0 && (await D.getMyDirectSellerStatus(mk({ data: null, error: {} }))).flag_on === false);

// ---- screens and routes
const checkout = read("components/DirectUpiCheckout.jsx"), lc = read("components/ListingCheckout.jsx");
check("L30 ListingCheckout switches to the direct flow only when the flag RPC says so, and keeps the Razorpay path otherwise", /isDirectCheckoutEnabled\(supabase\)/.test(lc) && /direct \? \(\s*<DirectUpiCheckout/.test(lc) && /Pay with/.test(lc) && /api\/razorpay\/create-order/.test(lc));
check("L31 the direct checkout shows a QR code and mobile app buttons, asks for the UTR, and submits through the database function", /QRCode\.toDataURL/.test(checkout) && /UPI_APPS\.map/.test(checkout) && /submit_direct_payment_claim/.test(checkout) && /validateUtr/.test(checkout));
check("L32 the price comes from the server lookup, never from the page", /target\.amount_paise/.test(checkout) && !/listing\.price/.test(checkout.replace(/\/\/.*$/gm, "")));
check("L33 the checkout never talks to Razorpay", !/razorpay/i.test(checkout));
check("L34 the create-order route refuses when direct checkout is ON, before it calls Razorpay", /direct_upi_checkout_enabled/.test(read("app/api/razorpay/create-order/route.js")) && read("app/api/razorpay/create-order/route.js").indexOf("direct_upi_checkout_enabled") < read("app/api/razorpay/create-order/route.js").indexOf("api.razorpay.com"));
const prof = read("app/sell/profile/page.jsx"), pay = read("app/sell/payout/page.jsx"), sell = read("app/sell/page.jsx");
check("L35 the identity page calls set_seller_identity_details, then moves on to /sell/payout", /set_seller_identity_details/.test(prof) && /router\.push\("\/sell\/payout"\)/.test(prof));
check("L36 the identity page never sends the ID number anywhere except that function, and keeps none after saving", (prof.match(/idNumber/g) || []).length > 0 && !/localStorage|sessionStorage|console\./.test(prof) && /idNumber: ""/.test(prof));
check("L37 /sell/payout redirects to the identity page (with the notice) when step 1 is missing", /identity_complete/.test(pay) && /\/sell\/profile\?notice=identity/.test(pay));
check("L38 the sell page shows the identity gate before the UPI gate, and maps the database refusal", sell.indexOf("<IdentityGate />") > -1 && sell.indexOf("<IdentityGate />") < sell.indexOf("<UpiGate />") && /CM079/.test(sell));
const panel = read("components/SellerClaimsPanel.jsx");
check("L39 the seller panel confirms and rejects through the database functions, asks before confirming, and shows buyer, amount, UTR", /confirm_direct_payment_claim/.test(panel) && /reject_direct_payment_claim/.test(panel) && /window\.confirm/.test(panel) && /c\.utr/.test(panel) && /buyer_name/.test(panel));
check("L40 the earnings page includes the panel and treats direct sales as fee-free", /<SellerClaimsPanel \/>/.test(read("app/sell/earnings/page.jsx")) && /direct_upi/.test(read("app/sell/earnings/page.jsx")));
check("L41 the new qrcode package is a declared dependency", /"qrcode"/.test(read("package.json")));

// ---- migration
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const MIG = "20261024100000_add_direct_upi_checkout.sql";
const m = read(`supabase/migrations/${MIG}`), code = m.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"), low = code.toLowerCase();
check("L50 the migration sorts last and the flag is seeded OFF", migs.at(-1) === MIG && /insert into private\.feature_flags \(name, enabled\) values \('direct_upi_checkout', false\)/.test(code));
check("L51 additive: no drop / delete / truncate / alter-column; only the two known functions are replaced", !/\b(drop|delete from|truncate)\b/.test(low) && !/alter table[^;]*alter column/.test(low) && [...code.matchAll(/create or replace function ([\w.]+)/g)].map((x) => x[1]).sort().join() === "private.settlement_eligible,public.set_my_payout_vpa");
check("L52 every function is SECURITY DEFINER with an empty search_path", [...code.matchAll(/create (?:or replace )?function[\s\S]*?\n\$\$;/g)].every((f) => /security definer/i.test(f[0]) && /set search_path = ''/i.test(f[0])));
check("L53 the full government-ID number is never written to a column or the audit log", !/govt_id_number|id_number\b[^;]*insert/i.test(code.replace(/p_id_number|v_num/g, "")) && /right\(v_num, 4\)/.test(code));
check("L54 settlement ignores direct sales", /payment_method is distinct from 'direct_upi'/.test(code));
check("L55 no payment-provider call or secret anywhere in the migration", !/razorpay_key|http_post|net\.http/.test(low));
check("L56 the new tables are RLS-protected with no direct write grant", /alter table public\.seller_identity_details enable row level security/.test(code) && /alter table public\.direct_payment_claims enable row level security/.test(code) && !/grant (insert|update|delete)/.test(low));

console.log(`\nA63-L: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
