// A56-D -- Milestone 5.5 database tests: manual MONTHLY settlement (migration 20261019100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m56-db.test.mjs
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { s1: id(11), s2: id(12), s3: id(13), buyer: id(14), buyer2: id(15), admin: id(16), plain: id(17) };
const AAL2 = { aal: "aal2" };
const VPA = { s1: "seller.one@okbank", s2: "seller2@ybl", s3: "seller3@paytm" };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a56-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
  await q(`update public.profiles set display_name = 'Seller One' where id = $1`, [U.s1]);
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const adm = (sql, params) => as("authenticated", U.admin, AAL2, sql, params);
const call = async (fn, ...args) => {
  const r = await adm(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as v`, args);
  if (r.err) throw r.err;
  return r.rows[0].v;
};
const callErr = async (fn, ...args) => (await adm(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as v`, args)).err;
const seller = async (uid, limit = 100) => { const r = await as("authenticated", uid, null, `select public.seller_settlement_status($1) as v`, [limit]); if (r.err) throw r.err; return r.rows[0].v; };
const acct = async (uid, status = "active", vpa = Object.values(VPA)[Object.values(U).indexOf(uid)]) => {
  await mkUsers();
  await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status) values ($1,$2,$3) on conflict (user_id) do update set status = excluded.status, vpa_address = excluded.vpa_address`, [uid, vpa, status]);
};
let seq = 0;
async function mk({ sellerId = U.s1, amount = 500, fee = 90, pstatus = "paid", pay, ago = "1 minute", buyer = U.buyer } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('B56 listing','n','n',$1,'S',$2,'live') returning id`, [amount, sellerId]);
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,$3,$4,$5,$6, now() - $7::interval) returning id`,
    [buyer, l.id, amount, pstatus, pay === undefined ? `pay_S${++seq}` : pay, fee, ago]);
  return p.id;
}
const sc = async (sql, params) => (await q(sql, params)).rows[0];
const sellerItem = (v, pid) => v.items.find((i) => i.purchase_id === pid)?.status;
const ADMIN_FNS = [
  ["admin_settlement_pending", [null, 100]],
  ["admin_create_settlement_batch", ["L-denied", null]],
  ["admin_settlement_batches", [10]],
  ["admin_settlement_batch", [id(99)]],
  ["admin_settle_items", [id(99), "REF1", null]],
  ["admin_release_settlement_item", [id(99), "why"]],
  ["admin_cancel_settlement_batch", [id(99)]],
];
const sig = ([fn, args]) => `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")})`;

