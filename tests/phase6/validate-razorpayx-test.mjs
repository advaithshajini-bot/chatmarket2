#!/usr/bin/env node
// tests/phase6/validate-razorpayx-test.mjs
// RazorpayX TEST-mode shape validation (runbook phase6_upi_payouts_golive.md section 3, items 1-4).
// Zero dependencies (Node 18+). Never prints keys. Refuses LIVE keys. Sends only to the RazorpayX API.
//
//   RZP_KEY_ID=rzp_test_xxx RZP_KEY_SECRET=xxx RAZORPAYX_ACCOUNT_NUMBER=xxxx \
//     node tests/phase6/validate-razorpayx-test.mjs
//   Optional: TEST_VPA (default success@razorpay), RZP_BASE_URL (for a local mock), RAW=0 to hide raw JSON.
//
// It creates REAL test-mode objects (1 contact, 1 fund account, 2 payouts of Rs 1.00). Test mode only.

import crypto from "node:crypto";

const { RZP_KEY_ID, RZP_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER: ACCT } = process.env;
const BASE = process.env.RZP_BASE_URL || "https://api.razorpay.com";
const VPA = process.env.TEST_VPA || "success@razorpay";
const RAW = process.env.RAW !== "0";

if (!RZP_KEY_ID || !RZP_KEY_SECRET || !ACCT) {
  console.error("Set RZP_KEY_ID, RZP_KEY_SECRET and RAZORPAYX_ACCOUNT_NUMBER (names only; values never printed).");
  process.exit(2);
}
if (!RZP_KEY_ID.startsWith("rzp_test_") && !process.env.RZP_BASE_URL) {
  console.error("Refusing to run: key id does not start with rzp_test_. This script is for TEST mode only.");
  process.exit(2);
}
const AUTH = "Basic " + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
};
const note = (s) => console.log(`  NOTE  ${s}`);

async function call(label, method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null, text = null;
  try { text = await res.text(); json = JSON.parse(text); } catch { /* non-JSON */ }
  console.log(`\n--- ${label}\n${method} ${path.replace(ACCT, "<ACCT>")}  ->  HTTP ${res.status}`);
  if (RAW) console.log(JSON.stringify(json ?? text, null, 2));
  return { status: res.status, ok: res.ok, json };
}

const uuid = () => crypto.randomUUID();
const money = 100; // paise, the minimum

// ---- A1 contact -------------------------------------------------------------------------------------------
console.log("\n=== A1  POST /v1/contacts");
const c = await call("A1 create contact", "POST", "/v1/contacts", { name: "Test Seller", type: "vendor", reference_id: `t-${uuid()}`.slice(0, 40) });
const contactId = c.json?.id;
check("A1 contact created (2xx)", c.ok);
check("A1 id matches /^cont_[A-Za-z0-9]{6,40}$/ (what the client enforces)", /^cont_[A-Za-z0-9]{6,40}$/.test(contactId ?? ""), contactId);
if (!c.ok) { console.error("Cannot continue without a contact."); process.exit(1); }

// ---- A2 fund account --------------------------------------------------------------------------------------
console.log("\n=== A2  POST /v1/fund_accounts (vpa)");
const f = await call("A2 create VPA fund account", "POST", "/v1/fund_accounts", { contact_id: contactId, account_type: "vpa", vpa: { address: VPA } });
const faId = f.json?.id;
check("A2 fund account created (2xx)", f.ok);
check("A2 id matches /^fa_[A-Za-z0-9]{6,40}$/", /^fa_[A-Za-z0-9]{6,40}$/.test(faId ?? ""), faId);
check("A2 response echoes vpa.address (client compares it, lower-cased)", (f.json?.vpa?.address ?? "").toLowerCase() === VPA.toLowerCase(), f.json?.vpa?.address);
if (!f.ok) { console.error("Cannot continue without a fund account."); process.exit(1); }

// ---- A3 payout + idempotency ------------------------------------------------------------------------------
const payoutBody = (ref) => ({
  account_number: ACCT, fund_account_id: faId, amount: money, currency: "INR", mode: "UPI", purpose: "payout",
  queue_if_low_balance: true, reference_id: ref, narration: "Chatmarket payout", notes: { purpose: "validation" },
});
const KNOWN = ["queued", "pending", "processing", "processed", "rejected", "cancelled", "reversed", "failed"];

