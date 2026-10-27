// A65-L -- Razorpay Route: order payload, linked-account payloads and status, onboarding, webhook, source + migration guardrails. No database, no network.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { fileURLToPath } from "node:url";
import * as R from "../../lib/domain/route.js";
import { onboardLinkedAccount, refreshLinkedAccount } from "../../lib/payments/route-onboarding.js";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };

// ---- order payload
const L = "11111111-2222-3333-4444-555555555555", ACC = "acc_TestSeller0001";
const ob = R.buildOrderBody({ amountPaise: 49950, listingId: L, userId: "u1", accountId: ACC, now: 1700000000000 });
check("L01 the order carries exactly one transfer: the seller's account, 100% of the amount, INR, not on hold", ob.transfers.length === 1 && ob.transfers[0].account === ACC && ob.transfers[0].amount === 49950 && ob.transfers[0].currency === "INR" && ob.transfers[0].on_hold === false && ob.amount === 49950);
check("L02 no platform share: the transfers sum to the order amount", ob.transfers.reduce((a, t) => a + t.amount, 0) === ob.amount);
check("L03 an ordinary order has no transfers; receipt <= 40 chars", !("transfers" in R.buildOrderBody({ amountPaise: 100, listingId: L, userId: "u" })) && ob.receipt.length <= 40);
check("L04 bad amount / bad account are refused", (() => { try { R.buildOrderBody({ amountPaise: 0, listingId: L, userId: "u" }); return false; } catch { return true; } })() && (() => { try { R.buildOrderBody({ amountPaise: 5, listingId: L, userId: "u", accountId: "x" }); return false; } catch { return true; } })());

