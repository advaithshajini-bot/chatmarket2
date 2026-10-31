// A59 -- Tier 2 clean-up guardrails: Route transfers and the reconciliation sweep are RETIRED; refunds, disputes tracking and the
// monthly settlement are untouched. Static + no database + no network. (The 5.2 / 5.2c tables and functions stay in the database;
// m52-db, m52c-db and m55-db still cover them.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
import { computeWebhookSignature } from "../../lib/payments/webhook-signature.js";
import { DISPUTE_ACTIONS, syncDisputeForPurchase, runDisputeSweep } from "../../lib/payments/disputes.js";

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
const APP = ["app", "lib", "components"].flatMap((d) => walk(d)).concat(exists("middleware.js") ? ["middleware.js"] : []);

// ---------------------------------------------------------------- deleted
for (const [id, f] of [["T01", "lib/payments/transfers.js"], ["T02", "lib/payments/transfer-events.js"], ["T03", "lib/payments/sweep-handler.js"], ["T04", "lib/payments/reconcile.js"], ["T05", "app/api/payments/transfers/sweep/route.js"]]) {
  check(`${id} ${f} is deleted`, !exists(f));
}
check("T06 the sweep route directory is gone entirely", !exists("app/api/payments/transfers"));
check("T07 the Route-only test suites and mutation runners are deleted", ["tests/phase5/m52-logic.test.mjs", "tests/phase5/m52-integration.test.mjs", "tests/phase5/scratch/run-mutations-52.mjs", "tests/phase5/scratch/run-mutations-52c.mjs"].every((f) => !exists(f)));

// ---------------------------------------------------------------- kept (the user's decision)
check("T10 refund-events.js and disputes.js are KEPT", exists("lib/payments/refund-events.js") && exists("lib/payments/disputes.js"));
check("T11 the dispute sync handler and its route are KEPT, and both components still call the sync route", exists("lib/payments/dispute-sync-handler.js") && exists("app/api/payments/disputes/sync/route.js") && /\/api\/payments\/disputes\/sync/.test(read("components/PurchaseHistoryClient.jsx")) && /\/api\/payments\/disputes\/sync/.test(read("components/AdminDisputesClient.jsx")));
check("T12 the DB suites for the dormant ledgers are KEPT (m52-db, m52c-db, m55-db)", ["m52-db", "m52c-db", "m55-db"].every((n) => exists(`tests/phase5/${n}.test.mjs`)));
check("T13 schedule_sweep_stale_runs.sql (Phase 3 agent runs) is KEPT where it was", exists("supabase/manual/schedule_sweep_stale_runs.sql"));

// ---------------------------------------------------------------- no references remain
const RETIRED = /transfers\.js|transfer-events|sweep-handler|reconcile\.js|\/reconcile"|createTransferForPurchase|runTransferSweep|pollTransfer|runReconciliation|normalizeTransferEntity|extractTransferEvent|TRANSFER_EVENT_RE|createTransfer\b|listPaymentTransfers|fetchTransfer|setTransferHold|reverseTransfer|planTransfer|applyTransferEvent|recordTransferFailure|listTransferWork|prepareTransferHold|claimDisputeAction|finishDisputeAction|payments\/transfers\/sweep/;
const hits = APP.filter((f) => RETIRED.test(read(f)));
check("T20 no app, lib or component file references any retired Route / sweep function or module", hits.length === 0, hits);
check("T21 CRON_SECRET is read nowhere in app code (nothing is scheduled)", !APP.some((f) => /CRON_SECRET/.test(read(f))));
check("T22 there is no vercel.json cron, and no pg_cron job in any migration calls the old sweep", !exists("vercel.json") && !fs.readdirSync(path.join(root, "supabase/migrations")).some((f) => /payments\/transfers\/sweep/.test(read(`supabase/migrations/${f}`))));
check("T23 no app code reads or sets phase5_route_transfers (database kill switch only)", !APP.some((f) => /phase5_route_transfers/.test(read(f))));

// ---------------------------------------------------------------- the client and db wrapper
const rzp = createRazorpayClient({ keyId: "k", keySecret: "s", fetchImpl: async () => { throw new Error("no network in this test"); } });
check("T30 the Razorpay client has refund methods plus the Route linked-account/payment-lookup methods, and NO transfer-creation, hold, reverse or payout method", Object.keys(rzp).sort().join() === "createLinkedAccount,createRefund,fetchLinkedAccount,fetchPayment,listPaymentRefunds,requestRouteProduct,updateRouteProduct", Object.keys(rzp));
const db = createPaymentsDb({ rpc: async () => ({ data: null, error: null }) });
check("T31 the db wrapper has no transfer or dispute-action method, and keeps payments, disputes list and refunds",
  ["planTransfer", "applyTransferEvent", "recordTransferFailure", "listTransferWork", "prepareTransferHold", "claimDisputeAction", "finishDisputeAction"].every((m) => db[m] === undefined)
  && ["recordPaymentOrder", "beginEvent", "finishEvent", "fulfil", "listDisputeWork", "planRefund", "applyRefundEvent", "recordRefundFailure"].every((m) => typeof db[m] === "function"), Object.keys(db));
