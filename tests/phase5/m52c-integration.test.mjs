// A52c-I -- Milestone 5.2c integration (disputes -> REFUNDS only; the Route hold/reverse half was retired in the Tier 2 clean-up): REAL Postgres (all migrations) + the REAL orchestration, db wrapper, Razorpay
// client and webhook handler + a FAKE Razorpay (fetch replacement with fault injection). No network.
// COMMITS rows (then deletes them): scratch DB only.
//   PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/m52c-integration.test.mjs
import pg from "pg";
import crypto from "node:crypto";
import { createFakeRazorpay } from "./fake-razorpay.mjs";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { syncDisputeForPurchase, runDisputeSweep } from "../../lib/payments/disputes.js";
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
  await q(`delete from public.refunds where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.disputes where purchase_id in (select id from public.purchases where razorpay_payment_id like '${TAG}%')`);
  await q(`delete from public.purchases where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.payment_orders where razorpay_order_id like '${TAG}%'`);
  await q(`delete from public.listings where title = 'A52 int listing'`);
  await q(`delete from public.seller_payout_accounts where user_id = $1`, [U.seller]);
  await q(`delete from auth.users where id in ($1,$2)`, [U.seller, U.buyer]);
}
const rflag = (on) => q(`update private.feature_flags set enabled=$1 where name='phase5_auto_refunds'`, [on]);
let seq = 0;
async function mkPurchase({ amount = 499, fee = 89.82, ago = "0 minutes", account = true } = {}) {
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A52 int listing','n','n',$1,'S',$2,'live') returning id`, [amount, U.seller]);
  const pay = `${TAG}pay${++seq}`;
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at)
     values ($1,$2,$3,'paid',$4,$5, now() - $6::interval) returning id`, [U.buyer, l.id, amount, pay, fee, ago]);
  return { pid: p.id, lid: l.id, pay };
}
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
async function webhook(event, { id, at } = {}) {
  const raw = JSON.stringify(event);
  return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": id ?? `${TAG}evt${++seq}` }, secret: SECRET, feePct: 0.18, db, afterFulfil: undefined });
}

const refundRow = async (pid) => (await q(`select * from public.refunds where purchase_id=$1`, [pid])).rows[0];
const dueRefund = (pid) => q(`update public.refunds set next_attempt_at = now() - interval '1 second', last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [pid]);
const dispute = (p, status) => q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c integration reason',$5)`, [p.pid, p.lid, U.buyer, U.seller, status]);
const setDispute = (p, status) => q(`update public.disputes set status=$2 where purchase_id=$1`, [p.pid, status]);
const refundPurchase = (p) => q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
const sync = (p, fake) => syncDisputeForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
const refundPosts = (fake) => fake.log.filter((l) => l.method === "POST" && /\/refund$/.test(l.path));