// ---- form + payloads
const good = { legalName: "Asha Rao", email: "Asha@Example.com", phone: "+91 98765-43210", pan: "abcde1234f", beneficiaryName: "Asha Rao", accountNumber: "1234 5678 9012", ifsc: "hdfc0001234", street: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001" };
const v = R.validateRouteForm(good);
check("L10 a good form validates and is normalised (PAN/IFSC upper, phone 10 digits, email lower)", v.ok && v.value.pan === "ABCDE1234F" && v.value.ifsc === "HDFC0001234" && v.value.phone === "9876543210" && v.value.email === "asha@example.com" && v.value.accountNumber === "123456789012", v);
check("L11 each bad field is reported", ["legalName", "email", "phone", "pan", "accountNumber", "ifsc", "postalCode"].every((k) => R.validateRouteForm({ ...good, [k]: "x" }).errors[k]));
const acct = R.buildLinkedAccountPayload(v.value, { referenceId: "aaaa-bbbb" });
check("L12 linked-account payload: type route, individual, PAN under legal_info, registered address in IN", acct.type === "route" && acct.business_type === "individual" && acct.legal_info.pan === "ABCDE1234F" && acct.legal_business_name === "Asha Rao" && acct.profile.addresses.registered.country === "IN" && acct.profile.addresses.registered.postal_code === "560001" && acct.email === "asha@example.com" && acct.phone === "9876543210");
const set = R.buildSettlementPayload(v.value);
check("L13 settlement payload: beneficiary name, account number, IFSC", set.settlements.account_number === "123456789012" && set.settlements.ifsc_code === "HDFC0001234" && set.settlements.beneficiary_name === "Asha Rao" && R.buildProductRequestPayload().product_name === "route");
check("L14 status mapping: activated only for activated/instantly_activated; unknown is never activated", R.mapRazorpayStatus("activated") === "activated" && R.mapRazorpayStatus("instantly_activated") === "activated" && R.mapRazorpayStatus("activated_kyc_pending") === "under_review" && R.mapRazorpayStatus("needs_clarification") === "needs_clarification" && R.mapRazorpayStatus("suspended") === "suspended" && R.mapRazorpayStatus("rejected") === "rejected" && R.mapRazorpayStatus("???") === "created" && R.mapRazorpayStatus(undefined) === "created");
check("L15 account.* events map; others do not", R.routeStatusForAccountEvent("account.activated") === "activated" && R.routeStatusForAccountEvent("account.under_review") === "under_review" && R.routeStatusForAccountEvent("account.created") === null && R.routeStatusForAccountEvent("payment.captured") === null);
check("L16 wording exists for every status", [...R.ROUTE_STATUSES, null].every((s) => R.describeRouteStatus(s).label.length > 2));

// ---- Razorpay client (fake fetch)
const calls = [];
const fakeFetch = (script) => async (url, init) => { calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization }); const r = script(url, init); return { ok: r.status < 400, status: r.status, json: async () => r.json }; };
const mk = (script) => createRazorpayClient({ keyId: "rzp_test_x", keySecret: "sec", fetchImpl: fakeFetch(script) });
const happy = (url, init) => {
  if (url.endsWith("/v2/accounts") && init.method === "POST") return { status: 200, json: { id: ACC, status: "created" } };
  if (url.endsWith("/products") && init.method === "POST") return { status: 200, json: { id: "acc_prd_TestProd001", activation_status: "needs_clarification" } };
  if (init.method === "PATCH") return { status: 200, json: { activation_status: "activated", requirements: [] } };
  if (url.includes("/v1/payments/")) return { status: 200, json: { id: "pay_1", order_id: "order_1", amount: 49950, currency: "INR", status: "captured", method: "upi" } };
  if (url.includes("/v2/accounts/")) return { status: 200, json: { status: "activated" } };
  return { status: 404, json: {} };
};
const saved = [];
const db = { routeSaveAccount: async (a) => { saved.push(a); return { ready: a.routeStatus === "activated" }; } };
const r1 = await onboardLinkedAccount({ db, rzp: mk(happy), userId: "u1", value: v.value });
check("L20 onboarding: POST /v2/accounts -> POST products -> PATCH products/:id, in that order, with Basic auth from the test keys", calls.map((c) => `${c.method} ${c.url.replace("https://api.razorpay.com", "")}`).join() === "POST /v2/accounts,POST /v2/accounts/acc_TestSeller0001/products,PATCH /v2/accounts/acc_TestSeller0001/products/acc_prd_TestProd001" && calls.every((c) => c.auth === "Basic " + Buffer.from("rzp_test_x:sec").toString("base64")));
check("L21 the account id is saved as 'created' BEFORE the later steps, then the final status is saved", saved[0].routeStatus === "created" && saved[0].accountId === ACC && saved.at(-1).routeStatus === "activated" && r1.ok && r1.ready === true);
check("L22 the PAN and bank details go only to Razorpay: they are never passed to our database", !JSON.stringify(saved).match(/ABCDE1234F|123456789012|HDFC0001234/));
calls.length = 0; saved.length = 0;
const r2 = await onboardLinkedAccount({ db, rzp: mk(happy), userId: "u1", value: v.value, existingAccountId: ACC });
check("L23 resuming with an existing account does not create a second account", !calls.some((c) => c.method === "POST" && c.url.endsWith("/v2/accounts")) && r2.ok);
const failing = (url, init) => (init.method === "PATCH" ? { status: 400, json: { error: { code: "BAD_REQUEST_ERROR", description: "IFSC invalid" } } } : happy(url, init));
saved.length = 0;
const r3 = await onboardLinkedAccount({ db, rzp: mk(failing), userId: "u1", value: v.value });
check("L24 a Razorpay rejection at the settlement step is returned, the account id stays saved (resumable), nothing is marked activated", !r3.ok && r3.step === "settlement_details" && r3.retryable === false && saved.length === 1 && saved[0].routeStatus === "created");
const down = (url, init) => (init.method === "POST" && url.endsWith("/v2/accounts") ? { status: 503, json: {} } : happy(url, init));
const r4 = await onboardLinkedAccount({ db, rzp: mk(down), userId: "u1", value: v.value });
check("L25 a Razorpay outage is retryable", !r4.ok && r4.retryable === true);
saved.length = 0;
const rf = await refreshLinkedAccount({ db, rzp: mk(happy), userId: "u1", accountId: ACC });
check("L26 refresh reads the account status and saves it", rf.ok && rf.routeStatus === "activated" && saved[0].routeStatus === "activated");
const pay = await mk(happy).fetchPayment("pay_1");
check("L27 fetchPayment returns order id, amount and status; a malformed body is not trusted", pay.ok && pay.payment.orderId === "order_1" && pay.payment.status === "captured" && (await mk(() => ({ status: 200, json: { id: "pay_1" } })).fetchPayment("pay_1")).ok === false);

