// A52c-L -- unit tests for the dispute / refund code that needs no database (fake Razorpay + fake db).
// Run:  node tests/phase5/m52c-logic.test.mjs
import crypto from "node:crypto";
import { normalizeRefundEntity, extractRefundEvent, REFUND_EVENT_RE } from "../../lib/payments/refund-events.js";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { syncDisputeForPurchase, runDisputeSweep, performDisputeAction, DISPUTE_ACTIONS } from "../../lib/payments/disputes.js";
import { handleDisputeSync } from "../../lib/payments/dispute-sync-handler.js";
import { runReconciliation } from "../../lib/payments/reconcile.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
import { createFakeRazorpay } from "./fake-razorpay.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const PID = "11111111-2222-4333-8444-555555555555";
const client = (fake) => createRazorpayClient({ keyId: "k", keySecret: "sekret", fetchImpl: fake.fetch, timeoutMs: 200 });
const rent = (o = {}) => ({ id: "rfnd_ABCDEF123456", entity: "refund", payment_id: "pay_1", amount: 49900, currency: "INR", status: "processed", notes: { purchase_id: PID }, ...o });

// ---------------------------------------------------------------- refund entity
{
  const r = normalizeRefundEntity(rent());
  check("M01 a valid refund entity normalises", r && r.id === "rfnd_ABCDEF123456" && r.paymentId === "pay_1" && r.amountPaise === 49900 && r.status === "processed" && r.purchaseId === PID, r);
  check("M02 'created' is read as pending", normalizeRefundEntity(rent({ status: "created" })).status === "pending");
  const bad = { null: null, str: "x", "wrong prefix": rent({ id: "pay_ABCDEF123456" }), "amount 0": rent({ amount: 0 }), "amount float": rent({ amount: 1.5 }), USD: rent({ currency: "USD" }), "unknown status": rent({ status: "weird" }) };
  for (const [k, v] of Object.entries(bad)) check(`M03 rejects ${k}`, normalizeRefundEntity(v) === null);
  check("M04 notes with a non-uuid purchase id give purchaseId null; missing payment id is null", normalizeRefundEntity(rent({ notes: { purchase_id: "x" }, payment_id: undefined })).purchaseId === null && normalizeRefundEntity(rent({ payment_id: undefined })).paymentId === null);
  check("M05 extractRefundEvent reads payload.refund.entity and created_at", extractRefundEvent({ created_at: 1800000000, payload: { refund: { entity: rent() } } }).eventAt === 1800000000 && extractRefundEvent({ payload: {} }) === null);
  check("M06 REFUND_EVENT_RE accepts refund.<name> only", REFUND_EVENT_RE.test("refund.processed") && REFUND_EVENT_RE.test("refund.created") && !REFUND_EVENT_RE.test("refund.") && !REFUND_EVENT_RE.test("payment.refund") && !REFUND_EVENT_RE.test("refund.Processed"));
}

