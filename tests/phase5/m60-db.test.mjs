// A60-D -- Milestone 5.7 database tests: UPI-change cooldown (migration 20261021100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m60-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000ffd${n}`;
const U = { s1: id(11), s2: id(12), s3: id(13), buyer: id(14), buyer2: id(15), admin: id(16), plain: id(17) };
const AAL2 = { aal: "aal2" };
const VPA = { s1: "seller.one@okbank", s2: "seller2@ybl", s3: "seller3@paytm" };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a60-${uid.slice(-2)}@example.invalid`]);
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

const now = () => new Date().toISOString();
const setMin = (n) => q(`update private.settlement_config set min_payout_paise = $1`, [n]);
const setCool = (n) => q(`update private.settlement_config set upi_cooldown_hours = $1`, [n]);
const changedAgo = (uid, interval) => q(`update public.seller_payout_accounts set vpa_changed_at = now() - $2::interval where user_id = $1`, [uid, interval]);
const changedAt = async (uid) => (await sc(`select vpa_changed_at as v from public.seller_payout_accounts where user_id = $1`, [uid])).v;
const setVpa = async (uid, vpa) => { const r = await as("authenticated", uid, null, `select public.set_my_payout_vpa($1) as v`, [vpa]); if (r.err) throw r.err; return r.rows[0].v; };
const hrs = (a, b) => Math.round((new Date(a) - new Date(b)) / 360000) / 10;   // hours between two instants, 1 decimal
const reasonOf = (v, uid) => v.blocked.find((b) => b.seller_id === uid)?.reason;


// ---- A: schema, defaults, privileges
await inTxn(async () => {
  await mkUsers();
  const c1 = await sc(`select column_default d, is_nullable n, data_type t from information_schema.columns where table_schema='private' and table_name='settlement_config' and column_name='upi_cooldown_hours'`);
  check("A01 upi_cooldown_hours: integer, NOT NULL, default 72", c1.t === "integer" && c1.n === "NO" && c1.d === "72", c1);
  const c2 = await sc(`select is_nullable n, data_type t from information_schema.columns where table_schema='public' and table_name='seller_payout_accounts' and column_name='vpa_changed_at'`);
  check("A02 vpa_changed_at: timestamptz, nullable (NULL = never changed)", c2.t === "timestamp with time zone" && c2.n === "YES", c2);
  for (const bad of [-1, 721]) {
    check(`A03 cooldown ${bad} hours is refused by the table`, (await (async () => { try { await q("SAVEPOINT d"); await setCool(bad); await q("RELEASE SAVEPOINT d"); return null; } catch (e) { await q("ROLLBACK TO SAVEPOINT d"); return e.code; } })()) === "23514");
  }
  await acct(U.s1);
  check("A04 the new column is NOT readable by authenticated (column grants unchanged)", (await as("authenticated", U.s1, null, `select vpa_changed_at from public.seller_payout_accounts`)).err?.code === "42501");
  check("A05 the config table is still not reachable by API roles", (await as("authenticated", U.s1, null, `select upi_cooldown_hours from private.settlement_config`)).err?.code === "42501");
  const sigs = (await q(`select p.proname, p.prosecdef, (p.proconfig @> array['search_path=""']) cfg_ok, has_function_privilege('anon', p.oid, 'execute') anon_ok, has_function_privilege('authenticated', p.oid, 'execute') auth_ok, has_function_privilege('service_role', p.oid, 'execute') svc_ok from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('set_my_payout_vpa','admin_settlement_pending','admin_create_settlement_batch','seller_settlement_status','seller_upi_cooldown') order by 1`)).rows;
  check("A06 five functions, all SECURITY DEFINER with an empty search_path, authenticated yes, anon no", sigs.length === 5 && sigs.every((r) => r.prosecdef && r.cfg_ok && r.auth_ok && !r.anon_ok), sigs);
  check("A07 seller_upi_cooldown: anon and service_role (no user) are denied", (await as("anon", null, null, `select public.seller_upi_cooldown()`)).err?.code === "42501" && (await as("service_role", null, null, `select public.seller_upi_cooldown()`)).err?.code === "42501");
});

// ---- B: when the clock starts
await inTxn(async () => {
  await mkUsers();
  const first = await setVpa(U.s1, "first.id@okbank");
  check("B01 the FIRST save of a UPI ID starts no cooldown", first.outcome === "saved" && first.upi_unlocks_at === null && first.upi_cooldown_hours === 72 && (await changedAt(U.s1)) === null, first);
  const ch = await setVpa(U.s1, "second.id@okbank");
  const t = await changedAt(U.s1);
  check("B02 CHANGING it starts the cooldown: vpa_changed_at = now, unlock time = now + 72h", ch.outcome === "changed" && t !== null && hrs(ch.upi_unlocks_at, t) === 72 && Math.abs(new Date(t) - new Date()) < 60000, { ch, t });
  await changedAgo(U.s1, "2 days");
  const same = await setVpa(U.s1, "second.id@okbank");
  const t2 = await changedAt(U.s1);
  check("B03 re-saving the SAME ID changes nothing (the clock is not reset, nothing is extended)", same.outcome === "unchanged" && hrs(new Date(), t2) >= 47.9 && hrs(new Date(), t2) <= 48.1, { same, t2 });
  const again = await setVpa(U.s1, "third.id@okbank");
  check("B04 changing it AGAIN restarts the clock", again.outcome === "changed" && hrs(again.upi_unlocks_at, new Date()) > 71.9, again);
  check("B05 the change is audited and the audit row holds only the MASKED id", (await sc(`select count(*)::int n from public.audit_log where action='payout_vpa_set' and target_id=$1 and metadata->>'vpa' not like '%third.id%'`, [U.s1])).n === 3);
  await setCool(0);
  const off = await setVpa(U.s1, "fourth.id@okbank");
  check("B06 with the cooldown set to 0 a change is reported with no unlock time", off.outcome === "changed" && off.upi_unlocks_at === null && off.upi_cooldown_hours === 0, off);
  await setCool(72);
  // a row that exists WITHOUT a UPI ID (an old Route-era row) is a first save, not a change
  await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,'acc_Old0000000001','active')`, [U.s2]);
  const old = await setVpa(U.s2, "old.route@okbank");
  check("B07 a seller who had a row but no UPI ID yet is a first save: no cooldown", old.outcome === "saved" && old.upi_unlocks_at === null && (await changedAt(U.s2)) === null, old);
  check("B08 an invalid ID is still refused (CM075) and starts nothing", (await as("authenticated", U.s1, null, `select public.set_my_payout_vpa('not a upi')`)).err?.code === "CM075");
  await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.s1]);
  await setVpa(U.s1, "fifth.id@okbank");
  check("B09 a suspension still survives a change", (await sc(`select status s from public.seller_payout_accounts where user_id=$1`, [U.s1])).s === "suspended");
});