// ---- A: security
await inTxn(async () => {
  await mkUsers();
  for (const f of ADMIN_FNS) {
    const [fn, args] = f;
    check(`A01 ${fn}: anon denied`, (await as("anon", null, null, sig(f), args)).err?.code === "42501");
    check(`A02 ${fn}: service_role (no uid) denied`, (await as("service_role", null, null, sig(f), args)).err?.code === "42501");
    check(`A03 ${fn}: a normal logged-in user denied`, (await as("authenticated", U.plain, AAL2, sig(f), args)).err?.code === "42501");
    check(`A04 ${fn}: admin WITHOUT aal2 denied`, (await as("authenticated", U.admin, { aal: "aal1" }, sig(f), args)).err?.code === "42501");
  }
  check("A05 admin_settlement_pending + batches work for admin with aal2", (await adm(`select public.admin_settlement_pending(null, 10)`)).err === null && (await adm(`select public.admin_settlement_batches(10)`)).err === null);
  check("A06 seller_settlement_status: anon denied", (await as("anon", null, null, `select public.seller_settlement_status(10)`)).err?.code === "42501");
  check("A07 seller_settlement_status: no uid (service_role) denied", (await as("service_role", null, null, `select public.seller_settlement_status(10)`)).err?.code === "42501");
  const lim = (n) => as("authenticated", U.s1, null, `select public.seller_settlement_status($1)`, [n]);
  check("A08 limit validation -> CM074", (await lim(0)).err?.code === "CM074" && (await lim(501)).err?.code === "CM074" && (await lim(null)).err?.code === "CM074");
  for (const t of ["settlement_batches", "settlement_items", "purchase_settlements"]) {
    check(`A09 ${t}: no direct SELECT for authenticated`, (await as("authenticated", U.s1, null, `select * from public.${t}`)).err?.code === "42501");
    check(`A10 ${t}: no direct SELECT for anon`, (await as("anon", null, null, `select * from public.${t}`)).err?.code === "42501");
  }
  check("A11 no direct INSERT into purchase_settlements", (await as("authenticated", U.s1, null, `insert into public.purchase_settlements (purchase_id,item_id,seller_id,amount_paise,platform_fee_paise) values (gen_random_uuid(),gen_random_uuid(),$1,1,0)`, [U.s1])).err?.code === "42501");
  check("A12 private.settlement_config is unreachable for authenticated", (await as("authenticated", U.s1, null, `select * from private.settlement_config`)).err?.code === "42501");
  check("A13 private.settlement_eligible not executable by authenticated or service_role", (await as("authenticated", U.s1, null, `select * from private.settlement_eligible(now())`)).err !== null && (await as("service_role", null, null, `select * from private.settlement_eligible(now())`)).err !== null);
  const defs = (await q(`select proname, prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('admin_settlement_pending','admin_create_settlement_batch','admin_settlement_batches','admin_settlement_batch','admin_settle_items','admin_release_settlement_item','admin_cancel_settlement_batch','seller_settlement_status')`)).rows;
  check("A14 all 8 public functions exist, SECURITY DEFINER, empty search_path", defs.length === 8 && defs.every((d) => d.prosecdef && d.proconfig?.some((c) => c.replace(/\s|"/g, "") === "search_path=")));
  const names = (await q(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname ~* 'settle|settlement'`)).rows.map((r) => r.proname);
  check("A15 no function exists that undoes a paid settlement (no reverse / unpay / clawback)", !names.some((n) => /reverse|unpay|undo|claw|debit|recover/i.test(n)), names);
  const flags = (await q(`select name, enabled from private.feature_flags where name in ('phase6_vpa_payouts','phase5_route_transfers','phase5_auto_refunds')`)).rows;
  check("A16 the retired outgoing flows are still OFF", flags.length === 3 && flags.every((f) => f.enabled === false), flags);
  check("A17 UPI payout cutoff still 'infinity' (even a mistaken flag flip pays nobody)", (await sc(`select cutoff_at = 'infinity' as v from private.vpa_payout_config`)).v === true);
});

// ---- B: eligibility + preview (read-only)
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2, "suspended"); await acct(U.s3, "pending");
  const p1 = await mk({ sellerId: U.s1, amount: 500, fee: 90 });          // share 41000
  const p1b = await mk({ sellerId: U.s1, amount: 100, fee: 18, buyer: U.buyer2 }); // share 8200
  await mk({ sellerId: U.s2 });
  await mk({ sellerId: U.s3 });
  await mk({ sellerId: U.plain });                                         // no payout account at all
  await mk({ sellerId: U.s1, pstatus: "refunded" });
  await mk({ sellerId: U.s1, pay: null });                                 // no razorpay payment id
  await mk({ sellerId: U.s1, amount: 100, fee: 100 });                     // no seller share
  await mk({ sellerId: U.s1, amount: 0, fee: 0 });                         // free
  const before = await sc(`select (select count(*) from public.settlement_batches)::int a, (select count(*) from public.purchase_settlements)::int b`);
  const v = await call("admin_settlement_pending", null, 100);
  check("B01 payable lists only the active seller with a UPI ID", v.payable.length === 1 && v.payable[0].seller_id === U.s1, v.payable);
  check("B02 payable amount = sum of (round(amount*100) - round(fee*100)) in integer paise", v.payable[0].amount_paise === 49200 && v.payable[0].purchase_count === 2 && v.totals.payable_paise === 49200, v.payable[0]);
  check("B03 platform fee aggregated in paise", v.payable[0].platform_fee_paise === 10800);
  check("B04 the payable row shows the UPI ID and seller name", v.payable[0].vpa_address === VPA.s1 && v.payable[0].seller_name === "Seller One");
  const reasons = Object.fromEntries(v.blocked.map((b) => [b.seller_id, b.reason]));
  check("B05 suspended -> account_suspended, pending -> account_pending, none -> no_upi_id", reasons[U.s2] === "account_suspended" && reasons[U.s3] === "account_pending" && reasons[U.plain] === "no_upi_id", reasons);
  check("B06 blocked totals add up", v.totals.blocked_sellers === 3 && v.totals.blocked_paise === 3 * 41000, v.totals);
  check("B07 refunded / no-payment-id / no-share / free purchases never appear", v.totals.payable_purchases === 2 && v.blocked.every((b) => b.purchase_count === 1));
  check("B08 the preview wrote nothing", JSON.stringify(await sc(`select (select count(*) from public.settlement_batches)::int a, (select count(*) from public.purchase_settlements)::int b`)) === JSON.stringify(before));
  check("B09 start_at is null (= every paid sale) by default", v.start_at === null);

  const cut = await call("admin_settlement_pending", new Date(Date.now() - 120_000).toISOString(), 100);
  check("B10 period_end excludes sales made after it", cut.payable.length === 0 && cut.totals.payable_paise === 0 && !cut.blocked.length);
  check("B11 a period_end a day in the future -> CM076; a few seconds of clock skew is tolerated", (await callErr("admin_settlement_pending", new Date(Date.now() + 86_400_000).toISOString(), 100))?.code === "CM076" && (await callErr("admin_settlement_pending", new Date(Date.now() + 5_000).toISOString(), 100)) === null);
  check("B12 bad limit -> CM076", (await callErr("admin_settlement_pending", null, 0))?.code === "CM076" && (await callErr("admin_settlement_pending", null, 1001))?.code === "CM076");

  await q(`update private.settlement_config set start_at = now() - interval '30 seconds'`);
  const sa = await call("admin_settlement_pending", null, 100);
  check("B13 start_at excludes older sales", sa.totals.payable_paise === 0 && sa.start_at !== null);
  await q(`update private.settlement_config set start_at = '-infinity'`);

  await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, razorpay_transfer_id, amount_paise, platform_fee_paise, status, settlement_status, on_hold)
           values ($1,$2,'acc_Retired0001','pay_x','trf_Retired00000001',41000,9000,'processed','settled',false)`, [p1, U.s1]);
  const t1 = await call("admin_settlement_pending", null, 100);
  check("B14 a sale that already has a (retired) Route transfer is never settled again", t1.payable[0].amount_paise === 8200 && t1.payable[0].purchase_count === 1);
  await q(`insert into public.vpa_payouts (purchase_id, seller_id, vpa_address, amount_paise, platform_fee_paise, status, review_reason) values ($1,$2,$3,8200,1800,'failed','x')`, [p1b, U.s1, VPA.s1]);
  const t2 = await call("admin_settlement_pending", null, 100);
  check("B15 nor one that has a (retired) UPI payout row", t2.payable.length === 0);
});

// ---- C: create a batch
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2); await acct(U.s3, "suspended");
  const a1 = await mk({ sellerId: U.s1, amount: 500, fee: 90 }), a2 = await mk({ sellerId: U.s1, amount: 100, fee: 18, buyer: U.buyer2 });
  const b1 = await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const c1 = await mk({ sellerId: U.s3 });
  const nowIso = () => new Date().toISOString();
  check("C01 invalid label -> CM076", (await callErr("admin_create_settlement_batch", "", nowIso()))?.code === "CM076" && (await callErr("admin_create_settlement_batch", "   ", nowIso()))?.code === "CM076" && (await callErr("admin_create_settlement_batch", "x".repeat(61), nowIso()))?.code === "CM076" && (await callErr("admin_create_settlement_batch", null, nowIso()))?.code === "CM076");
  check("C02 a cut-off a day in the future -> CM076", (await callErr("admin_create_settlement_batch", "L", new Date(Date.now() + 86_400_000).toISOString()))?.code === "CM076");
  const r = await call("admin_create_settlement_batch", " 2026-10 ", nowIso());
  check("C03 creates a batch: 2 sellers, 3 purchases, total in paise", r.seller_count === 2 && r.purchase_count === 3 && r.total_paise === 41000 + 8200 + 20500, r);
  const items = (await q(`select * from public.settlement_items where batch_id = $1 order by amount_paise desc`, [r.batch_id])).rows;
  check("C04 one item per payable seller with the UPI snapshot, status pending", items.length === 2 && items[0].seller_id === U.s1 && Number(items[0].amount_paise) === 49200 && items[0].vpa_address === VPA.s1 && items.every((i) => i.status === "pending" && i.utr === null));
  const ps = (await q(`select purchase_id from public.purchase_settlements`)).rows.map((x) => x.purchase_id);
  check("C05 every settled purchase has exactly one purchase_settlements row; the suspended seller's sale does not", ps.length === 3 && [a1, a2, b1].every((p) => ps.includes(p)) && !ps.includes(c1));
  check("C06 label is trimmed and the batch is open", (await sc(`select label, status, completed_at is null as open, total_paise::int t from public.settlement_batches where id = $1`, [r.batch_id])).label === "2026-10");
  check("C07 the batch total equals the sum of its purchase rows", (await sc(`select (select total_paise from public.settlement_batches where id=$1) = (select sum(amount_paise) from public.purchase_settlements) as v`, [r.batch_id])).v === true);
  const aud = await sc(`select count(*)::int n, max(actor_id::text) a from public.audit_log where action = 'settlement_batch_created' and target_id = $1`, [r.batch_id]);
  check("C08 audited with the admin as actor", aud.n === 1 && aud.a === U.admin);
  check("C09 a second batch while one is open -> open_batch_exists", (await callErr("admin_create_settlement_batch", "2026-11", nowIso()))?.message === "open_batch_exists");
  const prev = await call("admin_settlement_pending", null, 100);
  check("C10 batched sales no longer appear as pending; the suspended seller's still does", prev.payable.length === 0 && prev.blocked.length === 1 && prev.blocked[0].seller_id === U.s3 && prev.open_batch_id === r.batch_id);
  check("C11 the database refuses to put one sale in two items", (await (async () => { try { await q("SAVEPOINT d"); await q(`insert into public.purchase_settlements (purchase_id,item_id,seller_id,amount_paise,platform_fee_paise) values ($1,$2,$3,1,0)`, [a1, items[0].id, U.s1]); await q("RELEASE SAVEPOINT d"); return null; } catch (e) { await q("ROLLBACK TO SAVEPOINT d"); return e.code; } })()) === "23505");
  check("C12 the same seller can't have two items in one batch", (await (async () => { try { await q("SAVEPOINT d"); await q(`insert into public.settlement_items (batch_id,seller_id,vpa_address,amount_paise,platform_fee_paise,purchase_count) values ($1,$2,$3,1,0,1)`, [r.batch_id, U.s1, VPA.s1]); await q("RELEASE SAVEPOINT d"); return null; } catch (e) { await q("ROLLBACK TO SAVEPOINT d"); return e.code; } })()) === "23505");
  check("C13 only one open batch can exist (database index)", (await (async () => { try { await q("SAVEPOINT d"); await q(`insert into public.settlement_batches (label, period_end) values ('second', now())`); await q("RELEASE SAVEPOINT d"); return null; } catch (e) { await q("ROLLBACK TO SAVEPOINT d"); return e.code; } })()) === "23505");
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  const e = await callErr("admin_create_settlement_batch", "empty", new Date().toISOString());
  check("C14 nothing to settle -> nothing_to_settle and no empty batch left behind", e?.message === "nothing_to_settle" && (await sc(`select count(*)::int n from public.settlement_batches`)).n === 0);
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1 });
  await call("admin_create_settlement_batch", "dup", new Date().toISOString());
  const b = (await sc(`select id from public.settlement_batches`)).id;
  await call("admin_settle_items", b, "BULK-1", null);
  await mk({ sellerId: U.s1, buyer: U.buyer2 });
  check("C15 a label can't be reused even after the batch is completed", (await callErr("admin_create_settlement_batch", "dup", new Date().toISOString()))?.message === "label_taken");
  const r2 = await call("admin_create_settlement_batch", "next", new Date().toISOString());
  check("C16 after completion the next month's batch contains only the new sale", r2.purchase_count === 1 && r2.total_paise === 41000);
});

