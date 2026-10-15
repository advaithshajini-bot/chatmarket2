// A52-I -- Milestone 5.2 integration: REAL Postgres (all migrations) + the REAL orchestration, db wrapper, Razorpay
// client and webhook handler + a FAKE Razorpay (fetch replacement with fault injection). No network.
// COMMITS rows (then deletes them): scratch DB only.
//   PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/m52-integration.test.mjs
import pg from "pg";
import crypto from "node:crypto";
import { createFakeRazorpay } from "./fake-razorpay.mjs";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { createTransferForPurchase, runTransferSweep, pollTransfer } from "../../lib/payments/transfers.js";
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

const U = { seller: "00000000-0000-0000-0000-0000000eee51", buyer: "00000000-0000-0000-0000-0000000eee52" };
const ACC = "acc_IntSeller001";
const SECRET = "whsec_integration_test";
const TAG = "int52_";
async function cleanup() {
  await q(`delete from public.audit_log where metadata->>'order_id' like '${TAG}%'`);
  await q(`delete from public.webhook_events where provider_event_id like '${TAG}%'`);
  await q(`delete from public.transfers where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.disputes where purchase_id in (select id from public.purchases where razorpay_payment_id like '${TAG}%')`).catch(() => {});
  await q(`delete from public.purchases where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.payment_orders where razorpay_order_id like '${TAG}%'`);
  await q(`delete from public.listings where title = 'A52 int listing'`);
  await q(`delete from public.seller_payout_accounts where user_id = $1`, [U.seller]);
  await q(`delete from auth.users where id in ($1,$2)`, [U.seller, U.buyer]);
}
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