check("T32 disputes.js performs exactly one action now: refund", DISPUTE_ACTIONS.join() === "refund", DISPUTE_ACTIONS);
check("T33 the Razorpay client never calls a Route URL", !/\/v1\/transfers|\/transfers`|\/reversals/.test(read("lib/payments/razorpay-client.js")));
check("T34 the webhook and disputes-sync routes build the client from the key id and secret only", /createRazorpayClient\(\{ keyId, keySecret \}\)/.test(read("app/api/payments/disputes/sync/route.js")) && /createRazorpayClient\(\{ keyId: process\.env\.RAZORPAY_KEY_ID, keySecret: process\.env\.RAZORPAY_KEY_SECRET \}\)/.test(read("app/api/razorpay/webhook/route.js")));

// ---------------------------------------------------------------- behaviour
const SECRET = "whsec_test_only_not_real";
const calls = [];
const rec = new Proxy({}, { get: (_, name) => async (a) => { calls.push([name, a]); return name === "beginEvent" ? "new" : { outcome: "applied" }; } });
const send = (event, payload, id, db2 = rec) => {
  const rawBody = JSON.stringify({ event, payload });
  return handleRazorpayWebhook({ rawBody, secret: SECRET, feePct: 10, db: db2, headers: { "x-razorpay-signature": computeWebhookSignature(rawBody, SECRET), "x-razorpay-event-id": id } });
};
const t = await send("transfer.reversed", { transfer: { entity: { id: "trf_ABCDEF123456", source: "pay_1", amount: 100, transfer_status: "reversed" } } }, "evt_t1");
check("T40 a transfer.* webhook other than transfer.processed (the Route fulfilment event, see m65) is acknowledged and IGNORED: 200, ignored, nothing applied", t.status === 200 && t.json.ignored === true && calls.some(([n, a]) => n === "finishEvent" && a.status === "ignored") && !calls.some(([n]) => /Transfer|fulfil|Refund/.test(n)), { t, calls: calls.map((c) => c[0]) });
calls.length = 0;
const r = await send("refund.processed", { refund: { entity: { id: "rfnd_ABCDEF123456", payment_id: "pay_1", amount: 49900, currency: "INR", status: "processed", notes: { purchase_id: "11111111-2222-4333-8444-555555555555" } } } }, "evt_r1");
check("T41 a refund.* webhook is still applied (disputes and refunds keep tracking)", r.status === 200 && r.json.outcome === "refund_applied" && calls.some(([n]) => n === "applyRefundEvent"), r);
calls.length = 0;
const pay = { payment: { entity: { id: "pay_T2", order_id: "order_T2", amount: 5000, currency: "INR", status: "captured", method: "upi" } } };
const p = await send("payment.captured", pay, "evt_p1", new Proxy({}, { get: (_, name) => async (a) => { calls.push([name, a]); return name === "beginEvent" ? "new" : { outcome: "fulfilled", purchase_id: "11111111-1111-1111-1111-111111111111" }; } }));
check("T42 payment fulfilment is unchanged: fulfilled, and nothing runs after it", p.status === 200 && p.json.outcome === "fulfilled" && calls.some(([n]) => n === "fulfil") && !calls.some(([n]) => /Transfer|Payout/.test(n)), p);

// a dispute with nothing due makes no Razorpay call at all
const fx = { log: [] };
const rz = createRazorpayClient({ keyId: "k", keySecret: "s", fetchImpl: async (...a) => { fx.log.push(a); throw new Error("must not be called"); } });
const idle = await syncDisputeForPurchase({ db: { planRefund: async () => ({ outcome: "not_needed" }) }, rzp: rz, purchaseId: "11111111-2222-4333-8444-555555555555" });
check("T43 a dispute with no refund due makes no Razorpay call", idle.length === 0 && fx.log.length === 0, idle);
const sw = await runDisputeSweep({ db: { listDisputeWork: async () => [{ kind: "hold", purchase_id: "x" }, { kind: "reverse", purchase_id: "y" }] }, rzp: rz, limit: 5 });
check("T44 if the database ever asked for a retired action (hold / reverse), the sweep SKIPS it and never calls Razorpay", sw.items === 2 && sw.skipped === 2 && fx.log.length === 0, sw);

// ---------------------------------------------------------------- docs
const arch = ["phase5_2_review_golive.md", "phase5_2c_review_golive.md", "phase5_2c_schedule_sweep.sql", "phase6_route_validation_runbook.md", "phase6_flag_rollout.md", "phase6_upi_payouts_golive.md"];
check("T50 the six obsolete runbooks are in supabase/manual/archive/ and no longer in supabase/manual/", arch.every((f) => exists(`supabase/manual/archive/${f}`) && !exists(`supabase/manual/${f}`)));
check("T51 the archive has a README that says never to schedule the old sweep", exists("supabase/manual/archive/README.md") && /Never schedule/i.test(read("supabase/manual/archive/README.md")));
check("T52 the monthly settlement runbook is still in place", exists("supabase/manual/phase7_monthly_settlement_runbook.md"));

// ---------------------------------------------------------------- not touched
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
check("T60 no migration was added or changed: nothing newer than the 5.7 migration exists, and the 5.2 / 5.2c / 5.4 ones remain", migs.at(-1) <= "20261031100000_media_and_listing_updates.sql" && ["20261018100000_add_vpa_payouts.sql", "20261014100000_add_dispute_actions.sql"].every((f) => migs.includes(f)));
check("T61 the monthly-settlement code imports nothing from lib/payments", ["lib/domain/admin-settlement.js", "lib/domain/seller-settlement.js", "components/AdminSettlementTab.jsx", "components/SellerPayoutPanel.jsx"].every((f) => !/payments\//.test(read(f))));

console.log(`\nA59: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
