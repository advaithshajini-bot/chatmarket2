// A58 -- Tier 1 clean-up guardrails: the RazorpayX / instant-UPI-payout code is RETIRED and nothing in the app can reach it.
// Static + no database + no network. (The 5.4 tables and functions stay in the database; m55-db.test.mjs still covers them.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
import { computeWebhookSignature } from "../../lib/payments/webhook-signature.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const exists = (p) => fs.existsSync(path.join(root, p));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".next", ".git"].includes(e.name)) walk(rel, acc); }
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(e.name)) acc.push(rel);
  }
  return acc;
}
const APP = ["app", "lib", "components", "middleware.js"].flatMap((d) => (fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory() ? walk(d) : [d]));

// ---------------------------------------------------------------- the files are gone
check("T01 lib/payments/vpa-payouts.js is deleted", !exists("lib/payments/vpa-payouts.js"));
check("T02 lib/payments/payout-events.js is deleted", !exists("lib/payments/payout-events.js"));
check("T03 the obsolete m55 logic + integration suites and the m55 mutation runner are deleted", !exists("tests/phase5/m55-logic.test.mjs") && !exists("tests/phase5/m55-integration.test.mjs") && !exists("tests/phase5/scratch/run-mutations-55.mjs"));
check("T04 the m55 DATABASE suite is kept (the 5.4 tables and functions still exist in the database)", exists("tests/phase5/m55-db.test.mjs"));

// ---------------------------------------------------------------- nothing in the app mentions the retired code
const RETIRED = /vpa-payouts|payout-events|runPayoutSweep|payoutPurchase|pollPayout|normalizePayoutEntity|extractPayoutEvent|PAYOUT_EVENT_RE|createVpaPayout|createVpaFundAccount|createContact|fetchPayout|listPayoutsByReference|planVpaPayout|recordVpaFundAccount|applyVpaPayoutEvent|recordVpaPayoutFailure|listVpaPayoutWork/;
const hits = APP.filter((f) => RETIRED.test(read(f)));
check("T05 no app, lib or component file references any retired payout function or module", hits.length === 0, hits);
const envHits = APP.filter((f) => /RAZORPAYX_ACCOUNT_NUMBER|PAYOUT_PROXY_URL/.test(read(f)));
check("T06 no app code reads RAZORPAYX_ACCOUNT_NUMBER or PAYOUT_PROXY_URL (no RazorpayX env vars are needed)", envHits.length === 0, envHits);
check("T07 the routes that still talk to Razorpay build the client from the key id and secret only (no account number)", ["app/api/razorpay/webhook/route.js", "app/api/payments/disputes/sync/route.js"].every((f) => !/accountNumber|RAZORPAYX/.test(read(f))) && /createRazorpayClient\(\{ keyId, keySecret \}\)/.test(read("app/api/payments/disputes/sync/route.js")));

// ---------------------------------------------------------------- the client and db wrapper
const rzp = createRazorpayClient({ keyId: "k", keySecret: "s", fetchImpl: async () => { throw new Error("no network in this test"); } });
const gone = ["createContact", "createVpaFundAccount", "createVpaPayout", "fetchPayout", "listPayoutsByReference"];
check("T10 the Razorpay client has no payout / contact / fund-account method", gone.every((m) => rzp[m] === undefined), Object.keys(rzp));
check("T11 the refund methods are intact (the Route methods went in the Tier 2 clean-up: see m59-tier2.test.mjs)", ["listPaymentRefunds", "createRefund"].every((m) => typeof rzp[m] === "function"));
const db = createPaymentsDb({ rpc: async () => ({ data: null, error: null }) });
check("T12 the payments db wrapper has no payout method, and keeps the payment / dispute-list / refund ones", ["planVpaPayout", "recordVpaFundAccount", "applyVpaPayoutEvent", "recordVpaPayoutFailure", "listVpaPayoutWork"].every((m) => db[m] === undefined)
  && ["recordPaymentOrder", "beginEvent", "finishEvent", "fulfil", "planRefund", "applyRefundEvent", "listDisputeWork"].every((m) => typeof db[m] === "function"));