// ---- C: the preview
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2); await acct(U.s3);
  await mk({ sellerId: U.s1, amount: 500, fee: 90 });                          // 41000
  await mk({ sellerId: U.s2, amount: 500, fee: 90, buyer: U.buyer2 });         // 41000
  await mk({ sellerId: U.s3, amount: 500, fee: 90 });                          // 41000
  await changedAgo(U.s1, "1 hour");
  await changedAgo(U.s2, "73 hours");
  const v = await call("admin_settlement_pending", null, 100);
  check("C01 a seller whose ID changed 1h ago is blocked as upi_in_cooldown, with the time it matures", reasonOf(v, U.s1) === "upi_in_cooldown" && hrs(v.blocked.find((b) => b.seller_id === U.s1).upi_unlocks_at, new Date()) > 70.9 && hrs(v.blocked.find((b) => b.seller_id === U.s1).upi_unlocks_at, new Date()) < 71.1, v.blocked);
  check("C02 changed 73h ago (matured) and never changed are both payable", v.payable.map((p) => p.seller_id).sort().join() === [U.s2, U.s3].sort().join(), v.payable);
  check("C03 totals: the cooldown seller counts as held back, not payable", v.totals.payable_sellers === 2 && v.totals.payable_paise === 82000 && v.totals.blocked_sellers === 1 && v.totals.blocked_paise === 41000, v.totals);
  check("C04 the preview reports the configured cooldown", v.upi_cooldown_hours === 72);
  check("C05 a blocked row for another reason carries no unlock time", v.blocked.every((b) => b.reason === "upi_in_cooldown" ? b.upi_unlocks_at : b.upi_unlocks_at === null));
  await changedAgo(U.s1, "72 hours");
  check("C06 boundary: exactly 72h after the change it is payable", reasonOf(await call("admin_settlement_pending", null, 100), U.s1) === undefined);
  await changedAgo(U.s1, "71 hours 59 minutes");
  check("C07 boundary: one minute short of 72h it is still blocked", reasonOf(await call("admin_settlement_pending", null, 100), U.s1) === "upi_in_cooldown");
  await setCool(0);
  check("C08 cooldown set to 0 hours: nobody is blocked by it", reasonOf(await call("admin_settlement_pending", null, 100), U.s1) === undefined);
  await setCool(168);
  await changedAgo(U.s2, "100 hours");
  check("C09 a longer setting (168h) takes effect immediately for the same change times", reasonOf(await call("admin_settlement_pending", null, 100), U.s2) === "upi_in_cooldown");
});

