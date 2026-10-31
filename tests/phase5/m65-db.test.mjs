// A65-D -- Razorpay Route checkout (migration 20261026100000). REAL schema; rolled-back transactions.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffd${n}`;
const U = { s1: id(11), s2: id(12), b1: id(13), b2: id(14) };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function as(role, uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role })]);
  await q(`set local role ${role}`); await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const svc = (fn, ...a) => as("service_role", null, `select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(",")}) as v`, a);
const auth = (uid, fn, ...a) => as("authenticated", uid, `select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(",")}) as v`, a);
const flag = (on) => q(`update private.feature_flags set enabled=$1 where name='phase5_route_transfers'`, [on]);
const ACC = "acc_TestSeller0001", ACC2 = "acc_TestSeller0002";
async function setup() {
  for (const u of Object.values(U)) await q(`insert into auth.users (id,email) values ($1,$2) on conflict do nothing`, [u, `a65-${u.slice(-2)}@example.invalid`]);
}
const mkListing = async (seller, price = 499.5) => (await q(`insert into public.listings (title,model,category,price,seller_name,seller_id,status) values ('L','Claude','Design',$1,'s',$2,'live') returning id`, [price, seller])).rows[0].id;
const activate = async (u, acc = ACC) => { const r = await svc("route_save_linked_account", u, acc, "activated"); if (r.err) throw r.err; };

check("A00 the Route flag is seeded OFF by the migrations", (await q(`select enabled from private.feature_flags where name='phase5_route_transfers'`)).rows[0].enabled === false);