check("T13 no code anywhere calls a payout RPC through the service client", !APP.some((f) => /plan_vpa_payout|record_vpa_fund_account|apply_vpa_payout_event|record_vpa_payout_failure|list_vpa_payout_work/.test(read(f))));

// ---------------------------------------------------------------- behaviour
const SECRET = "whsec_test_only_not_real";
function webhook(eventName, payload, db2) {
  const rawBody = JSON.stringify({ event: eventName, payload });
  return handleRazorpayWebhook({
    rawBody, secret: SECRET, feePct: 10, db: db2,
    headers: { "x-razorpay-signature": computeWebhookSignature(rawBody, SECRET), "x-razorpay-event-id": `evt_${eventName}` },
  });
}
const calls = [];
const fakeDb = new Proxy({}, { get: (_, name) => async (a) => { calls.push([name, a]); return name === "beginEvent" ? "new" : { outcome: "ok" }; } });
const r1 = await webhook("payout.processed", { payout: { entity: { id: "pout_X000001", status: "processed", amount: 100, reference_id: "p" } } }, fakeDb);
check("T20 a payout.* webhook is acknowledged and IGNORED: 200, ignored, recorded as unhandled", r1.status === 200 && r1.json.ignored === true && calls.some(([n, a]) => n === "finishEvent" && a.status === "ignored" && a.outcome === "unhandled_event"), r1);
check("T21 a payout.* webhook never reaches a payout, transfer or refund function", !calls.some(([n]) => /Vpa|Payout|Transfer|Refund|fulfil/.test(n)), calls.map((c) => c[0]));

calls.length = 0;
const pay = { payment: { entity: { id: "pay_T1", order_id: "order_T1", amount: 5000, currency: "INR", status: "captured", method: "upi" } } };
let hook = null;
const r2 = await handleRazorpayWebhook({
  rawBody: JSON.stringify({ event: "payment.captured", payload: pay }), secret: SECRET, feePct: 10,
  headers: { "x-razorpay-signature": computeWebhookSignature(JSON.stringify({ event: "payment.captured", payload: pay }), SECRET), "x-razorpay-event-id": "evt_pay" },
  db: new Proxy({}, { get: (_, name) => async (a) => { calls.push([name, a]); return name === "beginEvent" ? "new" : { outcome: "fulfilled", purchase_id: "11111111-1111-1111-1111-111111111111" }; } }),
  afterFulfil: async (a) => { hook = a; },
});
check("T22 payment fulfilment still works and still runs the afterFulfil hook", r2.status === 200 && r2.json.outcome === "fulfilled" && hook?.purchaseId === "11111111-1111-1111-1111-111111111111", r2);

// reconciliation (reconcile.js) was deleted in Tier 2; the dispute sweep itself still runs without any payout db method
const { runDisputeSweep } = await import("../../lib/payments/disputes.js");
const rec = await runDisputeSweep({ db: { listDisputeWork: async () => [] }, rzp, limit: 5, budgetMs: 1000 });
check("T23 the dispute sweep runs with no payout db method and returns plain counts", rec && rec.items === 0 && !("payouts" in rec), rec);

// ---------------------------------------------------------------- what must NOT have been touched
const migs = fs.readdirSync(path.join(root, "supabase/migrations"));
check("T30 the 5.4 payout migration is untouched and still present (the tables stay; any drop is a separate approved migration)", migs.includes("20261018100000_add_vpa_payouts.sql"));
check("T31 no new migration was added by the clean-up (only the later additive 5.6 / 5.7 milestones follow)", migs.filter((f) => f.endsWith(".sql")).sort().at(-1) <= "20261029100000_manual_bank_payouts.sql");
check("T32 the monthly-settlement code does not import anything from lib/payments", ["lib/domain/admin-settlement.js", "lib/domain/seller-settlement.js", "components/AdminSettlementTab.jsx", "components/SellerPayoutPanel.jsx"].every((f) => !/lib\/payments|payments\//.test(read(f))));
check("T33 (M68) the DB function set_my_payout_vpa is preserved (the UI no longer uses it)", /set_my_payout_vpa/.test(read("supabase/migrations/20261021100000_add_upi_cooldown.sql")) && !/set_my_payout_vpa/.test(read("app/sell/payout/page.jsx")));

console.log(`\nA58: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