try {
  await cleanup();
  for (const [k, u] of Object.entries(U)) await q(`insert into auth.users (id, email) values ($1,$2)`, [u, `int52c-${k}@example.invalid`]);
  await rflag(false);
  const noTransfers = async (p) => (await val(`select count(*)::int as v from public.transfers where purchase_id=$1`, [p.pid])) === 0;

  // ---- refunded dispute -> refund (no transfer exists, so there is nothing to hold or reverse)
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "open");
    const r0 = await sync(p, fake);
    check("J01 an OPEN dispute does nothing at Razorpay (no transfer to hold) and asks the database for nothing", r0.length === 0 && fake.log.length === 0 && (await noTransfers(p)), r0);
    await setDispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const r = await sync(p, fake);
    const rf = await refundRow(p.pid);
    check("J20 refunded: the buyer is refunded the FULL amount once, with the purchase id in the notes, and no transfer or reversal is touched",
      r.map((x) => x.action).join() === "refund" && refundPosts(fake).length === 1 && refundPosts(fake)[0].body.amount === 49900 && refundPosts(fake)[0].body.notes.purchase_id === p.pid
      && !fake.log.some((l) => /transfers/.test(l.path)) && (await noTransfers(p)), { r, log: fake.log.map((l) => `${l.method} ${l.path}`) });
    check("J21 ledger: refund 'pending' with its Razorpay id", rf.status === "pending" && rf.razorpay_refund_id === fake.createdRefunds[0].id && rf.amount_paise === 49900, rf);
    check("J22 syncing again does nothing: no second refund", (await sync(p, fake)).length === 0 && refundPosts(fake).length === 1);
    const ev = { event: "refund.processed", created_at: Math.floor(Date.now() / 1000) + 5, payload: { refund: { entity: { ...fake.createdRefunds[0], status: "processed" } } } };
    const w = await webhook(ev, { id: `${TAG}rw1` });
    check("J23 refund.processed webhook -> ledger 'processed', event processed", w.status === 200 && w.json.outcome === "refund_applied" && (await refundRow(p.pid)).status === "processed", w);
    const w2 = await webhook(ev, { id: `${TAG}rw1` });
    check("J24 the same webhook replayed is a duplicate", w2.json.duplicate === true);
    const w3 = await webhook({ ...ev, payload: { refund: { entity: { ...ev.payload.refund.entity, id: "rfnd_NeverHeard01", notes: {} } } } }, { id: `${TAG}rw2` });
    check("J25 a refund we did not make is recorded needs_review, answered 200", w3.status === 200 && (await val(`select status as v from public.webhook_events where provider_event_id=$1`, [`${TAG}rw2`])) === "needs_review", w3);
    const w4 = await webhook({ event: "refund.processed", payload: { refund: { entity: { id: "bad" } } } }, { id: `${TAG}rw3` });
    check("J26 an unreadable refund entity is needs_review / malformed", w4.status === 200 && w4.json.needsReview === true);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(false);
    const r = await sync(p, fake);
    check("J27 refund flag OFF: nothing is refunded automatically and Razorpay is never called", r.length === 0 && refundPosts(fake).length === 0 && fake.log.length === 0 && !(await refundRow(p.pid)), r);
    await rflag(true);
    const r2 = await sync(p, fake);
    check("J28 turning the flag ON later issues the refund (self-healing)", r2.map((x) => x.action).join() === "refund" && refundPosts(fake).length === 1, r2);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("timeout_after");
    const r1 = await sync(p, fake);
    check("J30 refund timeout AFTER it happened: retry scheduled, nothing recorded as created", r1[0]?.outcome === "retry_scheduled", r1);
    await dueRefund(p.pid);
    const r2 = await sync(p, fake);
    check("J31 the retry LOOKS first, adopts the refund that already exists, and does NOT create a second", r2[0]?.outcome === "adopted" && fake.createdRefunds.length === 1 && refundPosts(fake).length === 1, { r2, n: fake.createdRefunds.length });
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    fake.seedRefund({ id: "rfnd_ByHand000001", entity: "refund", payment_id: p.pay, amount: 49900, currency: "INR", status: "processed", notes: {} });
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const r = await sync(p, fake);
    check("J32 a refund made by hand in the Razorpay dashboard is adopted, never repeated", r[0]?.outcome === "adopted" && refundPosts(fake).length === 0 && (await refundRow(p.pid))?.razorpay_refund_id === "rfnd_ByHand000001", r);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    fake.refaults.push("400");
    const r = await sync(p, fake);
    check("J33 Razorpay refuses the refund (400): recorded as failed, not retried blindly", r[0]?.outcome === "failed" && (await refundRow(p.pid))?.status === "failed", r);
  }
  {
    // the reconciliation-style sweep, driven directly
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    const c = await runDisputeSweep({ db, rzp: mkRzp(fake), limit: 50 });
    const c2 = await runDisputeSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("J60 the dispute sweep issues the refund once and is idle afterwards", c.done >= 1 && c2.items === 0 && fake.createdRefunds.length === 1, { c, c2 });
  }

  // ---- concurrency
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    await Promise.all(Array.from({ length: 8 }, (_, i) => syncDisputeForPurchase({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), purchaseId: p.pid })));
    check("K02 8 concurrent syncs of one refunded dispute: exactly ONE refund at Razorpay", fake.createdRefunds.length === 1 && refundPosts(fake).length === 1, { ref: fake.createdRefunds.length });
    check("K03 and the ledger agrees (one refund row)", (await val(`select count(*)::int as v from public.refunds where purchase_id=$1`, [p.pid])) === 1);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await dispute(p, "resolved_refunded"); await refundPurchase(p); await rflag(true);
    await Promise.all(Array.from({ length: 8 }, (_, i) => runDisputeSweep({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), limit: 50 })));
    await runDisputeSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("K04 8 concurrent SWEEPS: still exactly one refund", fake.createdRefunds.length === 1, { ref: fake.createdRefunds.length });
  }
} finally {
  await cleanup().catch((e) => console.log("cleanup error:", e.message));
  await q(`update private.feature_flags set enabled=false where name in ('phase5_route_transfers','phase5_auto_refunds')`);
  for (const c of conns) await c.end();
  await admin.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