// ---- webhook
const SECRET = "whsec_test";
const sign = (b) => crypto.createHmac("sha256", SECRET).update(b).digest("hex");
function mkDb() {
  const log = { finished: [], fulfil: [], transfer: [], account: [] };
  return { log,
    beginEvent: async () => "new",
    finishEvent: async (a) => { log.finished.push(a); },
    fulfil: async (a) => { log.fulfil.push(a); return { outcome: "fulfilled", purchase_id: "p1" }; },
    fulfilRouteTransfer: async (a) => { log.transfer.push(a); return { outcome: log.transfer.length > 1 ? "already_fulfilled" : "fulfilled", purchase_id: "p1" }; },
    routeUpdateAccount: async (a) => { log.account.push(a); return { outcome: a.accountId === "acc_Unknown00001" ? "unknown_account" : "updated" }; },
  };
}
const send = (body, { db = mkDb(), rzp = mk(happy), sig, eventId = "evt_1" } = {}) => {
  const raw = JSON.stringify(body);
  return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sig ?? sign(raw), "x-razorpay-event-id": eventId }, secret: SECRET, feePct: 0.18, db, rzp }).then((r) => ({ ...r, db }));
};
const transferEv = { event: "transfer.processed", payload: { transfer: { entity: { id: "trf_Test0000001", source: "pay_1", recipient: ACC, amount: 49950, currency: "INR", status: "processed" } } } };
const t1 = await send(transferEv);
check("L30 transfer.processed: payment looked up, then fulfilled through the Route function with the account and the 100% amount", t1.status === 200 && t1.json.outcome === "fulfilled" && t1.db.log.transfer[0].orderId === "order_1" && t1.db.log.transfer[0].paymentId === "pay_1" && t1.db.log.transfer[0].accountId === ACC && t1.db.log.transfer[0].transferPaise === 49950 && t1.db.log.transfer[0].amountPaise === 49950);
check("L31 a bad signature is refused (400) and nothing is touched", (await send(transferEv, { sig: "0".repeat(64) })).status === 400);
const dbx = mkDb(); await send(transferEv, { db: dbx }); const t2 = await send(transferEv, { db: dbx, eventId: "evt_2" });
check("L32 a second transfer event for the same payment is already_fulfilled (idempotent)", t2.json.outcome === "already_fulfilled");
const dup = await handleRazorpayWebhook({ rawBody: JSON.stringify(transferEv), headers: { "x-razorpay-signature": sign(JSON.stringify(transferEv)), "x-razorpay-event-id": "e" }, secret: SECRET, feePct: 0.18, db: { ...mkDb(), beginEvent: async () => "duplicate" }, rzp: mk(happy) });
check("L33 a redelivered event is answered 200 duplicate without fulfilling again", dup.status === 200 && dup.json.duplicate === true);
const notCap = await send(transferEv, { rzp: mk((u) => ({ status: 200, json: { id: "pay_1", order_id: "o", amount: 1, currency: "INR", status: "authorized" } })) });
check("L34 a payment that is not captured is flagged for review, not fulfilled", notCap.json.needsReview === true && notCap.db.log.transfer.length === 0);
const lookup503 = await send(transferEv, { rzp: mk(() => ({ status: 503, json: {} })) });
check("L35 if Razorpay cannot be reached the webhook answers 500 so Razorpay retries", lookup503.status === 500);
check("L36 a malformed transfer (wrong source / non-INR) is flagged for review", (await send({ event: "transfer.processed", payload: { transfer: { entity: { id: "trf_Test0000001", source: "order_1", recipient: ACC, amount: 5, currency: "INR" } } } })).json.needsReview === true);
const cap = { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 49950, currency: "INR", status: "captured", method: "upi" } } } };
const c1 = await send(cap);
check("L37 payment.captured still fulfils through fulfil_captured_payment (the database makes it 'route' and fee 0)", c1.json.outcome === "fulfilled" && c1.db.log.fulfil[0].orderId === "order_1");
const a1 = await send({ event: "account.activated", payload: { account: { entity: { id: ACC, status: "activated" } } } });
check("L38 account.activated updates the seller's status", a1.status === 200 && a1.db.log.account[0].routeStatus === "activated" && a1.db.log.account[0].accountId === ACC);
const a2 = await send({ event: "account.activated", payload: { account: { entity: { id: "acc_Unknown00001" } } } });
check("L39 an account we do not know is ignored", a2.status === 200 && a2.db.log.finished.at(-1).status === "ignored");