// ---- D: precedence among blocked reasons
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2, "suspended"); await acct(U.s3);
  await mk({ sellerId: U.s1, amount: 100, fee: 18 });
  await mk({ sellerId: U.s2, amount: 100, fee: 18 });
  await mk({ sellerId: U.s3, amount: 100, fee: 18, buyer: U.buyer2 });
  await setMin(100000);
  await changedAgo(U.s1, "1 hour"); await changedAgo(U.s2, "1 hour");
  const v = await call("admin_settlement_pending", null, 100);
  check("D01 a suspended account is reported as account_suspended before the cooldown", reasonOf(v, U.s2) === "account_suspended", v.blocked);
  check("D02 in cooldown AND below the minimum is reported as upi_in_cooldown (the cooldown is the actionable one)", reasonOf(v, U.s1) === "upi_in_cooldown");
  check("D03 below the minimum alone is still below_minimum (5.6 unchanged)", reasonOf(v, U.s3) === "below_minimum");
});

// ---- E: the frozen batch
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  const p1 = await mk({ sellerId: U.s1, amount: 500, fee: 90 });
  const p2 = await mk({ sellerId: U.s2, amount: 500, fee: 90, buyer: U.buyer2 });
  await changedAgo(U.s1, "1 hour");
  const r = await call("admin_create_settlement_batch", "E1", now());
  check("E01 the freeze leaves the cooldown seller out and agrees with the preview", r.seller_count === 1 && r.total_paise === 41000 && r.purchase_count === 1, r);
  const items = (await q(`select seller_id from public.settlement_items`)).rows.map((x) => x.seller_id);
  check("E02 the cooldown seller has no item and no purchase_settlements row (the sale is free for the next batch)", !items.includes(U.s1) && (await sc(`select count(*)::int n from public.purchase_settlements where purchase_id=$1`, [p1])).n === 0 && (await sc(`select count(*)::int n from public.purchase_settlements where purchase_id=$1`, [p2])).n === 1);
  check("E03 and it is still owed in the preview, nothing deducted", reasonOf(await call("admin_settlement_pending", null, 100), U.s1) === "upi_in_cooldown");
  await call("admin_settle_items", r.batch_id, "E-REF-1", null);
  check("E04 batch 1 completes normally", (await sc(`select status s from public.settlement_batches where id=$1`, [r.batch_id])).s === "completed");
  await changedAgo(U.s1, "80 hours");
  const r2 = await call("admin_create_settlement_batch", "E2", now());
  const it2 = await sc(`select i.amount_paise a, i.vpa_address v from public.settlement_items i where i.batch_id=$1 and i.seller_id=$2`, [r2.batch_id, U.s1]);
  check("E05 once the ID matures the next batch includes the rolled-over sale, paying the ID on file", r2.seller_count === 1 && Number(it2?.a) === 41000 && it2.v === VPA.s1, { r2, it2 });
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1, amount: 500, fee: 90 });
  await changedAgo(U.s1, "1 hour");
  const e = await callErr("admin_create_settlement_batch", "E3", now());
  check("E06 when the ONLY seller is in cooldown the freeze answers nothing_to_settle (CM076) and leaves no batch", e?.code === "CM076" && /nothing_to_settle/.test(e.message) && (await sc(`select count(*)::int n from public.settlement_batches`)).n === 0, e?.message);
});

// ---- F: a change AFTER the freeze never redirects the money
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1, amount: 500, fee: 90 });
  const r = await call("admin_create_settlement_batch", "F1", now());
  const ch = await setVpa(U.s1, "attacker.id@okbank");
  const it = await sc(`select vpa_address v from public.settlement_items where batch_id=$1`, [r.batch_id]);
  check("F01 the frozen item keeps the ID snapshotted at the freeze, whatever the seller does afterwards", ch.outcome === "changed" && it.v === VPA.s1, it);
  const b = await call("admin_settlement_batch", r.batch_id);
  check("F02 the desk still flags it (changed since the freeze, changed recently)", b.items[0].upi_changed_since_snapshot === true && b.items[0].upi_changed_recently === true, b.items[0]);
  await call("admin_settle_items", r.batch_id, "F-REF", null);
  check("F03 and recording it paid still works (the cooldown does not touch a frozen batch)", (await sc(`select status s from public.settlement_items where batch_id=$1`, [r.batch_id])).s === "paid");
});