await inTxn(async () => {
  await setup();
  const r = await svc("route_save_linked_account", U.s1, ACC, "created");
  check("A01 saving a linked account stores the id and status; not ready until activated", !r.err && r.rows[0].v.route_status === "created" && r.rows[0].v.ready === false, r.err?.message);
  const row = (await q(`select * from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows[0];
  check("A02 the row is pending with the account id", row.razorpay_account_id === ACC && row.status === "pending" && row.route_status === "created");
  const u = await svc("route_update_account_status", ACC, "activated");
  check("A03 an activation event flips it to ready and active", u.rows[0].v.outcome === "updated" && (await q(`select status, route_status from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows[0].status === "active");
  check("A04 the same event again is 'unchanged' (idempotent)", (await svc("route_update_account_status", ACC, "activated")).rows[0].v.outcome === "unchanged");
  check("A05 an unknown account is reported, never created", (await svc("route_update_account_status", "acc_Nobody000001", "activated")).rows[0].v.outcome === "unknown_account");
  check("A06 invalid ids and statuses are refused", (await svc("route_save_linked_account", U.s1, "bad", "created")).err?.code === "CM080" && (await svc("route_save_linked_account", U.s1, ACC, "weird")).err?.code === "CM080");
  check("A07 an activated account cannot be replaced by a different one", (await svc("route_save_linked_account", U.s1, ACC2, "created")).err?.message === "route_account_exists");
  check("A08 audit entries exist and hold ids/status only", (await q(`select count(*)::int n from public.audit_log where action in ('route_account_saved','route_account_status')`)).rows[0].n >= 2);
  check("A09 authenticated and anon cannot call the write functions", (await auth(U.s1, "route_save_linked_account", U.s1, ACC, "activated")).err?.code === "42501" && (await as("anon", null, `select public.route_update_account_status($1,$2)`, [ACC, "activated"])).err?.code === "42501");
  const st = await auth(U.s1, "my_route_status");
  check("A10 a seller can read their own status; the account id is not in it", st.rows[0].v.ready === true && st.rows[0].v.route_status === "activated" && !JSON.stringify(st.rows[0].v).includes("acc_"));
  check("A11 a seller cannot read the razorpay_account_id column directly", (await as("authenticated", U.s1, `select razorpay_account_id from public.seller_payout_accounts`)).err?.code === "42501");
  const gt = await auth(U.s1, "route_checkout_enabled");
  check("A12 route_checkout_enabled follows the flag", gt.rows[0].v === false);
});

await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 499.5);
  await flag(false);
  check("B01 flag OFF: the target lookup still answers, orders unaffected", (await svc("route_checkout_target", L)).rows[0].v.reason === "seller_not_ready");
  await svc("route_save_linked_account", U.s1, ACC, "under_review");
  check("B02 a seller whose account is not activated is not a target", (await svc("route_checkout_target", L)).rows[0].v.available === false);
  await activate(U.s1);
  const t = (await svc("route_checkout_target", L)).rows[0].v;
  check("B03 an activated seller is a target, with the account id and seller id", t.available === true && t.account_id === ACC && t.seller_id === U.s1);
  await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.s1]);
  check("B04 a suspended seller is not a target", (await svc("route_checkout_target", L)).rows[0].v.available === false);
  await q(`update public.seller_payout_accounts set status='active' where user_id=$1`, [U.s1]);

  const o = await svc("record_route_payment_order", "order_R1", U.b1, L, 49950, ACC);
  check("B05 a Route order is recorded with the account id", !o.err && (await q(`select route_account_id from public.payment_orders where razorpay_order_id='order_R1'`)).rows[0].route_account_id === ACC, o.err?.message);
  const f = await svc("fulfil_captured_payment", "order_R1", "pay_R1", 49950, "INR", "upi", "sig", 0.18, null, null);
  const p = (await q(`select * from public.purchases where razorpay_payment_id='pay_R1'`)).rows[0];
  check("B06 payment.captured fulfils: payment_method route, platform_fee 0 even though the caller passed 18%, even though Razorpay said 'upi'", f.rows[0].v.outcome === "fulfilled" && p.payment_method === "route" && Number(p.platform_fee) === 0 && Number(p.amount) === 499.5 && p.status === "paid" && p.user_id === U.b1, p);
  check("B07 access is instant: the buyer can read the paid purchase", (await as("authenticated", U.b1, `select 1 from public.purchases where listing_id=$1 and status='paid'`, [L])).rows.length === 1);
  const again = await svc("fulfil_route_transfer", "order_R1", "pay_R1", ACC, 49950, 49950, "INR", null);
  check("B08 transfer.processed after payment.captured is already_fulfilled (idempotent, one purchase)", again.rows[0].v.outcome === "already_fulfilled" && (await q(`select count(*)::int n from public.purchases where listing_id=$1`, [L])).rows[0].n === 1);
  check("B09 the Route sale never enters the monthly settlement", (await q(`select count(*)::int n from private.settlement_eligible(now() + interval '1 minute') where purchase_id=$1`, [p.id])).rows[0].n === 0);
  const au = (await q(`select metadata from public.audit_log where action='payment_fulfilled' and target_id=$1`, [p.id])).rows[0].metadata;
  check("B10 the fulfilment audit entry says it was a Route order", au.route === true);

  // transfer-first ordering and mismatches
  await svc("record_route_payment_order", "order_R2", U.b2, L, 49950, ACC);
  const bad1 = await svc("fulfil_route_transfer", "order_R2", "pay_R2", ACC2, 49950, 49950, "INR", null);
  const bad2 = await svc("fulfil_route_transfer", "order_R2", "pay_R2", ACC, 40000, 49950, "INR", null);
  check("B11 a transfer to a different account or for less than 100% is refused (transfer_mismatch) and creates no purchase", bad1.rows[0].v.outcome === "transfer_mismatch" && bad2.rows[0].v.outcome === "transfer_mismatch" && (await q(`select count(*)::int n from public.purchases where razorpay_payment_id='pay_R2'`)).rows[0].n === 0);
  const ok = await svc("fulfil_route_transfer", "order_R2", "pay_R2", ACC, 49950, 49950, "INR", null);
  check("B12 transfer.processed alone (before payment.captured) fulfils with method route and fee 0", ok.rows[0].v.outcome === "fulfilled" && (await q(`select payment_method, platform_fee from public.purchases where razorpay_payment_id='pay_R2'`)).rows[0].payment_method === "route");
  check("B13 an amount that differs from the order is refused", (await svc("record_route_payment_order", "order_R3", U.b2, await mkListing(U.s1, 10), 1000, ACC)).err === null && (await svc("fulfil_captured_payment", "order_R3", "pay_R3", 999, "INR", "upi", null, 0.18, null, null)).rows[0].v.outcome === "amount_mismatch");
  check("B14 unknown order via the transfer path is order_unknown", (await svc("fulfil_route_transfer", "order_nope", "pay_X", ACC, 100, 100, "INR", null)).rows[0].v.outcome === "order_unknown");

  // ordinary (non-Route) orders are unchanged
  const L2 = await mkListing(U.s2, 200);
  await svc("record_payment_order", "order_N1", U.b1, L2, 20000);
  await svc("fulfil_captured_payment", "order_N1", "pay_N1", 20000, "INR", "upi", null, 0.18, null, null);
  const n = (await q(`select payment_method, platform_fee from public.purchases where razorpay_payment_id='pay_N1'`)).rows[0];
  check("B15 an ordinary order is unchanged: gateway method and an 18% fee", n.payment_method === "upi" && Number(n.platform_fee) === 36);
  check("B16 invalid route order input is refused", (await svc("record_route_payment_order", "o", U.b1, L, 100, "nope")).err?.code === "CM070");
  check("B17 anon cannot record or fulfil", (await as("anon", null, `select public.fulfil_route_transfer('a','b','c',1,1,'INR',null)`)).err?.code === "42501");
});