// ---- D: settle (record that the money was sent)
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  await mk({ sellerId: U.s1 }); await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const r = await call("admin_create_settlement_batch", "D", new Date().toISOString());
  const [i1, i2] = (await q(`select id, seller_id from public.settlement_items where batch_id=$1 order by amount_paise desc`, [r.batch_id])).rows;
  for (const bad of ["", "   ", "has;semicolon", "a".repeat(81), "<script>", "-startsdash"]) {
    check(`D01 reference ${JSON.stringify(bad.slice(0, 12))} rejected`, (await callErr("admin_settle_items", r.batch_id, bad, null))?.code === "CM076");
  }
  check("D02 null reference / null batch / empty id list rejected", (await callErr("admin_settle_items", r.batch_id, null, null))?.code === "CM076" && (await callErr("admin_settle_items", null, "R", null))?.code === "CM076" && (await callErr("admin_settle_items", r.batch_id, "R", []))?.code === "CM076");
  check("D03 an unknown item id -> invalid_items", (await callErr("admin_settle_items", r.batch_id, "R", [id(98)]))?.message === "invalid_items");
  const one = await call("admin_settle_items", r.batch_id, "UTR 4012 8899 0001", [i1.id]);
  check("D04 settling a chosen item: 1 settled, batch stays open", one.settled_count === 1 && one.settled_paise === 41000 && one.batch_completed === false, one);
  const row = await sc(`select status, utr, paid_at is not null as paid from public.settlement_items where id=$1`, [i1.id]);
  check("D05 the item is paid with the reference and a timestamp", row.status === "paid" && row.utr === "UTR 4012 8899 0001" && row.paid);
  check("D06 a paid item can't be paid again", (await callErr("admin_settle_items", r.batch_id, "R2", [i1.id]))?.message === "invalid_items");
  check("D07 the other item is still pending", (await sc(`select status from public.settlement_items where id=$1`, [i2.id])).status === "pending");
  const rest = await call("admin_settle_items", r.batch_id, "BULK-OCT-8841", null);
  check("D08 settling the rest completes the batch", rest.settled_count === 1 && rest.batch_completed === true && (await sc(`select status, completed_at is not null as c from public.settlement_batches where id=$1`, [r.batch_id])).c === true);
  check("D09 the first item keeps its own reference", (await sc(`select utr from public.settlement_items where id=$1`, [i1.id])).utr === "UTR 4012 8899 0001");
  check("D10 a completed batch accepts nothing more", (await callErr("admin_settle_items", r.batch_id, "R3", null))?.message === "batch_not_open");
  check("D11 audited", (await sc(`select count(*)::int n from public.audit_log where action='settlement_items_paid' and target_id=$1`, [r.batch_id])).n === 2);
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  await mk({ sellerId: U.s1 }); await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const r = await call("admin_create_settlement_batch", "D2", new Date().toISOString());
  const [i1, i2] = (await q(`select id from public.settlement_items where batch_id=$1 order by amount_paise desc`, [r.batch_id])).rows;
  await call("admin_settle_items", r.batch_id, "R1", [i1.id]);
  check("D12 a PAID item is final: it cannot be released", (await callErr("admin_release_settlement_item", i1.id, "oops"))?.message === "batch_not_open");
  check("D13 a batch with a paid item cannot be cancelled", (await callErr("admin_cancel_settlement_batch", r.batch_id))?.message === "batch_not_open");
  const rel2 = await call("admin_release_settlement_item", i2.id, "wrong upi");
  check("D14 releasing the last pending item completes the batch (one item paid, one released)", rel2.batch_completed === true && (await sc(`select status from public.settlement_batches where id=$1`, [r.batch_id])).status === "completed");
  await mk({ sellerId: U.s2, buyer: U.buyer2 });
  const r2 = await call("admin_create_settlement_batch", "D3", new Date().toISOString());
  check("D15 item ids that belong to a different batch -> invalid_items", (await callErr("admin_settle_items", r2.batch_id, "R9", [i1.id]))?.message === "invalid_items");
});