// ---- source guardrails
const co = read("app/api/razorpay/create-order/route.js"), wh = read("app/api/razorpay/webhook/route.js"), ob2 = read("app/api/razorpay/route-onboard/route.js");
check("L40 create-order resolves the seller's account on the SERVER, from the database, behind the flag, and records it", /route_checkout_enabled/.test(co) && /routeCheckoutTarget/.test(co) && /buildOrderBody/.test(co) && /recordRoutePaymentOrder/.test(co) && !/accountId[^\n]*request\.json|request\.json[^\n]*account/.test(co));
check("L41 with the Route flag ON the direct-UPI 403 no longer blocks orders; with it OFF the direct 403 is unchanged", /directOnly === true && routeOn !== true/.test(co));
check("L42 the webhook route passes the Razorpay client so transfer.processed can look up the payment", /createRazorpayClient/.test(wh) && /rzp:/.test(wh));
check("L43 the onboarding API is server-only, needs login and the flag, and never echoes PAN or bank details", /route_checkout_enabled/.test(ob2) && /auth\.getUser/.test(ob2) && !/console\./.test(ob2) && !/json\([^)]*\b(body|form\.value)\b/.test(ob2.replace(/const json = .*\n/, "")));
const lc = read("components/ListingCheckout.jsx"), code = lc.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
check("L44 ListingCheckout: Route ON switches the direct (UTR) flow off and keeps the standard Razorpay modal", /isRouteCheckoutEnabled\(supabase\)/.test(code) && /routeOn \? false : await isDirectCheckoutEnabled/.test(code) && /new window\.Razorpay/.test(code) && !/utr/i.test(code.replace(/DirectUpiCheckout/g, "")));
const sp = read("app/sell/page.jsx");
check("L45 the sell page is gated on an activated linked account when Route is ON, and maps the database refusal", /routeStatus\.route_enabled/.test(sp) && /!routeStatus\.ready\) return <RouteGate/.test(sp) && /route_account_required/.test(sp));
const pp = read("app/sell/payout/page.jsx"), form = read("components/RouteOnboardingForm.jsx");
check("L46 /sell/payout shows the linked-account form when Route is ON; the form asks for the requested fields and posts to our own API", /RouteOnboardingForm/.test(pp) && /route_enabled/.test(pp) && ["legalName", "email", "phone", "pan", "beneficiaryName", "accountNumber", "ifsc"].every((k) => form.includes(`id="${k}"`)) && /\/api\/razorpay\/route-onboard/.test(form) && !/api\.razorpay\.com/.test(form));
check("L47 no component or page imports the service client or the Razorpay client", ![sp, pp, form, lc].some((s) => /service-client|razorpay-client/.test(s)));

// ---- migration guardrails
const MIG = "20261026100000_razorpay_route_checkout.sql";
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const m = read(`supabase/migrations/${MIG}`), low = m.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").toLowerCase();
check("L50 the migration sorts right after the instant-unlock migration", migs.indexOf(MIG) === migs.indexOf("20261025100000_direct_upi_instant_unlock.sql") + 1);
check("L51 additive: no table, column, function or data is dropped, deleted or truncated", !/\b(drop\s+(table|column|function|trigger|constraint|index)|delete\s+from|truncate)\b/.test(low));
check("L52 it does not switch any flag: no insert/update on private.feature_flags", !/feature_flags/.test(low.replace(/private\.is_route_transfers_enabled/g, "")));
check("L53 the write functions are service_role only (revoked from anon/authenticated)", ["route_save_linked_account", "route_update_account_status", "route_checkout_target", "record_route_payment_order", "fulfil_route_transfer"].every((f) => new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated`).test(low) && new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role`).test(low)));
check("L54 every security definer function pins search_path", (m.match(/security definer/gi) || []).length === (m.match(/set search_path = ''/g) || []).length);
check("L55 Route purchases are recorded as 'route' with fee 0 by the database, and excluded from settlement", /then 'route' else v_method/.test(m) && /then 0 else round\(v_amount \* p_fee_pct, 2\)/.test(m) && /payment_method is distinct from 'route'/.test(m) && /payment_method is distinct from 'direct_upi'/.test(m));
check("L56 the new error code CM080 is used and CM079 stays the listing-gate code", /CM080/.test(m) && /CM079/.test(m));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