// ---------------------------------------------------------------- client: reversal / refunds
{
  const f = createFakeRazorpay();
  f.seed({ id: "trf_ABCDEF123456", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 1000, currency: "INR", notes: {}, on_hold: true, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0 });
  const c = client(f);
  const rev = await c.reverseTransfer("trf_ABCDEF123456", 1000);
  check("N01 reverseTransfer POSTs {amount} to /v1/transfers/:id/reversals and returns ok", rev.ok === true && f.log.at(-1).method === "POST" && f.log.at(-1).path === "/v1/transfers/trf_ABCDEF123456/reversals" && f.log.at(-1).body.amount === 1000, rev);
  const over = await c.reverseTransfer("trf_ABCDEF123456", 5);
  check("N02 an over-reversal (400) is NOT retryable", over.ok === false && over.retryable === false && over.status === 400, over);
  for (const [fault, retry] of [["500", true], ["429", true], ["network", true], ["timeout_before", true], ["400", false]]) {
    const f2 = createFakeRazorpay(); f2.rfaults.push(fault); f2.seed({ id: "trf_ABCDEF123456", entity: "transfer", source: "p", recipient: "acc_TestSeller001", amount: 10, amount_reversed: 0 });
    const r = await client(f2).reverseTransfer("trf_ABCDEF123456", 10);
    check(`N03 reversal fault '${fault}' -> retryable=${retry}`, r.ok === false && r.retryable === retry, r);
  }
  const f3 = createFakeRazorpay();
  const made = await client(f3).createRefund({ paymentId: "pay_1", amountPaise: 49900, notes: { purchase_id: PID } });
  check("N04 createRefund POSTs {amount, notes} to /v1/payments/:id/refund and normalises the answer", made.ok && made.refund.amountPaise === 49900 && made.refund.status === "pending" && f3.log.at(-1).path === "/v1/payments/pay_1/refund" && f3.log.at(-1).body.notes.purchase_id === PID, made);
  const listed = await client(f3).listPaymentRefunds("pay_1");
  check("N05 listPaymentRefunds returns the payment's refunds", listed.ok && listed.refunds.length === 1 && listed.unreadable === 0, listed);
  f3.seedRefund({ id: "bogus", entity: "refund", payment_id: "pay_1", amount: -1 });
  const l2 = await client(f3).listPaymentRefunds("pay_1");
  check("N06 unreadable refund items are counted, not dropped silently", l2.ok && l2.unreadable === 1, l2);
  const f4 = createFakeRazorpay(); f4.refaults.push("garbage");
  const g = await client(f4).createRefund({ paymentId: "pay_1", amountPaise: 1 });
  check("N07 a refund answer that is not a refund is a retryable bad_response", g.ok === false && g.retryable === true && g.code === "bad_response", g);
  const f5 = createFakeRazorpay(); f5.refaults.push("400");
  const e = await client(f5).createRefund({ paymentId: "pay_1", amountPaise: 1 });
  check("N08 secrets never appear in any result", !JSON.stringify([e, g, over, rev]).includes("sekret"));
}

// ---------------------------------------------------------------- db wrapper contract
{
  const calls = [];
  const db = createPaymentsDb({ rpc: async (fn, args) => { calls.push([fn, args]); return { data: { outcome: "ok" }, error: null }; } });
  await db.finishDisputeAction({ purchaseId: PID, action: "hold", ok: true });
  check("N10 finishDisputeAction ok: p_retryable is null (not false), p_ok true", calls.at(-1)[1].p_ok === true && calls.at(-1)[1].p_retryable === null, calls.at(-1));
  await db.finishDisputeAction({ purchaseId: PID, action: "hold", ok: false, retryable: true, error: "x" });
  check("N11 finishDisputeAction failure: retryable passed through", calls.at(-1)[1].p_ok === false && calls.at(-1)[1].p_retryable === true);
  await db.claimDisputeAction({ purchaseId: PID, action: "reverse" });
  check("N12 claimDisputeAction maps names", calls.at(-1)[0] === "claim_dispute_action" && calls.at(-1)[1].p_action === "reverse" && calls.at(-1)[1].p_purchase_id === PID);
  await db.applyRefundEvent({ refundId: "rfnd_ABCDEF123456", purchaseId: PID, status: "pending", amountPaise: 1, paymentId: "p", eventAt: 5, eventId: "e" });
  check("N13 applyRefundEvent maps every field", JSON.stringify(Object.keys(calls.at(-1)[1])) === JSON.stringify(["p_refund_id", "p_purchase_id", "p_status", "p_amount_paise", "p_payment_id", "p_event_at", "p_event_id"]));
  const bad = createPaymentsDb({ rpc: async () => ({ data: null, error: { message: "down", code: "XX000" } }) });
  let threw = null; try { await bad.planRefund({ purchaseId: PID }); } catch (x) { threw = x; }
  check("N14 db errors throw", threw?.code === "XX000");
}