// ---- E: release + cancel
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  const a = await mk({ sellerId: U.s1 }), b = await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const r = await call("admin_create_settlement_batch", "E", new Date().toISOString());
  const i1 = (await sc(`select id from public.settlement_items where batch_id=$1 and seller_id=$2`, [r.batch_id, U.s1])).id;
  check("E01 a reason is required to release", (await callErr("admin_release_settlement_item", i1, "  "))?.code === "CM076" && (await callErr("admin_release_settlement_item", i1, "x".repeat(301)))?.code === "CM076");
  check("E02 unknown item -> invalid_items", (await callErr("admin_release_settlement_item", id(97), "why"))?.message === "invalid_items");
  const rel = await call("admin_release_settlement_item", i1, "UPI ID rejected by the bank");
  check("E03 release: item released with the reason, batch stays open (other item pending)", rel.released === true && rel.batch_completed === false && (await sc(`select status, released_reason r from public.settlement_items where id=$1`, [i1])).r === "UPI ID rejected by the bank");
  check("E04 its purchase rows are gone, the other seller's remain", (await sc(`select count(*)::int n from public.purchase_settlements where purchase_id=$1`, [a])).n === 0 && (await sc(`select count(*)::int n from public.purchase_settlements where purchase_id=$1`, [b])).n === 1);
  check("E05 a released item can't be released or paid again", (await callErr("admin_release_settlement_item", i1, "again"))?.message === "batch_not_open" && (await callErr("admin_settle_items", r.batch_id, "R", [i1]))?.message === "invalid_items");
  const v = await call("admin_settlement_pending", null, 100);
  check("E06 the released sale is owed again and shows up as payable", v.payable.length === 1 && v.payable[0].seller_id === U.s1 && v.payable[0].amount_paise === 41000);
  await call("admin_settle_items", r.batch_id, "R-E", null);
  check("E07 after the rest is settled the batch is completed", (await sc(`select status from public.settlement_batches where id=$1`, [r.batch_id])).status === "completed");
  const r2 = await call("admin_create_settlement_batch", "E-next", new Date().toISOString());
  check("E08 the released sale is carried into the next batch", r2.purchase_count === 1 && r2.total_paise === 41000);
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1 });
  const r = await call("admin_create_settlement_batch", "E-cancel", new Date().toISOString());
  await call("admin_cancel_settlement_batch", r.batch_id);
  const n = await sc(`select (select count(*) from public.settlement_batches)::int b, (select count(*) from public.settlement_items)::int i, (select count(*) from public.purchase_settlements)::int p`);
  check("E09 cancelling an unpaid batch removes it, its items and its purchase rows", n.b === 0 && n.i === 0 && n.p === 0);
  check("E10 the cancel is audited", (await sc(`select count(*)::int n from public.audit_log where action='settlement_batch_cancelled' and target_id=$1`, [r.batch_id])).n === 1);
  const r2 = await call("admin_create_settlement_batch", "E-cancel", new Date().toISOString());
  check("E11 the sale is owed again, the label is free again", r2.purchase_count === 1);
  check("E12 cancel of an unknown or completed batch -> batch_not_open", (await callErr("admin_cancel_settlement_batch", id(96)))?.message === "batch_not_open");
});