try {
  await cleanup();
  for (const [k, u] of Object.entries(U)) await q(`insert into auth.users (id, email) values ($1,$2)`, [u, `int52-${k}@example.invalid`]);
  await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,$2,'active')`, [U.seller, ACC]);

  // ---- flag OFF: everything is a no-op
  {
    await flag(false);
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I01 flag OFF: nothing is created, Razorpay is never called, no ledger row", r.outcome === "disabled" && fake.log.length === 0 && !(await row(p.pid)), r);
    const sweep = await runTransferSweep({ db, rzp: mkRzp(fake) });
    check("I02 flag OFF: the sweep finds nothing to create", sweep.created === 0 && fake.log.length === 0, sweep);
  }

  await flag(true);

  // ---- happy path
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const t = await row(p.pid);
    check("I10 happy path: one transfer created and recorded", r.outcome === "created" && fake.created.length === 1 && t.razorpay_transfer_id === fake.created[0].id, { r, t });
    check("I11 seller share is amount - platform fee in paise (49900 - 8982 = 40918)", fake.created[0].amount === 40918 && t.amount_paise === 40918 && t.platform_fee_paise === 8982, fake.created[0]);
    check("I12 sent to the right account with notes.purchase_id and a 48h hold", fake.created[0].recipient === ACC && fake.created[0].notes.purchase_id === p.pid && fake.created[0].on_hold === true && fake.created[0].on_hold_until > Math.floor(Date.now() / 1000) + 47 * 3600, fake.created[0]);
    check("I13 purchases.transfer_status is 'held'", (await pstat(p.pid)) === "held", await pstat(p.pid));
    check("I14 Razorpay was sent the key via Basic auth and nothing else leaked", fake.log.every((l) => /^Basic /.test(l.auth ?? "")), fake.log.map((l) => l.auth));
    const again = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I15 calling again does NOT create a second transfer", again.outcome === "exists" && fake.created.length === 1, again);
  }

  // ---- timeout after create -> lookup and adopt, never a second transfer
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_after");
    const rzp = mkRzp(fake);
    const r1 = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    check("I20 timeout after Razorpay created it: retry scheduled, ledger row still 'creating'", r1.outcome === "retry_scheduled" && fake.created.length === 1 && (await row(p.pid)).status === "creating", r1);
    const early = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    check("I21 an immediate second attempt is held back by the backoff", early.outcome === "backoff" && fake.created.length === 1, early);
    await makeDue(p.pid);
    const r2 = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    const t = await row(p.pid);
    check("I22 after the backoff it LISTS, adopts the existing transfer and creates nothing new", r2.outcome === "adopted" && fake.created.length === 1 && t.razorpay_transfer_id === fake.created[0].id && t.status === "created", { r2, t });
    check("I23 the adopt path made no POST", fake.log.filter((l) => l.method === "POST").length === 1, fake.log.map((l) => l.method));
  }

  // ---- timeout before create -> lookup finds nothing -> creates exactly one
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_before");
    const rzp = mkRzp(fake);
    const r1 = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    await makeDue(p.pid);
    const r2 = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    check("I30 timeout before create: the retry looks first, finds nothing, creates exactly one", r1.outcome === "retry_scheduled" && r2.outcome === "created" && fake.created.length === 1, { r1, r2 });
  }

  // ---- 500 / 429 retry; 400 terminal
  for (const [fault, expectOutcome, label] of [["500", "retry_scheduled", "I40 HTTP 500 is retried"], ["429", "retry_scheduled", "I41 HTTP 429 is retried"], ["network", "retry_scheduled", "I42 a network error is retried"], ["garbage", "retry_scheduled", "I43 a malformed 200 is treated as retryable, nothing recorded as created"]]) {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push(fault);
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const t = await row(p.pid);
    check(label, r.outcome === expectOutcome && t.status === "creating" && t.razorpay_transfer_id === null && t.error, { r, t: t && { s: t.status, e: t.error } });
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("400");
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const t = await row(p.pid);
    check("I44 HTTP 400 is terminal: ledger 'failed', purchase back to 'pending', error kept", r.outcome === "failed" && t.status === "failed" && (await pstat(p.pid)) === "pending" && /not activated/.test(t.error ?? ""), { r, t });
    const again = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I45 a failed transfer is not silently retried", again.outcome === "exists" && fake.created.length === 0, again);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("amount_mismatch");
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const t = await row(p.pid);
    check("I46 Razorpay answering a different amount is NOT recorded as ours; failed loudly", r.outcome === "failed" && t.status === "failed" && t.razorpay_transfer_id === null && /response_mismatch/.test(t.error ?? ""), { r, t });
  }

  // ---- 8 retryable failures then give up
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    let last;
    for (let i = 0; i < 9; i++) {
      fake.faults.push("500");
      last = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
      if (last.outcome === "failed") break;
      await makeDue(p.pid);
    }
    const t = await row(p.pid);
    check("I47 after 8 retryable failures the ledger gives up as 'failed'", last.outcome === "failed" && t.status === "failed" && t.attempts <= 9, { last, att: t?.attempts, st: t?.status });
  }

  // ---- pre-existing duplicates / mismatching transfer at Razorpay
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_after");
    const rzp = mkRzp(fake);
    await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    fake.seed({ id: "trf_DupOne000001", entity: "transfer", source: p.pay, recipient: ACC, amount: 40918, currency: "INR", notes: { purchase_id: p.pid }, on_hold: true, on_hold_until: null, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0 });
    await makeDue(p.pid);
    const r = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    const t = await row(p.pid);
    check("I50 two transfers for one payment at Razorpay: refuse to pick one, fail loudly, no third created", r.outcome === "failed" && t.status === "failed" && /duplicate_transfers/.test(t.error ?? "") && fake.created.length === 2, { r, e: t.error });
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_before");
    const rzp = mkRzp(fake);
    await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    fake.seed({ id: "trf_Mismatch0001", entity: "transfer", source: p.pay, recipient: ACC, amount: 1234, currency: "INR", notes: { purchase_id: p.pid }, on_hold: true, on_hold_until: null, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0 });
    await makeDue(p.pid);
    const r = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    check("I51 an existing transfer with a different amount is not adopted", r.outcome === "failed" && (await row(p.pid)).razorpay_transfer_id === null, r);
  }
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_before");
    const rzp = mkRzp(fake);
    await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    fake.seed({ id: "trf_OtherAcct0001", entity: "transfer", source: p.pay, recipient: "acc_SomeoneElse01", amount: 40918, currency: "INR", notes: {}, on_hold: true, on_hold_until: null, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0 });
    await makeDue(p.pid);
    const r = await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    check("I52 a transfer to another account on the same payment is ignored; ours is still created", r.outcome === "created" && fake.created.filter((t) => t.recipient === ACC).length === 1, r);
  }

  // ---- webhook transfer events: lifecycle, replay, out-of-order, adoption
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const ent = { ...fake.created[0] };
    const now = Math.floor(Date.now() / 1000);
    const r1 = await webhook(trfEvent({ ...ent, transfer_status: "processed", settlement_status: "on_hold" }, now + 10), { id: `${TAG}e1` });
    check("I60 transfer.processed webhook moves the ledger to 'processed'", r1.status === 200 && (await row(p.pid)).status === "processed", r1);
    const r1b = await webhook(trfEvent({ ...ent, transfer_status: "processed", settlement_status: "on_hold" }, now + 10), { id: `${TAG}e1` });
    check("I61 the same event id replayed is a duplicate: 200, nothing re-applied", r1b.status === 200 && r1b.json.duplicate === true, r1b);
    const r2 = await webhook(trfEvent({ ...ent, transfer_status: "created", settlement_status: "pending" }, now + 5), { id: `${TAG}e2` });
    const t = await row(p.pid);
    check("I62 an OLDER 'created' event arriving late does not move 'processed' backwards", t.status === "processed" && /stale|applied/.test(r2.json.outcome ?? ""), { r2, st: t.status });
    check("I63 'processed' + on_hold still maps to purchases 'held'", (await pstat(p.pid)) === "held", await pstat(p.pid));
    await webhook(trfEvent({ ...ent, transfer_status: "processed", settlement_status: "settled", on_hold: false }, now + 20), { id: `${TAG}e3` });
    check("I64 settled + released maps to 'released'", (await pstat(p.pid)) === "released" && (await row(p.pid)).settlement_status === "settled", await pstat(p.pid));
    await webhook(trfEvent({ ...ent, transfer_status: "processed", settlement_status: "on_hold", on_hold: true }, now + 30), { id: `${TAG}e4` });
    check("I65 settled is terminal: a later 'on_hold' event cannot un-settle it", (await row(p.pid)).settlement_status === "settled", (await row(p.pid)).settlement_status);
    const bad = await webhook(trfEvent({ id: "nope", amount: -1 }), { id: `${TAG}e5` });
    check("I66 an unreadable transfer entity is recorded as needs_review, answered 200", bad.status === 200 && bad.json.needsReview === true && (await val(`select status as v from public.webhook_events where provider_event_id=$1`, [`${TAG}e5`])) === "needs_review", bad);
    const unk = await webhook(trfEvent({ ...ent, id: "trf_NeverHeard0001", notes: {} }), { id: `${TAG}e6` });
    check("I67 a transfer we never created is 'unknown_transfer', answered 200, nothing written", unk.status === 200 && /unknown_transfer/.test(unk.json.outcome ?? "") && !(await val(`select 1 as v from public.transfers where razorpay_transfer_id='trf_NeverHeard0001'`)), unk);
  }
  {
    // the transfer.* event outruns our own "record the id" step: adopt by notes.purchase_id
    const p = await mkPurchase(); const fake = createFakeRazorpay(); fake.faults.push("timeout_after");
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I70 setup: row is 'creating' with no id", (await row(p.pid)).razorpay_transfer_id === null);
    const r = await webhook(trfEvent({ ...fake.created[0], transfer_status: "processed", settlement_status: "on_hold" }), { id: `${TAG}e7` });
    const t = await row(p.pid);
    check("I71 the webhook adopts the claimed row by notes.purchase_id", r.status === 200 && t.razorpay_transfer_id === fake.created[0].id && t.status === "processed", { r, t: t.status });
    await makeDue(p.pid);
    const r2 = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I72 a later create attempt for that purchase is a no-op", r2.outcome === "exists" && fake.created.length === 1, r2);
  }

  // ---- reversal state
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const ent = fake.created[0]; const now = Math.floor(Date.now() / 1000);
    await webhook(trfEvent({ ...ent, transfer_status: "partially_reversed", amount_reversed: 1000 }, now + 5), { id: `${TAG}e8` });
    check("I75 partial reversal is recorded and maps to 'reversed'", (await row(p.pid)).amount_reversed_paise === 1000 && (await pstat(p.pid)) === "reversed", await pstat(p.pid));
  }

  // ---- sweep: creates missing transfers, polls stale ones, isolates failures
  {
    await q(`delete from public.transfers where razorpay_payment_id like '${TAG}%'`);
    await q(`delete from public.purchases where razorpay_payment_id like '${TAG}%'`);
    const a = await mkPurchase(), b = await mkPurchase(), c = await mkPurchase();
    const fake = createFakeRazorpay(); fake.faults.push("500");   // the first create fails; the rest succeed
    const s = await runTransferSweep({ db, rzp: mkRzp(fake), limit: 20 });
    const rows = (await q(`select purchase_id, status from public.transfers where razorpay_payment_id like '${TAG}%'`)).rows;
    check("I80 sweep creates transfers for paid purchases that have none; one failure does not stop the others", s.items >= 3 && s.created === 2 && s.retry_scheduled === 1 && rows.length === 3 && fake.created.length === 2, { s, rows });
    const s2 = await runTransferSweep({ db, rzp: mkRzp(fake), limit: 20 });
    check("I81 an immediate second sweep does nothing (backoff holds, nothing to poll)", s2.created === 0 && fake.created.length === 2, s2);
    await q(`update public.transfers set next_attempt_at = now() - interval '1 second', last_attempt_at = now() - interval '5 minutes' where status='creating' and razorpay_payment_id like '${TAG}%'`);
    const s3 = await runTransferSweep({ db, rzp: mkRzp(fake), limit: 20 });
    check("I82 once due, the sweep retries the failed one and creates it", s3.created === 1 && fake.created.length === 3, s3);
    // stale transfer -> poll picks up a status change that never arrived as a webhook
    const t = fake.created[0];
    t.transfer_status = "processed"; t.settlement_status = "settled"; t.on_hold = false;
    await q(`update public.transfers set updated_at = now() - interval '2 hours' where razorpay_transfer_id = $1`, [t.id]);
    const s4 = await runTransferSweep({ db, rzp: mkRzp(fake), limit: 20 });
    const tr = (await q(`select status, settlement_status from public.transfers where razorpay_transfer_id=$1`, [t.id])).rows[0];
    check("I83 the sweep polls a stale transfer and records what Razorpay now says", s4.polled >= 1 && tr.status === "processed" && tr.settlement_status === "settled", { s4, tr });
    await mkPurchase();   // something to do, so the budget is what stops the sweep
    const s5 = await runTransferSweep({ db, rzp: mkRzp(fake), limit: 20, budgetMs: -1 });
    check("I84 a zero time budget stops the sweep before any work", s5.timeBudgetHit === true && s5.items === 0, s5);
    const p = await pollTransfer({ db, rzp: mkRzp(fake), purchaseId: a.pid, transferId: "trf_DoesNotExist01" });
    check("I85 polling a transfer Razorpay rejects is reported, not thrown", ["poll_failed", "poll_retry_later"].includes(p.outcome), p);
  }

  // ---- disputes at creation time
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'integration test reason','open')`, [p.pid, p.lid, U.buyer, U.seller]);
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I90 an OPEN dispute at creation: the transfer is created held with NO release date (indefinite)", r.outcome === "created" && fake.created[0].on_hold === true && !fake.created[0].on_hold_until, fake.created[0]);
    const p2 = await mkPurchase({ ago: "49 hours" }); const fake2 = createFakeRazorpay();
    await createTransferForPurchase({ db, rzp: mkRzp(fake2), purchaseId: p2.pid });
    check("I91 hold window already elapsed: created with on_hold=false", fake2.created[0].on_hold === false, fake2.created[0]);
  }

  // ---- setTransferHold (used by 5.2c) works against the fake
  {
    const p = await mkPurchase(); const fake = createFakeRazorpay(); const rzp = mkRzp(fake);
    await createTransferForPurchase({ db, rzp, purchaseId: p.pid });
    const r = await rzp.setTransferHold(fake.created[0].id, true, null);
    check("I95 setTransferHold PATCHes the transfer", r.ok === true && fake.log.at(-1).method === "PATCH" && fake.created[0].on_hold === true, r);
  }

  // ---- end to end: payment.captured -> purchase -> transfer through the webhook hook
  {
    const order = `${TAG}order1`, pay = `${TAG}payE2E`;
    await q(`delete from public.listings where title='A52 int listing' and id not in (select listing_id from public.purchases)`);
    const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A52 int listing','n','n',499,'S',$1,'live') returning id`, [U.seller]);
    await db.recordPaymentOrder({ orderId: order, userId: U.buyer, listingId: l.id, amountPaise: 49900 });
    const fake = createFakeRazorpay(); const rzp = mkRzp(fake);
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: pay, order_id: order, amount: 49900, currency: "INR", status: "captured", method: "upi" } } } });
    const call = (eid, hook) => handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": eid }, secret: SECRET, feePct: 0.18, db, afterFulfil: hook });
    const hook = ({ purchaseId }) => createTransferForPurchase({ db, rzp, purchaseId });
    const r = await call(`${TAG}evE1`, hook);
    const pid = await val(`select id as v from public.purchases where razorpay_payment_id=$1`, [pay]);
    check("I100 payment.captured -> purchase created -> transfer created in the same webhook", r.status === 200 && r.json.outcome === "fulfilled" && fake.created.length === 1 && (await row(pid))?.razorpay_transfer_id === fake.created[0].id, { r, n: fake.created.length });
    const r2 = await call(`${TAG}evE2`, hook);   // order.paid-style second delivery, different event id
    check("I101 a second delivery for the same payment does not create a second transfer", r2.status === 200 && fake.created.length === 1, { r2, n: fake.created.length });
    // hook that blows up must never change the answer
    await q(`delete from public.transfers where purchase_id=$1`, [pid]);
    const r3 = await call(`${TAG}evE3`, async () => { throw new Error("boom"); });
    check("I102 a throwing afterFulfil never changes the webhook answer", r3.status === 200 && r3.json.outcome === "already_fulfilled", r3);
    const fake4 = createFakeRazorpay(); fake4.faults.push("500");
    const r4 = await call(`${TAG}evE4`, ({ purchaseId }) => createTransferForPurchase({ db, rzp: mkRzp(fake4), purchaseId }));
    check("I103 Razorpay down during the hook: webhook still 200; the sweep will finish the job", r4.status === 200 && (await row(pid))?.status === "creating", { r4, st: (await row(pid))?.status });
  }

  // ---- flag toggled OFF mid-way: in-flight claimed rows stay, no new claims
  {
    await flag(false);
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    const r = await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    check("I110 flag turned OFF again: no new transfers", r.outcome === "disabled" && fake.log.length === 0, r);
    await flag(true);
  }

  // ================================================================ concurrency
  {
    // 8 connections race plan_transfer for the same purchase: exactly one claim
    const p = await mkPurchase();
    const plans = await Promise.all(Array.from({ length: 8 }, (_, i) => clientFor(conns[i]).rpc("plan_transfer", { p_purchase_id: p.pid })));
    const outs = plans.map((x) => x.data?.outcome);
    check("C01 8 concurrent plan_transfer: exactly ONE claim, the rest see it", outs.filter((o) => o === "claimed").length === 1 && outs.every((o) => ["claimed", "exists", "in_progress"].includes(o)) && !plans.some((x) => x.error), { outs, errs: plans.map((x) => x.error?.message).filter(Boolean) });
    check("C02 exactly one ledger row", (await val(`select count(*)::int as v from public.transfers where purchase_id=$1`, [p.pid])) === 1);
  }
  {
    // 8 workers share one fake Razorpay: exactly one transfer is created
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => createTransferForPurchase({ db: createPaymentsDb(clientFor(conns[i])), rzp: mkRzp(fake), purchaseId: p.pid })));
    check("C10 8 concurrent createTransferForPurchase: exactly ONE transfer at Razorpay", fake.created.length === 1 && rs.filter((r) => r.outcome === "created").length === 1, { n: fake.created.length, outs: rs.map((r) => r.outcome) });
    check("C11 the ledger holds that one transfer's id", (await row(p.pid)).razorpay_transfer_id === fake.created[0]?.id);
  }
  {
    // concurrent events for one transfer: order-independent final state
    const p = await mkPurchase(); const fake = createFakeRazorpay();
    await createTransferForPurchase({ db, rzp: mkRzp(fake), purchaseId: p.pid });
    const ent = fake.created[0]; const base = Math.floor(Date.now() / 1000) + 100;
    const evs = [
      { s: "processed", st: "on_hold", h: true, at: base + 1 }, { s: "processed", st: "settled", h: false, at: base + 3 },
      { s: "created", st: "pending", h: true, at: base - 5 }, { s: "processed", st: "on_hold", h: true, at: base + 2 },
    ];
    const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => { const e = evs[i % evs.length]; return clientFor(conns[i % N_POOL]).rpc("apply_transfer_event", { p_transfer_id: ent.id, p_purchase_id: p.pid, p_status: e.s, p_settlement_status: e.st, p_on_hold: e.h, p_amount_reversed: 0, p_event_at: e.at }); }));
    const t = await row(p.pid);
    check("C20 16 concurrent events in any order end at processed + settled, no errors", !rs.some((x) => x.error) && t.status === "processed" && t.settlement_status === "settled", { st: t.status, ss: t.settlement_status, errs: rs.map((x) => x.error?.message).filter(Boolean) });
  }
} finally {
  await cleanup().catch((e) => console.log("cleanup error:", e.message));
  await q(`update private.feature_flags set enabled=false where name='phase5_route_transfers'`);
  for (const c of conns) await c.end();
  await admin.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