// ---------------------------------------------------------------- orchestration with a scripted db
function scriptedDb(script = {}) {
  const calls = [];
  const rec = (n, v) => async (a) => { calls.push([n, a]); const x = script[n] ?? v; return typeof x === "function" ? x(a) : x; };
  return {
    calls,
    claimDisputeAction: rec("claim", { outcome: "not_needed" }), finishDisputeAction: rec("finish", (a) => ({ outcome: a.ok ? "ok" : a.retryable ? "retry_scheduled" : "needs_review" })),
    planRefund: rec("plan", { outcome: "not_needed" }), applyRefundEvent: rec("applyRefund", { outcome: "applied" }), recordRefundFailure: rec("refundFail", (a) => ({ outcome: a.retryable ? "retry_scheduled" : "failed" })),
    applyTransferEvent: rec("applyTransfer", { outcome: "applied" }), listDisputeWork: rec("list", []),
    listTransferWork: async () => [], listVpaPayoutWork: async () => [], planTransfer: async () => ({ outcome: "not_needed" }), recordTransferFailure: async () => ({}),
  };
}
const trfEntity = (o = {}) => ({ id: "trf_ABCDEF123456", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 40918, currency: "INR", notes: { purchase_id: PID }, on_hold: true, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0, ...o });
{
  const f = createFakeRazorpay(); f.seed(trfEntity());
  const db = scriptedDb({ claim: (a) => (a.action === "hold" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" }) });
  const r = await syncDisputeForPurchase({ db, rzp: client(f), purchaseId: PID });
  check("P01 hold: PATCH on_hold true with NO end date, then finish ok", r[0]?.outcome === "done" && f.log.at(-1).method === "PATCH" && f.log.at(-1).body.on_hold === true && !("on_hold_until" in f.log.at(-1).body)
    && db.calls.find((c) => c[0] === "finish")[1].ok === true, f.log);
  const f2 = createFakeRazorpay(); f2.seed(trfEntity()); f2.pfaults.push("500");
  const r2 = await syncDisputeForPurchase({ db: scriptedDb({ claim: (a) => (a.action === "hold" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" }) }), rzp: client(f2), purchaseId: PID });
  check("P02 a failed PATCH is reported as a retryable failure (not success)", r2[0]?.outcome === "retry_scheduled");
  const db3 = scriptedDb({ claim: (a) => (a.action === "hold" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" }) });
  const f3 = createFakeRazorpay(); f3.seed(trfEntity()); f3.pfaults.push("400");
  await syncDisputeForPurchase({ db: db3, rzp: client(f3), purchaseId: PID });
  const fin = db3.calls.find((c) => c[0] === "finish")[1];
  check("P03 a 400 is reported NON-retryable with the Razorpay reason", fin.ok === false && fin.retryable === false && /BAD_REQUEST/.test(fin.error), fin);
}
{
  const f = createFakeRazorpay(); f.seed(trfEntity());
  const db = scriptedDb({ claim: (a) => (a.action === "release" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456", on_hold: true, hold_until_epoch: 1800000000 } : { outcome: "not_needed" }) });
  const r = await syncDisputeForPurchase({ db, rzp: client(f), purchaseId: PID });
  const fin = db.calls.find((c) => c[0] === "finish")[1];
  check("P10 release: PATCHes what the DATABASE said (restore the window) and reports the same hold state", r[0]?.outcome === "done" && f.log.at(-1).body.on_hold === true && f.log.at(-1).body.on_hold_until === 1800000000 && fin.onHold === true && fin.holdUntilEpoch === 1800000000, { body: f.log.at(-1).body, fin });
  const f2 = createFakeRazorpay(); f2.seed(trfEntity());
  const db2 = scriptedDb({ claim: (a) => (a.action === "release" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456", on_hold: false, hold_until_epoch: null } : { outcome: "not_needed" }) });
  await syncDisputeForPurchase({ db: db2, rzp: client(f2), purchaseId: PID });
  check("P11 release with the window over: on_hold false", f2.log.at(-1).body.on_hold === false && !("on_hold_until" in f2.log.at(-1).body));
}
{
  const db = scriptedDb({ claim: (a) => (a.action === "flag" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" }) });
  const f = createFakeRazorpay();
  const r = await syncDisputeForPurchase({ db, rzp: client(f), purchaseId: PID });
  const fin = db.calls.find((c) => c[0] === "finish")[1];
  check("P12 flag: parks for review without calling Razorpay", r[0]?.outcome === "needs_review" && f.log.length === 0 && fin.ok === false && fin.retryable === false && /after_settlement/.test(fin.error), fin);
}
{
  // reverse: Razorpay's own numbers decide the amount
  const f = createFakeRazorpay(); f.seed(trfEntity({ amount_reversed: 900 }));
  const db = scriptedDb({ claim: (a) => (a.action === "reverse" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456", amount_paise: 40918, amount_reversed_paise: 0 } : { outcome: "not_needed" }) });
  const r = await syncDisputeForPurchase({ db, rzp: client(f), purchaseId: PID });
  const rev = f.log.find((l) => /reversals$/.test(l.path));
  check("P20 reverse: only the REMAINING amount per Razorpay is reversed (40918 - 900), even if our ledger said 0", rev?.body.amount === 40018 && r[0]?.outcome === "done", { rev: rev?.body, r });
  const fin = db.calls.find((c) => c[0] === "finish")[1];
  check("P21 reverse applies the fetched transfer to the ledger, then finishes ok", db.calls.some((c) => c[0] === "applyTransfer" && c[1].status === "reversed" && c[1].amountReversedPaise === 40918) && fin.ok === true);
  const f2 = createFakeRazorpay(); f2.seed(trfEntity({ amount_reversed: 40918, transfer_status: "reversed" }));
  const db2 = scriptedDb({ claim: (a) => (a.action === "reverse" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456", amount_paise: 40918, amount_reversed_paise: 0 } : { outcome: "not_needed" }) });
  const r2 = await syncDisputeForPurchase({ db: db2, rzp: client(f2), purchaseId: PID });
  check("P22 already fully reversed at Razorpay: NO reversal request is sent", !f2.log.some((l) => /reversals$/.test(l.path)) && r2[0]?.outcome === "done");
  const f3 = createFakeRazorpay(); f3.seed(trfEntity()); f3.rfaults.push("400");
  const db3 = scriptedDb({ claim: (a) => (a.action === "reverse" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456", amount_paise: 40918, amount_reversed_paise: 0 } : { outcome: "not_needed" }) });
  const r3 = await syncDisputeForPurchase({ db: db3, rzp: client(f3), purchaseId: PID });
  check("P23 a refused reversal is parked (non-retryable) and the loop stops", r3.length === 1 && r3[0].outcome === "needs_review" && db3.calls.find((c) => c[0] === "finish")[1].retryable === false);
  const f4 = createFakeRazorpay(); f4.seed(trfEntity({ id: "trf_ABCDEF123456" }));
  const db4 = scriptedDb({ claim: (a) => (a.action === "reverse" ? { outcome: "claimed", razorpay_transfer_id: "trf_NoSuchTrf0001", amount_paise: 1, amount_reversed_paise: 0 } : { outcome: "not_needed" }) });
  const r4 = await syncDisputeForPurchase({ db: db4, rzp: client(f4), purchaseId: PID });
  check("P24 a transfer Razorpay does not know: reported, not thrown", r4[0]?.outcome === "needs_review");
}
{
  // refund: always looks first
  const claimed = { outcome: "claimed", payment_id: "pay_1", amount_paise: 49900, attempts: 1 };
  const f = createFakeRazorpay();
  const db = scriptedDb({ plan: claimed });
  const r = await performDisputeAction({ kind: "refund", db, rzp: client(f), purchaseId: PID });
  check("P30 refund: LIST first, then create, then record", r.outcome === "created" && f.log[0].method === "GET" && f.log[1].method === "POST" && db.calls.at(-1)[0] === "applyRefund" && db.calls.at(-1)[1].amountPaise === 49900, f.log.map((l) => l.method));
  const f2 = createFakeRazorpay(); f2.seedRefund(rent({ status: "pending", notes: {} }));
  const db2 = scriptedDb({ plan: claimed });
  const r2 = await performDisputeAction({ kind: "refund", db: db2, rzp: client(f2), purchaseId: PID });
  check("P31 an existing full-amount refund (e.g. from the dashboard) is adopted: no POST", r2.outcome === "adopted" && !f2.log.some((l) => l.method === "POST"));
  const f3 = createFakeRazorpay(); f3.seedRefund(rent({ id: "rfnd_FailedOne0001", status: "failed", notes: {} }));
  const r3 = await performDisputeAction({ kind: "refund", db: scriptedDb({ plan: claimed }), rzp: client(f3), purchaseId: PID });
  check("P32 a previous FAILED refund does not block a new one", r3.outcome === "created");
  const f4 = createFakeRazorpay(); f4.seedRefund(rent({ amount: 100, status: "processed", notes: {} }));
  const db4 = scriptedDb({ plan: claimed });
  const r4 = await performDisputeAction({ kind: "refund", db: db4, rzp: client(f4), purchaseId: PID });
  check("P33 a partial existing refund: failed, non-retryable, nothing created", r4.outcome === "failed" && db4.calls.find((c) => c[0] === "refundFail")[1].retryable === false && !f4.log.some((l) => l.method === "POST"));
  const f5 = createFakeRazorpay(); f5.seedRefund(rent({ id: "rfnd_BadItem00001", amount: -1 }));
  const db5 = scriptedDb({ plan: claimed });
  const r5 = await performDisputeAction({ kind: "refund", db: db5, rzp: client(f5), purchaseId: PID });
  check("P34 an unreadable item in the existing-refund list stops the refund (retry later)", db5.calls.find((c) => c[0] === "refundFail")[1].retryable === true && !f5.log.some((l) => l.method === "POST"));
  const f6 = createFakeRazorpay(); f6.refaults.push("amount_mismatch");
  const db6 = scriptedDb({ plan: claimed });
  await performDisputeAction({ kind: "refund", db: db6, rzp: client(f6), purchaseId: PID });
  check("P35 a created refund with another amount is not recorded as ours", !db6.calls.some((c) => c[0] === "applyRefund") && /response_mismatch/.test(db6.calls.find((c) => c[0] === "refundFail")[1].error));
  const db7 = scriptedDb({ plan: { outcome: "disabled" } });
  const f7 = createFakeRazorpay();
  const r7 = await performDisputeAction({ kind: "refund", db: db7, rzp: client(f7), purchaseId: PID });
  check("P36 flag off / not needed: no Razorpay call at all", r7.outcome === "disabled" && f7.log.length === 0);
  const db8 = scriptedDb({ plan: () => { throw new Error("db down"); } });
  let t8 = null; try { await performDisputeAction({ kind: "refund", db: db8, rzp: client(createFakeRazorpay()), purchaseId: PID }); } catch (e) { t8 = e; }
  check("P37 a db error while claiming propagates (the sweep isolates it)", t8 !== null);
  const f9 = createFakeRazorpay(); f9.refaults.push("timeout_after");
  const db9 = scriptedDb({ plan: claimed });
  const r9 = await performDisputeAction({ kind: "refund", db: db9, rzp: client(f9), purchaseId: PID });
  check("P38 a timeout after create is retryable and records nothing as created", r9.outcome === "retry_scheduled" && !db9.calls.some((c) => c[0] === "applyRefund"));
  const r10 = await performDisputeAction({ kind: "nuke", db, rzp: client(f), purchaseId: PID });
  check("P39 an unknown action kind does nothing", r10.outcome === "unknown_kind" && DISPUTE_ACTIONS.join() === "hold,flag,release,reverse,refund");
}
{
  // a db exception AFTER a claim must not leave the lease dangling: it is reported retryable
  const f = createFakeRazorpay(); f.seed(trfEntity());
  const calls = [];
  const db = scriptedDb({ claim: (a) => (a.action === "hold" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" }) });
  let n = 0; const orig = db.finishDisputeAction;
  db.finishDisputeAction = async (a) => { calls.push(a); if (++n === 1) throw new Error("db blip"); return { outcome: "retry_scheduled" }; };
  const r = await syncDisputeForPurchase({ db, rzp: client(f), purchaseId: PID });
  check("P40 if reporting success fails, the failure is reported retryable instead of leaving the lease", calls.length === 2 && calls[1].ok === false && calls[1].retryable === true && r[0].outcome === "retry_scheduled", { calls, r });
}
{
  // sweep
  const f = createFakeRazorpay(); f.seed(trfEntity());
  const claimHold = (a) => (a.action === "hold" ? { outcome: "claimed", razorpay_transfer_id: "trf_ABCDEF123456" } : { outcome: "not_needed" });
  const db = scriptedDb({ list: [{ kind: "hold", purchase_id: PID }, { kind: "nuke", purchase_id: PID }, { kind: "hold", purchase_id: PID }], claim: (a) => { if (db.calls.filter((c) => c[0] === "claim").length === 2) throw new Error("boom"); return claimHold(a); } });
  const c = await runDisputeSweep({ db, rzp: client(f), limit: 20 });
  check("P50 the dispute sweep isolates items (an unknown kind and a db error do not stop the rest)", c.items === 3 && c.skipped >= 1 && (c.errors + c.done) >= 1, c);
  const c2 = await runDisputeSweep({ db: scriptedDb({ list: [{ kind: "hold", purchase_id: PID }] }), rzp: client(f), budgetMs: -1 });
  check("P51 a zero time budget stops before any work", c2.timeBudgetHit === true && c2.items === 0, c2);
  const c3 = await runReconciliation({ db: scriptedDb({ list: [] }), rzp: client(f) });
  check("P52 runReconciliation returns the transfer counts plus a 'disputes' block", c3.disputes && c3.disputes.items === 0 && "created" in c3, c3);
}

// ---------------------------------------------------------------- the browser-triggered sync handler
{
  let synced = [];
  const ok = { userId: "u1", purchaseId: PID, canSeeDispute: async () => true, sync: async (p) => { synced.push(p); } };
  const r = await handleDisputeSync(ok);
  check("Q01 a signed-in party with a visible dispute triggers the sync; the answer carries no detail", r.status === 200 && JSON.stringify(r.json) === '{"ok":true}' && synced[0] === PID, r);
  check("Q02 not signed in -> 401, nothing synced", (await handleDisputeSync({ ...ok, userId: null, sync: async () => { throw new Error("no"); } })).status === 401);
  for (const bad of [undefined, null, 5, "x", "11111111-2222-4333-8444-55555555555", `${PID}'; drop table x;--`]) {
    check(`Q03 invalid purchase id ${JSON.stringify(bad)} -> 400`, (await handleDisputeSync({ ...ok, purchaseId: bad })).status === 400);
  }
  synced = [];
  const nf = await handleDisputeSync({ ...ok, canSeeDispute: async () => false });
  check("Q04 a dispute the caller cannot see (RLS) -> 404 and NOTHING is synced", nf.status === 404 && synced.length === 0);
  const tmp = await handleDisputeSync({ ...ok, canSeeDispute: async () => { throw new Error("db"); } });
  check("Q05 a lookup error -> 500 (retry), nothing synced", tmp.status === 500 && synced.length === 0);
  const sf = await handleDisputeSync({ ...ok, sync: async () => { throw new Error("razorpay down"); } });
  check("Q06 a failing sync still answers 200 (the sweep finishes it) and leaks nothing", sf.status === 200 && JSON.stringify(sf.json) === '{"ok":true}');
}

// ---------------------------------------------------------------- webhook: refund.* events
{
  const SECRET = "whsec_test_secret_value";
  const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
  const whDb = (o = {}) => { const calls = []; return { calls,
    beginEvent: async (a) => { calls.push(["begin", a]); return o.begin ?? "new"; }, finishEvent: async (a) => { calls.push(["finish", a]); },
    applyRefundEvent: async (a) => { calls.push(["applyRefund", a]); if (o.applyThrows) throw Object.assign(new Error("db"), { code: "XX000" }); return o.apply ?? { outcome: "applied" }; },
    fulfil: async () => { throw new Error("must not be called"); }, applyTransferEvent: async () => { throw new Error("must not be called"); } }; };
  const send = (body, db) => { const raw = JSON.stringify(body); return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": "evt_r1" }, secret: SECRET, feePct: 0.18, db }); };
  const ev = { event: "refund.processed", created_at: 1800000100, payload: { refund: { entity: rent() } } };
  const db = whDb(); const r = await send(ev, db);
  const a = db.calls.find((c) => c[0] === "applyRefund")?.[1];
  check("R01 refund.processed -> applyRefundEvent with the event id, answered 200 'refund_applied'", r.status === 200 && r.json.outcome === "refund_applied" && a?.refundId === "rfnd_ABCDEF123456" && a.purchaseId === PID && a.eventId === "evt_r1" && a.eventAt === 1800000100 && a.status === "processed", { r, a });
  check("R02 the payment id from the refund is recorded on the event row", db.calls.find((c) => c[0] === "begin")[1].paymentId === "pay_1");
  const dup = await send(ev, whDb({ begin: "duplicate" }));
  check("R03 duplicate delivery -> 200 duplicate, nothing applied", dup.json.duplicate === true);
  const dbm = whDb(); const bad = await send({ event: "refund.processed", payload: { refund: { entity: { id: "bad" } } } }, dbm);
  check("R04 an unreadable refund entity -> needs_review, 200, nothing applied", bad.status === 200 && bad.json.needsReview === true && dbm.calls.find((c) => c[0] === "finish")[1].status === "needs_review" && !dbm.calls.some((c) => c[0] === "applyRefund"));
  const dbe = whDb({ applyThrows: true }); const er = await send(ev, dbe);
  check("R05 a db error -> the event is marked failed and Razorpay gets 500 (it will retry)", er.status === 500 && dbe.calls.find((c) => c[0] === "finish")[1].status === "failed");
  const un = await send({ ...ev, event: "refund.created" }, whDb({ apply: { outcome: "unknown_refund" } }));
  check("R06 any refund.<name> event is accepted; unknown_refund is reported in the answer", un.status === 200 && un.json.outcome === "refund_unknown_refund");
}

console.log(`\nA52c-L: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
