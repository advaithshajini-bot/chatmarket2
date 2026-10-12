// A51-C -- real concurrency: many connections fulfil / begin the SAME payment or event at once.
// COMMITS rows (then deletes them) -- scratch DB or quiet window only.  Run:
//   PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/m51-concurrency.test.mjs
import pg from "pg";
if (!process.env.DATABASE_URL || process.env.PHASE5_CONCURRENCY_TESTS !== "1") { console.log("SKIPPED: set PHASE5_CONCURRENCY_TESTS=1 and DATABASE_URL (commits then deletes rows)."); process.exit(0); }
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const N = 8;
const conns = await Promise.all(Array.from({ length: N }, async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }));
const admin = conns[0];
const U = { seller: "00000000-0000-0000-0000-0000000ddd51", buyer: "00000000-0000-0000-0000-0000000ddd52" };
let lid;
async function cleanup() {
  await admin.query(`delete from public.webhook_events where provider_event_id like 'conc_%'`);
  await admin.query(`delete from public.audit_log where metadata->>'order_id' like 'conc_%'`);
  await admin.query(`delete from public.purchases where razorpay_payment_id like 'conc_%'`);
  await admin.query(`delete from public.payment_orders where razorpay_order_id like 'conc_%'`);
  await admin.query(`delete from public.listings where title = 'A51 conc listing'`);
  await admin.query(`delete from auth.users where id in ($1,$2)`, [U.seller, U.buyer]);
}
try {
  await cleanup();
  for (const [k, u] of Object.entries(U)) await admin.query(`insert into auth.users (id, email) values ($1,$2)`, [u, `conc-${k}@example.invalid`]);
  lid = (await admin.query(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A51 conc listing','n','n',499,'S',$1,'live') returning id`, [U.seller])).rows[0].id;
  await admin.query(`select public.record_payment_order('conc_order', $1, $2, 49900)`, [U.buyer, lid]);

  // N connections fulfil the same payment at once
  const res = await Promise.all(conns.map((c) => c.query(`select public.fulfil_captured_payment('conc_order','conc_pay',49900,'INR','upi',null,0.18,null,null) as v`).then((r) => r.rows[0].v, (e) => ({ err: e.message }))));
  const outs = res.map((r) => r.outcome ?? r.err);
  check("C01 8 simultaneous fulfilments of one payment: exactly one 'fulfilled', the rest 'already_fulfilled', no errors",
    outs.filter((o) => o === "fulfilled").length === 1 && outs.filter((o) => o === "already_fulfilled").length === N - 1, outs);
  check("C02 exactly one purchase and one audit row exist", (await admin.query(`select count(*)::int c from public.purchases where razorpay_payment_id='conc_pay'`)).rows[0].c === 1
    && (await admin.query(`select count(*)::int c from public.audit_log where metadata->>'order_id'='conc_order'`)).rows[0].c === 1);
  check("C03 all callers got the SAME purchase id", new Set(res.map((r) => r.purchase_id)).size === 1);

  // a second payment for the same buyer+listing racing in parallel: only one purchase may exist afterwards
  await admin.query(`delete from public.purchases where razorpay_payment_id='conc_pay'`);
  await admin.query(`select public.record_payment_order('conc_order2', $1, $2, 49900)`, [U.buyer, lid]);
  const res2 = await Promise.all(conns.map((c, i) => c.query(`select public.fulfil_captured_payment($1,$2,49900,'INR','upi',null,0.18,null,null) as v`, [i % 2 ? "conc_order" : "conc_order2", i % 2 ? "conc_pay" : "conc_pay2"]).then((r) => r.rows[0].v, (e) => ({ err: e.message }))));
  const o2 = res2.map((r) => r.outcome ?? r.err);
  check("C04 two DIFFERENT payments for the same buyer+listing racing: one purchase row, the other is 'duplicate_payment' (no unique-violation error leaks)",
    (await admin.query(`select count(*)::int c from public.purchases where user_id=$1 and listing_id=$2`, [U.buyer, lid])).rows[0].c === 1
    && !o2.some((o) => typeof o === "string" && !["fulfilled", "already_fulfilled", "duplicate_payment"].includes(o)), o2);

  // N connections begin the same webhook event at once
  const begins = await Promise.all(conns.map((c) => c.query(`select public.begin_webhook_event('conc_evt','payment.captured','conc_order','conc_pay',$1) as v`, ["b".repeat(64)]).then((r) => r.rows[0].v, (e) => e.message)));
  check("C05 8 simultaneous deliveries of one event: exactly one 'new', the others 'retry' (still in flight), one row", begins.filter((b) => b === "new").length === 1
    && begins.every((b) => b === "new" || b === "retry")
    && (await admin.query(`select count(*)::int c from public.webhook_events where provider_event_id='conc_evt'`)).rows[0].c === 1, begins);
} finally {
  try { await cleanup(); } catch (e) { console.log("cleanup error:", e.message); }
  await Promise.all(conns.map((c) => c.end()));
}
console.log(`\nA51-C: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