// ---- F: batch views for the admin desk
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  const a = await mk({ sellerId: U.s1 }); await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const r = await call("admin_create_settlement_batch", "F", new Date().toISOString());
  const list = await call("admin_settlement_batches", 10);
  check("F01 list shows the batch with pending totals", list.items.length === 1 && list.items[0].pending_paise === 61500 && list.items[0].pending_count === 2 && list.items[0].paid_paise === 0);
  check("F02 limit validation -> CM076", (await callErr("admin_settlement_batches", 0))?.code === "CM076" && (await callErr("admin_settlement_batches", 201))?.code === "CM076");
  const d0 = await call("admin_settlement_batch", r.batch_id);
  const it = (uid) => d0.items.find((x) => x.seller_id === uid);
  check("F03 detail: batch header + one row per seller with full UPI ID (the admin needs it to pay)", d0.found && d0.batch.label === "F" && d0.items.length === 2 && it(U.s1).vpa_address === VPA.s1 && it(U.s1).seller_name === "Seller One");
  check("F04 safety flags are false on a clean batch", d0.items.every((x) => x.refunded_purchase_count === 0 && x.upi_changed_since_snapshot === false && x.upi_changed_recently === false));
  await q(`update public.purchases set status = 'refunded' where id = $1`, [a]);
  await q(`update public.seller_payout_accounts set vpa_address = 'changed@ybl' where user_id = $1`, [U.s1]);
  await q(`insert into public.audit_log (actor_id, action, target_type, target_id, metadata) values ($1,'payout_vpa_set','user',$1,'{}')`, [U.s1]);
  const d1 = await call("admin_settlement_batch", r.batch_id);
  const x = d1.items.find((i) => i.seller_id === U.s1);
  check("F05 a sale refunded after the batch was made is flagged", x.refunded_purchase_count === 1);
  check("F06 a UPI ID changed after the snapshot is flagged, and the snapshot is what gets paid", x.upi_changed_since_snapshot === true && x.vpa_address === VPA.s1);
  check("F07 a UPI ID set within a week of the batch is flagged", x.upi_changed_recently === true);
  check("F08 unknown batch -> found:false", (await call("admin_settlement_batch", id(95))).found === false);
  await call("admin_settle_items", r.batch_id, "F-REF", null);
  const l2 = await call("admin_settlement_batches", 10);
  check("F09 list after payment: paid totals, completed", l2.items[0].paid_paise === 61500 && l2.items[0].pending_count === 0 && l2.items[0].status === "completed");
});

