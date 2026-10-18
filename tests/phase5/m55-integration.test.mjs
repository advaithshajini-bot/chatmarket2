// A55-I -- Milestone 5.4 integration: REAL Postgres (all migrations) + the REAL payout orchestration, db wrapper, Razorpay client and
// webhook handler + a FAKE RazorpayX (fetch replacement with fault injection). No network.
// COMMITS rows (then deletes them): scratch DB only.
//   PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/m55-integration.test.mjs
import pg from "pg";
import crypto from "node:crypto";
import { createFakeRazorpay } from "./fake-razorpay.mjs";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createPaymentsDb } from "../../lib/payments/db.js";
import { payoutPurchase, runPayoutSweep } from "../../lib/payments/vpa-payouts.js";
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
let rr = 0;
const db = createPaymentsDb({
  rpc: async (fn, args = {}) => {
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as v`;
    try { const r = await conns[rr++ % N_POOL].query(sql, names.map((n) => args[n])); return { data: r.rows[0]?.v ?? null, error: null }; }
    catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
  },
});
const mkRzp = (fake) => createRazorpayClient({ keyId: "rzp_test_x", keySecret: "s", fetchImpl: fake.fetch, timeoutMs: 500, accountNumber: "ACCT0001" });
const U = { seller: "00000000-0000-0000-0000-0000000eee61", buyer: "00000000-0000-0000-0000-0000000eee62" };
const VPA = "asha.k@okhdfcbank", TAG = "int55_", SECRET = "whsec_integration_test";
async function cleanup() {
  await q(`delete from public.webhook_events where provider_event_id like '${TAG}%'`);
  await q(`delete from public.disputes where purchase_id in (select id from public.purchases where razorpay_payment_id like '${TAG}%')`);
  await q(`delete from public.vpa_payouts where purchase_id in (select id from public.purchases where razorpay_payment_id like '${TAG}%')`);
  await q(`delete from public.purchases where razorpay_payment_id like '${TAG}%'`);
  await q(`delete from public.listings where title = 'A55 int listing'`);
  await q(`delete from public.seller_payout_accounts where user_id = $1`, [U.seller]);
  await q(`delete from auth.users where id in ($1,$2)`, [U.seller, U.buyer]);
  await q(`update private.feature_flags set enabled=false where name in ('phase6_vpa_payouts','phase5_route_transfers')`);
  await q(`update private.vpa_payout_config set cutoff_at='infinity' where id`);
}
let seq = 0;
async function mkPurchase({ amount = 499, fee = 89.82 } = {}) {
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A55 int listing','n','n',$1,'Asha',$2,'live') returning id`, [amount, U.seller]);
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee) values ($1,$2,$3,'paid',$4,$5) returning id`, [U.buyer, l.id, amount, `${TAG}pay${++seq}`, fee]);
  return p.id;
}
// each scenario gets a fresh fake RazorpayX, so the contact / fund account remembered from an earlier fake must be forgotten
const freshFake = async () => { await q(`update public.seller_payout_accounts set razorpay_contact_id=null, razorpay_fund_account_id=null where user_id=$1`, [U.seller]); return createFakeRazorpay(); };
const row = async (pid) => (await q(`select * from public.vpa_payouts where purchase_id=$1`, [pid])).rows[0];
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
async function webhook(event, id) {
  const raw = JSON.stringify(event);
  return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": id ?? `${TAG}evt${++seq}` }, secret: SECRET, feePct: 0.18, db });
}
const payEvent = (e, status, at) => ({ event: `payout.${status}`, created_at: at ?? Math.floor(Date.now() / 1000), payload: { payout: { entity: { id: e.id, entity: "payout", amount: e.amount, currency: "INR", status, fund_account_id: e.fund_account_id, reference_id: e.reference_id, utr: status === "processed" ? "UTRINT1" : null } } } });

try {
  await cleanup();
  await q(`insert into auth.users (id, email) values ($1,'a55i-s@example.invalid'),($2,'a55i-b@example.invalid')`, [U.seller, U.buyer]);
  await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status) values ($1,$2,'active')`, [U.seller, VPA]);

  // flag off: nothing
  { const p = await mkPurchase(); const fake = await freshFake();
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I01 flag OFF: nothing is sent to Razorpay and no ledger row exists", r.outcome === "disabled" && fake.log.length === 0 && !(await row(p))); }

  await q(`update private.feature_flags set enabled=true where name='phase6_vpa_payouts'`);
  { const p = await mkPurchase(); const fake = await freshFake();
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I02 flag ON but cutoff not set: nothing is sent (fail closed)", r.outcome === "before_cutoff" && fake.log.length === 0); }
  await q(`update private.vpa_payout_config set cutoff_at = now() - interval '1 hour' where id`);

  // happy path
  { const p = await mkPurchase(); const fake = await freshFake();
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    const l = await row(p), acc = (await q(`select * from public.seller_payout_accounts where user_id=$1`, [U.seller])).rows[0];
    check("I10 happy path: one payout of the seller share (49900 - 8982 = 40918 paise), UPI, keyed by the purchase id", r.outcome === "created" && fake.createdPayouts.length === 1 && fake.createdPayouts[0].amount === 40918 && fake.createdPayouts[0].reference_id === p && fake.createdPayouts[0].mode === "UPI", r);
    check("I11 the ledger row is 'queued' with the razorpay payout id; the fund account is remembered for the next sale", l.status === "queued" && l.razorpay_payout_id === fake.createdPayouts[0].id && /^fa_/.test(acc.razorpay_fund_account_id) && /^cont_/.test(acc.razorpay_contact_id), l);
    const again = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I12 calling again does nothing (exists)", again.outcome === "exists" && fake.createdPayouts.length === 1);
    const e = fake.createdPayouts[0];
    const w1 = await webhook(payEvent(e, "processed", 2000000000));
    check("I13 payout.processed via the real webhook handler: ledger 'processed' with UTR; webhook row finished", w1.status === 200 && (await row(p)).status === "processed" && (await row(p)).utr === "UTRINT1" && (await q(`select outcome from public.webhook_events where provider_event_id like '${TAG}evt%' order by received_at desc limit 1`)).rows[0].outcome === "payout_applied", w1);
    const w2 = await webhook(payEvent(e, "failed", 2000000100));
    check("I14 a late payout.failed can never undo a processed payout", w2.status === 200 && (await row(p)).status === "processed");
    // dispute + refund after payout: nothing changes
    const lid = (await q(`select listing_id from public.purchases where id=$1`, [p])).rows[0].listing_id;
    await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'unhappy','open')`, [p, lid, U.buyer, U.seller]);
    await q(`update public.purchases set status='refunded' where id=$1`, [p]);
    await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U.seller, role: "authenticated" })]);
    await q(`set role authenticated`);
    const sp = (await q(`select public.seller_payout_status(50) as v`)).rows[0].v;
    await q(`reset role`);
    const it = sp.items.find((i) => i.purchase_id === p);
    check("I15 NON-RECOURSE: after a dispute and a buyer refund the seller still sees 'instant_paid' and the paid amount is unchanged", it.status === "instant_paid" && sp.summary.paid_paise === 40918, sp.summary);
    check("I16 the payout is untouched by the dispute/refund", (await row(p)).status === "processed" && (await row(p)).amount_paise === 40918);
  }

  // concurrency: the same purchase from 10 workers
  { const p = await mkPurchase(); const fake = await freshFake();
    const rs = await Promise.all(Array.from({ length: 10 }, () => payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p })));
    const created = rs.filter((r) => r.outcome === "created").length;
    check("I20 10 concurrent attempts on one purchase: exactly ONE Razorpay payout and ONE ledger row", fake.createdPayouts.length === 1 && created === 1 && (await q(`select count(*)::int n from public.vpa_payouts where purchase_id=$1`, [p])).rows[0].n === 1, rs.map((r) => r.outcome)); }

  // timeout after Razorpay created it, then the sweep recovers WITHOUT a second payout
  { const p = await mkPurchase(); const fake = await freshFake(); fake.payoutFaults.push("timeout_after");
    const r1 = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I30 timeout after creation: retry scheduled, the payout exists at Razorpay, ledger still 'creating'", r1.outcome === "retry_scheduled" && fake.createdPayouts.length === 1 && (await row(p)).status === "creating", r1);
    await q(`update public.vpa_payouts set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [p]);
    const sw = await runPayoutSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("I31 the sweep retries: it LISTS first and adopts the existing payout (still ONE payout for this purchase, ledger 'queued')", fake.createdPayouts.filter((x) => x.reference_id === p).length === 1 && (await row(p)).status === "queued" && (await row(p)).razorpay_payout_id === fake.createdPayouts.find((x) => x.reference_id === p).id && sw.adopted >= 1, sw); }

  // sweep: backlog + poll
  { const p = await mkPurchase(); const fake = await freshFake();
    const sw = await runPayoutSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("I40 the sweep creates payouts for paid purchases nobody paid yet", (await row(p))?.status === "queued" && sw.created >= 1 && fake.createdPayouts.length === sw.created, sw);
    const e = fake.createdPayouts.find((x) => x.reference_id === p); e.status = "processed"; e.utr = "POLLUTR";
    await q(`update public.vpa_payouts set updated_at = now() - interval '1 hour' where purchase_id=$1`, [p]);
    const sw2 = await runPayoutSweep({ db, rzp: mkRzp(fake), limit: 50 });
    check("I41 a payout whose webhook never arrived is found by polling and marked processed", (await row(p)).status === "processed" && (await row(p)).utr === "POLLUTR" && sw2.polled >= 1, sw2); }

  // failure + admin retry key
  { const p = await mkPurchase(); const fake = await freshFake(); fake.payoutFaults.push("400");
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I50 a Razorpay 400 fails the payout for a human (non-retryable) and nothing is created", r.outcome === "failed" && fake.createdPayouts.length === 0 && (await row(p)).status === "failed");
    await q(`update public.vpa_payouts set status='creating', key_version=2, attempts=0, error=null, last_attempt_at=null, next_attempt_at=null where purchase_id=$1`, [p]);
    const r2 = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    check("I51 after an admin retry the NEW payout uses key '<purchase>-v2' as idempotency key and reference", r2.outcome === "created" && fake.log.filter((l) => l.path === "/v1/payouts" && l.method === "POST").at(-1).headers["X-Payout-Idempotency"] === `${p}-v2` && fake.createdPayouts[0].reference_id === `${p}-v2`, r2); }

  // both flags on: neither runs
  { const p = await mkPurchase(); const fake = await freshFake();
    await q(`update private.feature_flags set enabled=true where name='phase5_route_transfers'`);
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    const sw = await runPayoutSweep({ db, rzp: mkRzp(fake), limit: 50 });
    await q(`update private.feature_flags set enabled=false where name='phase5_route_transfers'`);
    check("I60 both flags ON: no payout is planned or created, the sweep finds no create work", r.outcome === "disabled" && !(await row(p)) && sw.created === 0); }

  // suspended seller
  { const p = await mkPurchase(); const fake = await freshFake();
    await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.seller]);
    const r = await payoutPurchase({ db, rzp: mkRzp(fake), purchaseId: p });
    await q(`update public.seller_payout_accounts set status='active' where user_id=$1`, [U.seller]);
    check("I70 a suspended seller is not paid (the kill switch)", r.outcome === "no_account" && fake.log.length === 0); }
} catch (e) {
  fail++; console.log("FAIL: unexpected exception", e.message, e.stack?.split("\n").slice(0, 4).join(" | "));
} finally {
  await cleanup().catch((e) => console.log("cleanup error", e.message));
  await Promise.all(conns.map((c) => c.end())); await admin.end();
}
console.log(`\nA55-I: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