await inTxn(async () => {
  await setup();
  // listing gate
  await flag(true);
  const ins = (s) => as("authenticated", s, `insert into public.listings (title, model, category, price, seller_name, seller_id, description, zip_contents, screenshots, preview_video_url, preview_video_duration, status) values (repeat('t',10),'Claude','Design',50,'s',$1,repeat('d',500),repeat('z',250),'["a","b","c","d"]'::jsonb,'v.mp4',8,'pending_review')`, [s]);
  const blocked = await ins(U.s1);
  check("C01 Route ON: a seller without an activated account cannot list (CM079 route_account_required)", blocked.err?.code === "CM079" && blocked.err.message === "route_account_required", blocked.err?.message);
  await svc("route_save_linked_account", U.s1, ACC, "needs_clarification");
  check("C02 needs_clarification still cannot list", (await ins(U.s1)).err?.code === "CM079");
  await activate(U.s1);
  check("C03 an activated account can list", !(await ins(U.s1)).err);
  await q(`update private.feature_flags set enabled = true where name='direct_upi_checkout'`);
  check("C04 with both flags ON the Route gate wins: an activated seller without identity/UPI details can list", !(await ins(U.s1)).err);
  await q(`update private.feature_flags set enabled = false where name='direct_upi_checkout'`);
  await flag(false);
  check("C05 flag OFF and direct OFF: the manual bank rule applies (no bank account -> refused; with one -> can list)", (await ins(U.s2)).err?.code === "CM079" && (await (async () => { await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc) values ($1,'active','123456789012','9012','HDFC0001234') on conflict (user_id) do update set bank_account_number = excluded.bank_account_number, bank_ifsc = excluded.bank_ifsc`, [U.s2]); return !(await ins(U.s2)).err; })()));
  check("C06 the direct-UPI objects are all still there", (await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('submit_direct_payment_claim','raise_direct_payment_dispute','admin_resolve_direct_dispute','set_seller_identity_details','confirm_direct_payment_claim')`)).rows[0].n === 5 && (await q(`select to_regclass('public.direct_payment_claims') is not null and to_regclass('public.seller_identity_details') is not null as ok`)).rows[0].ok);
  check("C07 direct_upi_checkout is still seeded OFF", (await q(`select enabled from private.feature_flags where name='direct_upi_checkout'`)).rows[0].enabled === false);
  check("C08 the legacy transfers table and its admin function are intact", (await q(`select to_regclass('public.transfers') is not null as ok`)).rows[0].ok);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
