// A52c-I -- Milestone 5.2c integration (disputes): REAL Postgres (all migrations) + the REAL orchestration, db wrapper, Razorpay
// client and webhook handler + a FAKE Razorpay (fetch replacement with fault injection). No network.
// COMMITS rows (then deletes them): scratch DB only.
//   PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/m52c-integration.test.mjs
import pg from "pg";
import crypto from "node:crypto";
import { createFakeRazorpay } from "./fake-razorpay.mjs";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { createTransferForPurchase } from "../../lib/payments/transfers.js";
import { syncDisputeForPurchase, runDisputeSweep } from "../../lib/payments/disputes.js";
import { runReconciliation } from "../../lib/payments/reconcile.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";

if (!process.env.DATABASE_URL || process.env.PHASE5_CONCURRENCY_TESTS !== "1") { console.log("SKIPPED: set PHASE5_CONCURRENCY_TESTS=1 and DATABASE_URL (commits then deletes rows)."); process.exit(0); }
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}

const N_POOL = 10;
const conns = await Promise.all(Array.from({ length: N_POOL }, async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query("set role service_role"); return c; }));
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL }); await admin.connect();
const q = (sql, p) => admin.query(sql, p);
const val = async (sql, p) => (await q(sql, p)).rows[0]?.v;

// supabase-js-shaped rpc() over a pooled connection, running as service_role with named arguments
let rr = 0;
const clientFor = (conn) => ({
  rpc: async (fn, args = {}) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as v`;
    try {
      const r = await (conn ?? conns[rr++ % N_POOL]).query(sql, names.map((n) => args[n]));
      return { data: r.rows[0]?.v ?? null, error: null };
    } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
  },
});
const db = createPaymentsDb(clientFor());
const mkRzp = (fake) => createRazorpayClient({ keyId: "rzp_test_x", keySecret: "s", fetchImpl: fake.fetch, timeoutMs: 500 });

const U = { seller: "00000000-0000-0000-0000-0000000fff51", buyer: "00000000-0000-0000-0000-0000000fff52" };
const ACC = "acc_IntSellerC01";
const SECRET = "whsec_integration_test";
const TAG = "int52c_";
async function cleanup() {
  await q(`delete from public.audit_log where metadata->>'order_id' like '${TAG}%'`);
  await q(`delete from public.webhook_events where provider_event_id like '${TAG}%'`);
  await q(`delete from public.transfers where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.disputes where purchase_id in (select id from public.purchases where razorpay_payment_id like '${TAG}%')`);
  await q(`delete from public.purchases where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.payment_orders where razorpay_order_id like '${TAG}%'`);
  await q(`delete from public.listings where title = 'A52 int listing'`);
  await q(`delete from public.seller_payout_accounts where user_id = $1`, [U.seller]);
  await q(`delete from auth.users where id in ($1,$2)`, [U.seller, U.buyer]);
}
const rflag = (on) => q(`update private.feature_flags set enabled=$1 where name='phase5_auto_refunds'`, [on]);
const flag = (on) => q(`update private.feature_flags set enabled=$1 where name='phase5_route_transfers'`, [on]);
let seq = 0;
async function mkPurchase({ amount = 499, fee = 89.82, ago = "0 minutes", account = true } = {}) {
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A52 int listing','n','n',$1,'S',$2,'live') returning id`, [amount, U.seller]);
  const pay = `${TAG}pay${++seq}`;
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at)
     values ($1,$2,$3,'paid',$4,$5, now() - $6::interval) returning id`, [U.buyer, l.id, amount, pay, fee, ago]);
  return { pid: p.id, lid: l.id, pay };
}
const row = async (pid) => (await q(`select * from public.transfers where purchase_id=$1`, [pid])).rows[0];
const pstat = (pid) => val(`select transfer_status as v from public.purchases where id=$1`, [pid]);
const makeDue = (pid) => q(`update public.transfers set next_attempt_at = now() - interval '1 second', last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [pid]);
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
async function webhook(event, { id, at } = {}) {
  const raw = JSON.stringify(event);
  return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": id ?? `${TAG}evt${++seq}` }, secret: SECRET, feePct: 0.18, db, afterFulfil: undefined });
}
const trfEvent = (entity, at) => ({ event: "transfer.processed", created_at: at ?? Math.floor(Date.now() / 1000), payload: { transfer: { entity } } });