console.log("\n=== A3  POST /v1/payouts + idempotency");
const ref1 = uuid(); // 36 chars: a first-attempt payout_key
const p1 = await call("A3 payout #1", "POST", "/v1/payouts", payoutBody(ref1), { "X-Payout-Idempotency": ref1 });
check("A3 payout created (2xx)", p1.ok);
check("A3 id matches /^pout_[A-Za-z0-9]{6,40}$/", /^pout_[A-Za-z0-9]{6,40}$/.test(p1.json?.id ?? ""), p1.json?.id);
check("A3 status is one the client maps", KNOWN.includes(p1.json?.status), p1.json?.status);
check("A3 amount and currency echoed", p1.json?.amount === money && p1.json?.currency === "INR");
check("A3 reference_id echoed exactly", p1.json?.reference_id === ref1);
check("A3 fund_account_id echoed", p1.json?.fund_account_id === faId);
note(`utr=${p1.json?.utr ?? "null"}  fees=${p1.json?.fees ?? "null"}  status_details=${JSON.stringify(p1.json?.status_details ?? null)}`);

const p1b = await call("A3b replay SAME idempotency key and body", "POST", "/v1/payouts", payoutBody(ref1), { "X-Payout-Idempotency": ref1 });
check("A3b replay returned the SAME payout id (no second payout)", p1b.ok && p1b.json?.id === p1.json?.id, `${p1b.json?.id} vs ${p1.json?.id}`);
note("How long the key is honoured is not testable in one run. Check the docs, or re-run this replay hours later.");

const ref2 = `${uuid()}-v2`; // 39 chars: the admin-retry key shape
const p2 = await call("A3c payout #2 with a 39-char reference_id (admin retry shape)", "POST", "/v1/payouts", payoutBody(ref2), { "X-Payout-Idempotency": ref2 });
check(`A3c ${ref2.length}-char reference_id accepted`, p2.ok && p2.json?.reference_id === ref2, p2.json?.error?.description ?? "");
if (p2.ok && p2.json?.id === p1.json?.id) check("A3c different key produced a DIFFERENT payout", false, "same id returned");

// ---- A4 reference_id filter -------------------------------------------------------------------------------
console.log("\n=== A4  GET /v1/payouts?account_number&reference_id  (the retry path depends on this)");
const list = (ref) => call(`A4 list reference_id=${ref}`, "GET", `/v1/payouts?account_number=${encodeURIComponent(ACCT)}&reference_id=${encodeURIComponent(ref)}`);
const l1 = await list(ref1);
const items1 = Array.isArray(l1.json?.items) ? l1.json.items : null;
check("A4 list response has an items[] array", !!items1);
check("A4 filter by ref1 returns exactly 1 item", items1?.length === 1, `got ${items1?.length}`);
check("A4 that item is payout #1 with reference_id == ref1", items1?.[0]?.id === p1.json?.id && items1?.[0]?.reference_id === ref1);

const l2 = await list(ref2);
const items2 = Array.isArray(l2.json?.items) ? l2.json.items : null;
check("A4 filter by 39-char ref2 returns exactly 1 item", items2?.length === 1, `got ${items2?.length}`);

const none = uuid();
const l0 = await list(none);
const items0 = Array.isArray(l0.json?.items) ? l0.json.items : null;
check("A4 filter by a NON-EXISTENT reference returns 0 items", items0?.length === 0, `got ${items0?.length}`);
const filterWorks = items1?.length === 1 && items0?.length === 0;

const all = await call("A4 control: unfiltered list", "GET", `/v1/payouts?account_number=${encodeURIComponent(ACCT)}&count=100`);
note(`unfiltered count (page of up to 100) = ${Array.isArray(all.json?.items) ? all.json.items.length : "n/a"}`);
note(`payout list item keys: ${items1?.[0] ? Object.keys(items1[0]).join(",") : "n/a"}`);

// optional extra filters, informational only: they decide which fallback is available
const byFa = await call("A4 info: filter by fund_account_id", "GET", `/v1/payouts?account_number=${encodeURIComponent(ACCT)}&fund_account_id=${faId}`);
note(`fund_account_id filter -> ${Array.isArray(byFa.json?.items) ? byFa.json.items.length + " item(s)" : "HTTP " + byFa.status}`);
const now = Math.floor(Date.now() / 1000);
const byTime = await call("A4 info: from/to window", "GET", `/v1/payouts?account_number=${encodeURIComponent(ACCT)}&from=${now - 3600}&to=${now + 60}`);
note(`from/to window -> ${Array.isArray(byTime.json?.items) ? byTime.json.items.length + " item(s)" : "HTTP " + byTime.status}`);

// ---- summary ----------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n=== SUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (!filterWorks) {
  console.log("!! reference_id filter does NOT behave as the retry path assumes. Do not enable lookup-first as written; use the fallback in the handoff.");
}
for (const r of failed) console.log(`   FAIL: ${r.name}`);
console.log("\nStill to check by hand: webhooks (payout.* events + signature secret), wrong-VPA behaviour (try an invalid address), zero-balance 'queued'.");
process.exit(failed.length ? 1 : 0);