// ---- G: the seller's view
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  const sold = await mk({ sellerId: U.s1, amount: 500, fee: 90 });
  const refunded = await mk({ sellerId: U.s1, amount: 100, fee: 18, pstatus: "refunded", buyer: U.buyer2 });
  await changedAgo(U.s1, "1 hour");
  let v = await seller(U.s1);
  check("G01 while in cooldown the unsettled sale is shown as 'upi_cooldown' and counted as unsettled (it is owed)", sellerItem(v, sold) === "upi_cooldown" && v.summary.unsettled_paise === 41000, v);
  check("G02 the seller gets the unlock time and the cooldown length", hrs(v.upi_unlocks_at, new Date()) > 70.9 && v.upi_cooldown_hours === 72, { u: v.upi_unlocks_at, h: v.upi_cooldown_hours });
  check("G03 a refunded sale stays 'refunded'", sellerItem(v, refunded) === "refunded");
  const rpc = (await as("authenticated", U.s1, null, `select public.seller_upi_cooldown() as v`)).rows[0].v;
  check("G04 seller_upi_cooldown agrees with the status function", rpc.upi_unlocks_at !== null && new Date(rpc.upi_unlocks_at).getTime() === new Date(v.upi_unlocks_at).getTime() && rpc.upi_cooldown_hours === 72, rpc);
  await changedAgo(U.s1, "80 hours");
  v = await seller(U.s1);
  const rpc2 = (await as("authenticated", U.s1, null, `select public.seller_upi_cooldown() as v`)).rows[0].v;
  check("G05 once matured: back to 'unsettled', no unlock time anywhere", sellerItem(v, sold) === "unsettled" && v.upi_unlocks_at === null && rpc2.upi_unlocks_at === null, { v, rpc2 });
  await changedAgo(U.s1, "1 hour");
  const r = await (async () => { await changedAgo(U.s1, "100 hours"); return call("admin_create_settlement_batch", "G1", now()); })();
  await changedAgo(U.s1, "1 hour");
  v = await seller(U.s1);
  check("G06 a sale already in a batch keeps 'in_batch' even if the seller changes the ID during the cooldown", sellerItem(v, sold) === "in_batch" && v.summary.in_batch_paise === 41000, v);
  await call("admin_settle_items", r.batch_id, "G-REF", null);
  v = await seller(U.s1);
  check("G07 and a paid sale stays 'settled'", sellerItem(v, sold) === "settled" && v.summary.settled_paise === 41000);
  const text = JSON.stringify(v);
  check("G08 the seller JSON still has only allow-listed keys: no ids, no negatives", Object.keys(v).sort().join() === "account_status,items,min_payout_paise,next_payout_date,payouts,summary,upi_cooldown_hours,upi_masked,upi_unlocks_at" && !/seller_id|batch_id|item_id|admin|"-\d/.test(text), Object.keys(v));
  check("G09 a seller with NO UPI ID is still 'needs_upi' and has no unlock time (precedence)", (await (async () => { await mkUsers(); const p = await mk({ sellerId: U.s3, amount: 100, fee: 18 }); const sv = await seller(U.s3); return sellerItem(sv, p) === "needs_upi" && sv.upi_unlocks_at === null; })()));
});

// ---- H: nothing else moved
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2);
  await mk({ sellerId: U.s1, amount: 100, fee: 18 }); await mk({ sellerId: U.s2, amount: 500, fee: 90, buyer: U.buyer2 });
  await setMin(10000);
  const v = await call("admin_settlement_pending", null, 100);
  check("H01 the 5.6 minimum payout still works alongside (below_minimum, min_payout_paise reported)", reasonOf(v, U.s1) === "below_minimum" && v.min_payout_paise === 10000 && v.payable.length === 1, v);
  check("H02 no table gained an API grant: authenticated still cannot read or write the settlement tables", (await as("authenticated", U.s1, null, `select 1 from public.settlement_items`)).err?.code === "42501" && (await as("authenticated", U.s1, null, `update public.seller_payout_accounts set vpa_changed_at = null`)).err?.code === "42501");
  check("H03 the retired payout flags are untouched (still off, cut-off still infinity)", (await q(`select name, enabled from private.feature_flags where name in ('phase6_vpa_payouts','phase5_route_transfers') and enabled`)).rows.length === 0 && (await sc(`select cutoff_at = 'infinity' as v from private.vpa_payout_config`)).v === true);
});

console.log(`\nA60-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