const refundRow = async (pid) => (await q(`select * from public.refunds where purchase_id=$1`, [pid])).rows[0];
const dueAction = (pid) => q(`update public.transfers set action_next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [pid]);
const dueRefund = (pid) => q(`update public.refunds set next_attempt_at = now() - interval '1 second', last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [pid]);
const dispute = (p, status) => q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c integration reason',$5)`, [p.pid, p.lid, U.buyer, U.seller, status]);
const setDispute = (p, status) => q(`update public.disputes set status=$2 where purchase_id=$1`, [p.pid, status]);
const refundPurchase = (p) => q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
const sync = (p, fake) => syncDisputeForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
async function linked(opts = {}) {            // a purchase whose transfer exists at the fake and in the ledger
  const p = await mkPurchase(opts); const fake = createFakeRazorpay();
  await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
  return { p, fake, trf: fake.created[0] };
}
const patches = (fake) => fake.log.filter((l) => l.method === "PATCH");
const reversals = (fake) => fake.log.filter((l) => l.method === "POST" && /reversals$/.test(l.path));
const refundPosts = (fake) => fake.log.filter((l) => l.method === "POST" && /\/refund$/.test(l.path));

try {
  await cleanup();
  for (const [k, u] of Object.entries(U)) await q(`insert into auth.users (id, email) values ($1,$2)`, [u, `int52c-${k}@example.invalid`]);
  await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,$2,'active')`, [U.seller, ACC]);
  await flag(true); await rflag(false);

  // ---- open dispute -> hold
  {
    const { p, fake, trf } = await linked(); await dispute(p, "open");
    const r = await sync(p, fake);
    const t = await row(p.pid);
    check("J01 open dispute: the transfer is PATCHed to an indefinite hold, ledger agrees, purchases 'held'", r[0]?.action === "hold" && r[0].outcome === "done" && patches(fake).length === 1
      && patches(fake)[0].body.on_hold === true && !("on_hold_until" in patches(fake)[0].body) && trf.on_hold === true && !trf.on_hold_until && t.on_hold && t.hold_until === null && (await pstat(p.pid)) === "held", { r, t: [t.on_hold, t.hold_until] });
    const r2 = await sync(p, fake);
    check("J02 a second sync does nothing (derived state is already satisfied): no second PATCH", r2.length === 0 && patches(fake).length === 1, r2);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "open");
    fake.pfaults.push("timeout_before");
    const r1 = await sync(p, fake);
    check("J03 PATCH timeout -> retry scheduled, ledger unchanged", r1[0]?.outcome === "retry_scheduled" && (await row(p.pid)).hold_until !== null, r1);
    check("J04 an immediate retry is held back by the backoff (no PATCH)", (await sync(p, fake)).length === 0 && patches(fake).length === 1);
    await dueAction(p.pid);
    const r2 = await sync(p, fake);
    check("J05 once due, the hold is applied", r2[0]?.outcome === "done" && (await row(p.pid)).hold_until === null);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "open");
    fake.pfaults.push("400");
    const r1 = await sync(p, fake);
    const t = await row(p.pid);
    check("J06 Razorpay REFUSES the hold (400): parked for review with the reason, never retried blindly", r1[0]?.outcome === "needs_review" && /dispute_hold/.test(t.review_reason ?? "") && (await sync(p, fake)).length === 0 && patches(fake).length === 1, { r1, rr: t.review_reason });
    const s = await runDisputeSweep({ db, rzp: mkRzp(fake) });
    check("J07 the sweep leaves a parked transfer alone", !(await db.listDisputeWork({ limit: 100 })).some((i) => i.purchase_id === p.pid) && patches(fake).length === 1, s);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "open");
    await q(`update public.transfers set status='processed', settlement_status='settled', on_hold=false, hold_until=null where purchase_id=$1`, [p.pid]);
    const r = await sync(p, fake);
    check("J08 dispute after the money SETTLED: no Razorpay call, parked as 'dispute_opened_after_settlement'", r[0]?.action === "flag" && patches(fake).length === 0 && /after_settlement/.test((await row(p.pid)).review_reason ?? ""), r);
  }

  // ---- denied -> release
  {
    const { p, fake } = await linked(); await dispute(p, "open"); await sync(p, fake);
    await setDispute(p, "resolved_denied");
    const r = await sync(p, fake);
    const t = await row(p.pid); const body = patches(fake).at(-1).body;
    check("J10 denied inside the original 48h: the timed hold is RESTORED (on_hold true with the original end), not released", r[0]?.action === "release" && body.on_hold === true && body.on_hold_until > Math.floor(Date.now() / 1000) + 47 * 3600 && t.on_hold && t.hold_until !== null, { r, body });
    check("J11 and the dispute needs nothing more", (await sync(p, fake)).length === 0);
  }
  {
    const { p, fake } = await linked({ ago: "49 hours" }); await dispute(p, "open"); await sync(p, fake);
    await setDispute(p, "resolved_denied");
    await flag(false);
    check("J12 route flag OFF: a denied dispute is NOT released", (await sync(p, fake)).length === 0 && patches(fake).length === 1);
    await flag(true);
    const r = await sync(p, fake);
    check("J13 flag ON, window passed: PATCH on_hold false (released)", r[0]?.outcome === "done" && patches(fake).at(-1).body.on_hold === false && (await row(p.pid)).on_hold === false);
  }

  // ---- refunded -> reverse -> refund
  {
    const { p, fake, trf } = await linked(); await dispute(p, "open"); await sync(p, fake);
    await setDispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const r = await sync(p, fake);
    const t = await row(p.pid); const rf = await refundRow(p.pid);
    check("J20 refunded: the transfer is reversed IN FULL, then the buyer is refunded the FULL amount, in that order", r.map((x) => x.action).join() === "reverse,refund" && reversals(fake).length === 1 && reversals(fake)[0].body.amount === 40918
      && refundPosts(fake).length === 1 && refundPosts(fake)[0].body.amount === 49900 && refundPosts(fake)[0].body.notes.purchase_id === p.pid
      && fake.log.findIndex((l) => /reversals$/.test(l.path)) < fake.log.findIndex((l) => /\/refund$/.test(l.path)), { r, rev: reversals(fake).length, rp: refundPosts(fake).length });
    check("J21 ledgers: transfer 'reversed' (purchases 'reversed'), refund 'pending' with its id", t.status === "reversed" && t.amount_reversed_paise === 40918 && (await pstat(p.pid)) === "reversed" && rf.status === "pending" && rf.razorpay_refund_id === fake.createdRefunds[0].id, { t: t.status, rf: rf?.status });
    check("J22 syncing again does nothing: no second reversal, no second refund", (await sync(p, fake)).length === 0 && reversals(fake).length === 1 && refundPosts(fake).length === 1);
    // the refund.processed webhook
    const ev = { event: "refund.processed", created_at: Math.floor(Date.now() / 1000) + 5, payload: { refund: { entity: { ...fake.createdRefunds[0], status: "processed" } } } };
    const w = await webhook(ev, { id: `${TAG}rw1` });
    check("J23 refund.processed webhook -> ledger 'processed', event processed", w.status === 200 && w.json.outcome === "refund_applied" && (await refundRow(p.pid)).status === "processed", w);
    const w2 = await webhook(ev, { id: `${TAG}rw1` });
    check("J24 the same webhook replayed is a duplicate", w2.json.duplicate === true);
    const w3 = await webhook({ ...ev, payload: { refund: { entity: { ...ev.payload.refund.entity, id: "rfnd_NeverHeard01", notes: {} } } } }, { id: `${TAG}rw2` });
    check("J25 a refund we did not make (e.g. in the dashboard, unrelated) is recorded needs_review, answered 200", w3.status === 200 && (await val(`select status as v from public.webhook_events where provider_event_id=$1`, [`${TAG}rw2`])) === "needs_review", w3);
    const w4 = await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "bad" } } } }, { id: `${TAG}rw3` });
    check("J26 an unreadable refund entity is needs_review / malformed", w4.status === 200 && w4.json.needsReview === true);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(false);
    const r = await sync(p, fake);
    check("J27 refund flag OFF: the transfer is still reversed, the buyer refund is NOT automatic", r.map((x) => x.action).join() === "reverse" && refundPosts(fake).length === 0 && !(await refundRow(p.pid)), r);
    await rflag(true);
    const r2 = await sync(p, fake);
    check("J28 turning the flag ON later issues the refund (self-healing, no re-reversal)", r2.map((x) => x.action).join() === "refund" && reversals(fake).length === 1 && refundPosts(fake).length === 1, r2);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.rfaults.push("timeout_after");
    const r1 = await sync(p, fake);
    check("J30 reversal timeout AFTER it happened: retry scheduled, no refund yet", r1[0]?.outcome === "retry_scheduled" && !(await refundRow(p.pid)), r1);
    await dueAction(p.pid);
    const r2 = await sync(p, fake);
    check("J31 the retry LOOKS first, sees it is already reversed, does NOT reverse again, and goes on to refund", reversals(fake).length === 1 && r2.map((x) => x.action).join() === "reverse,refund" && (await row(p.pid)).status === "reversed", { n: reversals(fake).length, r2 });
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.rfaults.push("400");
    const r = await sync(p, fake);
    check("J32 Razorpay refuses the reversal: parked for review, and NO refund is made behind it", r[0]?.outcome === "needs_review" && refundPosts(fake).length === 0 && !(await refundRow(p.pid)) && /dispute_reverse/.test((await row(p.pid)).review_reason ?? ""), r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.rfaults.push("500");
    const r1 = await sync(p, fake);
    await dueAction(p.pid);
    const r2 = await sync(p, fake);
    check("J33 a 500 on the reversal is retried and then succeeds; refund follows", r1[0]?.outcome === "retry_scheduled" && r2.map((x) => x.action).join() === "reverse,refund");
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.rfaults.push("lazy");
    const r1 = await sync(p, fake);
    check("J34 a reversal Razorpay accepted but has not applied yet: NOT treated as done, no refund, retry scheduled", r1[0]?.outcome === "retry_scheduled" && !(await refundRow(p.pid)) && refundPosts(fake).length === 0 && (await row(p.pid)).review_reason === null, r1);
    await dueAction(p.pid);
    const r2 = await sync(p, fake);
    check("J35 the retry completes the reversal (and then refunds)", r2.map((x) => x.action).join() === "reverse,refund" && (await row(p.pid)).status === "reversed", r2);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("timeout_after");
    const r1 = await sync(p, fake);
    check("J40 refund timeout AFTER Razorpay created it: retry scheduled", r1.at(-1)?.action === "refund" && r1.at(-1)?.outcome === "retry_scheduled" && fake.createdRefunds.length === 1, r1);
    await dueRefund(p.pid);
    const r2 = await sync(p, fake);
    check("J41 the retry LISTS the payment's refunds, adopts the existing one, creates NO second refund", r2[0]?.outcome === "adopted" && fake.createdRefunds.length === 1 && refundPosts(fake).length === 1 && (await refundRow(p.pid)).razorpay_refund_id === fake.createdRefunds[0].id, r2);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("500", "429");
    const r1 = await sync(p, fake); await dueRefund(p.pid);
    const r2 = await sync(p, fake); await dueRefund(p.pid);
    const r3 = await sync(p, fake);
    check("J42 refund 500 then 429 are retried; the third attempt creates exactly one refund", r1.at(-1).outcome === "retry_scheduled" && r2[0].outcome === "retry_scheduled" && r3[0].outcome === "created" && fake.createdRefunds.length === 1);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("400");
    const r = await sync(p, fake);
    check("J43 Razorpay refuses the refund (400): ledger 'failed', not retried", r.at(-1).outcome === "failed" && (await refundRow(p.pid)).status === "failed" && (await sync(p, fake)).length === 0 && refundPosts(fake).length === 1, r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.seedRefund({ id: "rfnd_ManualDash001", entity: "refund", payment_id: p.pay, amount: 49900, currency: "INR", status: "processed", notes: {} });
    const r = await sync(p, fake);
    check("J44 a FULL refund already made by hand in the dashboard is adopted, not repeated", r.at(-1).outcome === "adopted" && refundPosts(fake).length === 0 && (await refundRow(p.pid)).status === "processed", r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.seedRefund({ id: "rfnd_ManualPart001", entity: "refund", payment_id: p.pay, amount: 1000, currency: "INR", status: "processed", notes: {} });
    const r = await sync(p, fake);
    check("J45 a PARTIAL manual refund is a mismatch: parked as failed, no second refund on top", r.at(-1).outcome === "failed" && refundPosts(fake).length === 0 && /existing_refund_mismatch/.test((await refundRow(p.pid)).error ?? ""), r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.seedRefund({ id: "rfnd_ManualOne0001", entity: "refund", payment_id: p.pay, amount: 49900, currency: "INR", status: "processed", notes: {} });
    fake.seedRefund({ id: "rfnd_ManualTwo0001", entity: "refund", payment_id: p.pay, amount: 49900, currency: "INR", status: "processed", notes: {} });
    const r = await sync(p, fake);
    check("J46 two refunds on one payment: refuse to pick one, fail loudly", r.at(-1).outcome === "failed" && /multiple_refunds/.test((await refundRow(p.pid)).error ?? ""), r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("amount_mismatch");
    const r = await sync(p, fake);
    check("J47 Razorpay answering a different refund amount is not recorded as ours", r.at(-1).outcome === "failed" && (await refundRow(p.pid)).razorpay_refund_id === null && /response_mismatch/.test((await refundRow(p.pid)).error ?? ""), r);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("garbage");
    const r1 = await sync(p, fake); await dueRefund(p.pid);
    check("J48 an unreadable 200 on refund is retried (looked up first next time), never assumed failed", r1.at(-1).outcome === "retry_scheduled");
  }
  {
    // no seller account: no transfer ever; refund only
    await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.seller]);
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await q(`update public.seller_payout_accounts set status='active' where user_id=$1`, [U.seller]);
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const r = await sync(p, fake);
    check("J50 refunded purchase that never had a transfer: refund only", r.map((x) => x.action).join() === "refund" && reversals(fake).length === 0 && refundPosts(fake).length === 1, r);
  }

  // ---- a refund decided while the transfer was still being created
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_before");
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await makeDue(p.pid);
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("J55 refund decided before the transfer existed: the retry may only ADOPT; nothing exists, so it does NOT create one", r.outcome === "failed" && fake.created.length === 0 && /refunded_before_transfer/.test((await row(p.pid)).error ?? ""), r);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_after");
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true); await makeDue(p.pid);
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("J56 ... but a transfer that DID get created is adopted, then reversed and refunded by the dispute sync", r.outcome === "adopted" && fake.created.length === 1, r);
    const s = await sync(p, fake);
    check("J57 and the sync then reverses it and refunds the buyer", s.map((x) => x.action).join() === "reverse,refund" && fake.created[0].transfer_status === "reversed" && fake.createdRefunds.length === 1, s);
  }

  // ---- the sweep + reconciliation
  {
    await q(`update public.disputes set status = status where false`);
    const a = await linked(), b = await linked(), c = await linked();
    await dispute(a.p, "open"); await dispute(b.p, "resolved_refunded"); await refundPurchase(b.p); await rflag(true);
    await dispute(c.p, "open");
    const fake = createFakeRazorpay();
    for (const x of [a, b, c]) for (const t of x.fake.created) fake.seed({ ...t });
    const s = await runReconciliation({ db, rzp: mkRzp(fake), limit: 50 });
    const ta = await row(a.p.pid), tb = await row(b.p.pid), tc = await row(c.p.pid);
    check("J60 the reconciliation pass acts on disputes: holds, a reversal + (next round) refund", s.disputes.done >= 3 && ta.hold_until === null && tc.hold_until === null && tb.status === "reversed", s);
    const s2 = await runReconciliation({ db, rzp: mkRzp(fake), limit: 50 });
    const s3 = await runReconciliation({ db, rzp: mkRzp(fake), limit: 50 });
    check("J61 the next pass finishes the refund; after that the passes are idle", fake.createdRefunds.length >= 1 && s3.disputes.items === 0, { s2: s2.disputes, s3: s3.disputes });
  }

  // ---- concurrency
  {
    const { p, fake } = await linked(); await dispute(p, "open");
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => syncDisputeForPurchase({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), purchaseId: p.pid })));
    check("K01 8 concurrent syncs of one open dispute: exactly ONE PATCH", patches(fake).length === 1 && (await row(p.pid)).hold_until === null, { n: patches(fake).length });
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => syncDisputeForPurchase({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), purchaseId: p.pid })));
    check("K02 8 concurrent syncs of one refunded dispute: exactly ONE reversal and ONE refund at Razorpay", reversals(fake).length === 1 && fake.createdRefunds.length === 1, { rev: reversals(fake).length, ref: fake.createdRefunds.length });
    check("K03 and the ledgers agree (transfer reversed, one refund row)", (await row(p.pid)).status === "reversed" && (await val(`select count(*)::int as v from public.refunds where purchase_id=$1`, [p.pid])) === 1);
  }
  {
    const { p, fake } = await linked(); await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => runDisputeSweep({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), limit: 50 })));
    await runDisputeSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("K04 8 concurrent SWEEPS: still exactly one reversal and one refund", reversals(fake).length === 1 && fake.createdRefunds.length === 1, { rev: reversals(fake).length, ref: fake.createdRefunds.length });
  }
} finally {
  await cleanup().catch((e) => console.log("cleanup error:", e.message));
  await q(`update private.feature_flags set enabled=false where name in ('phase5_route_transfers','phase5_auto_refunds')`);
  for (const c of conns) await c.end();
  await admin.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