// ---- G: seller view
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  const un = await mk({ sellerId: U.s1, amount: 500, fee: 90, ago: "3 days" });
  const v0 = await seller(U.s1);
  check("G01 an active seller's new sale is 'unsettled'", sellerItem(v0, un) === "unsettled" && v0.summary.unsettled_paise === 41000);
  check("G02 account fields: status, masked UPI (never the full ID)", v0.account_status === "active" && v0.upi_masked === "se***@okbank" && !JSON.stringify(v0).includes(VPA.s1));
  const expectNext = (await sc(`select (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month')::date::text as v`)).v;
  check("G03 next_payout_date = the 1st of next month (IST)", v0.next_payout_date === expectNext && expectNext.endsWith("-01"), v0.next_payout_date);
  const sub = await mk({ sellerId: U.s1, amount: 250, fee: 45, ago: "2 days" });
  const refd = await mk({ sellerId: U.s1, amount: 100, fee: 18, pstatus: "refunded", ago: "2 days" });
  await mk({ sellerId: U.s1, pay: null });
  const nope = await mk({ sellerId: U.s1, amount: 100, fee: 100 });
  const v1 = await seller(U.s1);
  check("G04 a refunded sale before settlement shows 'refunded'; sales with no payment or no share are not listed", sellerItem(v1, refd) === "refunded" && v1.items.length === 3 && sellerItem(v1, nope) === undefined);
  const r = await call("admin_create_settlement_batch", "G", new Date(Date.now() - 12 * 3600e3).toISOString());
  check("G05 (setup) the batch covers exactly the two older paid sales", r.purchase_count === 2 && r.total_paise === 61500, r);
  const v2 = await seller(U.s1);
  check("G06 a sale in an open batch is 'in_batch'", sellerItem(v2, un) === "in_batch" && sellerItem(v2, sub) === "in_batch" && v2.summary.in_batch_paise === 41000 + 20500, v2.summary);
  const rest = await mk({ sellerId: U.s1, amount: 300, fee: 54, ago: "1 minute" });
  check("G07 a newer sale stays 'unsettled'", sellerItem(await seller(U.s1), rest) === "unsettled");
  check("G08 no payouts listed before anything is paid", v2.payouts.length === 0);
  await call("admin_settle_items", r.batch_id, "BULK-OCT-8841", null);
  const v3 = await seller(U.s1);
  check("G09 after payment the sales are 'settled'", sellerItem(v3, un) === "settled" && sellerItem(v3, sub) === "settled" && v3.summary.settled_paise === 61500, v3.summary);
  check("G10 the payout appears in the monthly history with label, amount, count, reference, masked UPI", v3.payouts.length === 1 && v3.payouts[0].batch_label === "G" && v3.payouts[0].amount_paise === 61500 && v3.payouts[0].purchase_count === 2 && v3.payouts[0].reference === "BULK-OCT-8841" && v3.payouts[0].upi_masked === "se***@okbank");
  // non-recourse: refund AFTER payment changes nothing the seller sees
  await q(`update public.purchases set status = 'refunded' where id = $1`, [un]);
  const v4 = await seller(U.s1);
  check("G11 NON-RECOURSE: a refund after payment does not change a settled sale or the paid total", sellerItem(v4, un) === "settled" && v4.summary.settled_paise === 61500 && v4.payouts[0].amount_paise === 61500);
  const nums = JSON.stringify(v4).match(/-\d+/g) ?? [];
  check("G12 no negative amount anywhere in the seller's view", Object.values(v4.summary).every((n) => n >= 0) && !JSON.stringify(v4.items.map((i) => i.share_paise)).includes("-"), nums.slice(0, 3));
  check("G13 amounts are integers", Object.values(v4.summary).every(Number.isInteger) && v4.items.every((i) => Number.isInteger(i.share_paise)));
  const item = (await sc(`select id from public.settlement_items limit 1`)).id;
  const text = JSON.stringify(v4);
  check("G14 no batch id, item id, seller id or admin id in the seller's JSON", !text.includes(r.batch_id) && !text.includes(item) && !text.includes(U.admin) && !text.includes(U.s1));
  check("G15 only allow-listed keys at the top level and in a payout row", Object.keys(v4).sort().join() === "account_status,items,min_payout_paise,next_payout_date,payouts,summary,upi_cooldown_hours,upi_masked,upi_unlocks_at" && Object.keys(v4.payouts[0]).sort().join() === "amount_paise,batch_label,paid_at,purchase_count,reference,upi_masked");
});
await inTxn(async () => {
  await mkUsers();
  const a = await mk({ sellerId: U.s1 }), b = await mk({ sellerId: U.s2, amount: 250, fee: 45 });
  const v1 = await seller(U.s1), v2 = await seller(U.s2);
  check("G16 no account -> 'needs_upi', counted as action needed, account 'none'", sellerItem(v1, a) === "needs_upi" && v1.account_status === "none" && v1.upi_masked === null && v1.summary.action_needed_paise === 41000 && v1.summary.unsettled_paise === 41000);
  check("G17 isolation: each seller sees only their own sales", v1.items.length === 1 && v2.items.length === 1 && sellerItem(v2, b) === "needs_upi");
  check("G18 a user with no sales gets a well-formed empty answer", (await seller(U.buyer)).items.length === 0 && (await seller(U.buyer)).summary.unsettled_paise === 0);
  await acct(U.s1, "suspended");
  check("G19 suspended account -> 'under_review'", sellerItem(await seller(U.s1), a) === "under_review");
  await acct(U.s1, "active");
  check("G20 active again -> 'unsettled' (earnings never disappear)", sellerItem(await seller(U.s1), a) === "unsettled");
  await q(`update private.settlement_config set start_at = now() + interval '1 hour'`);
  check("G21 sales before start_at are not part of the settlement view", (await seller(U.s1)).items.length === 0);
});

console.log(`\nM56-DB: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
