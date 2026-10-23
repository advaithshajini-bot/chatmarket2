// A57-D -- Milestone 5.6 database tests: minimum payout threshold (migration 20261020100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m57-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000ffe${n}`;
const U = { s1: id(11), s2: id(12), s3: id(13), buyer: id(14), buyer2: id(15), admin: id(16), plain: id(17) };
const AAL2 = { aal: "aal2" };
const VPA = { s1: "seller.one@okbank", s2: "seller2@ybl", s3: "seller3@paytm" };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a57-${uid.slice(-2)}@example.invalid`]);
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
const reasonOf = (v, uid) => v.blocked.find((b) => b.seller_id === uid)?.reason;

await inTxn(async () => {
  await mkUsers();
  const col = await sc(`select column_default d, is_nullable n, data_type t from information_schema.columns where table_schema='private' and table_name='settlement_config' and column_name='min_payout_paise'`);
  check("A01 the column exists, integer, NOT NULL, default 0 (applying the migration changes nothing)", col.t === "integer" && col.n === "NO" && col.d === "0", col);
  check("A02 default minimum is 0", (await sc(`select min_payout_paise m from private.settlement_config`)).m === 0);
  for (const bad of [-1, 10000001]) {
    check(`A03 minimum ${bad} is refused by the table`, (await (async () => { try { await q("SAVEPOINT d"); await setMin(bad); await q("RELEASE SAVEPOINT d"); return null; } catch (e) { await q("ROLLBACK TO SAVEPOINT d"); return e.code; } })()) === "23514");
  }
  check("A04 not reachable by API roles", (await as("authenticated", U.s1, null, `select min_payout_paise from private.settlement_config`)).err?.code === "42501");
  const sigs = (await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon_ok, has_function_privilege('authenticated', p.oid, 'execute') auth_ok from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_settlement_pending','admin_create_settlement_batch','seller_settlement_status')`)).rows;
  check("A05 the replaced functions kept their grants: authenticated yes, anon no", sigs.length === 3 && sigs.every((r) => r.auth_ok && !r.anon_ok), sigs);
  check("A06 the replaced functions are still SECURITY DEFINER with an empty search_path", (await q(`select prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('admin_settlement_pending','admin_create_settlement_batch','seller_settlement_status')`)).rows.every((d) => d.prosecdef && d.proconfig?.some((c) => c.replace(/\s|"/g, "") === "search_path=")));
  check("A07 the anon / non-admin / no-aal2 denials still hold", (await as("anon", null, null, `select public.admin_settlement_pending(null,10)`)).err?.code === "42501" && (await as("authenticated", U.plain, AAL2, `select public.admin_create_settlement_batch('x', null)`)).err?.code === "42501" && (await as("authenticated", U.admin, { aal: "aal1" }, `select public.admin_settlement_pending(null,10)`)).err?.code === "42501");
});

// ---- B: no minimum (default) behaves exactly as before
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1, amount: 100, fee: 99 });      // share 100 paise (Re 1)
  const v = await call("admin_settlement_pending", null, 100);
  check("B01 with no minimum even a Re 1 seller is payable", v.payable.length === 1 && v.payable[0].amount_paise === 100 && v.blocked.length === 0 && v.min_payout_paise === 0, v);
  const r = await call("admin_create_settlement_batch", "B", now());
  check("B02 and is put in the batch", r.seller_count === 1 && r.total_paise === 100);
});

// ---- C: with a minimum
await inTxn(async () => {
  await mkUsers(); await acct(U.s1); await acct(U.s2); await acct(U.s3);
  await mk({ sellerId: U.s1, amount: 500, fee: 90 });                                // 41000
  await mk({ sellerId: U.s2, amount: 100, fee: 18, buyer: U.buyer2 });               // 8200  (below 10000)
  await mk({ sellerId: U.s3, amount: 100, fee: 18 }); await mk({ sellerId: U.s3, amount: 120, fee: 22, buyer: U.buyer2 });   // 8200 + 9800 = 18000 across two sales
  await mk({ sellerId: U.plain, amount: 100, fee: 18 });                             // no UPI account AND below the minimum
  await setMin(10000);
  const v = await call("admin_settlement_pending", null, 100);
  check("C01 preview reports the minimum", v.min_payout_paise === 10000);
  check("C02 a seller at or above the minimum is payable (the total across all their sales is what counts)", v.payable.map((p) => p.seller_id).sort().join() === [U.s1, U.s3].sort().join() && v.payable.find((p) => p.seller_id === U.s3).amount_paise === 18000, v.payable);
  check("C03 a seller below the minimum is reported as below_minimum with their amount", reasonOf(v, U.s2) === "below_minimum" && v.blocked.find((b) => b.seller_id === U.s2).amount_paise === 8200, v.blocked);
  check("C04 precedence: no UPI ID is reported before below_minimum", reasonOf(v, U.plain) === "no_upi_id");
  check("C05 totals: payable excludes the held-back sellers, blocked includes them", v.totals.payable_paise === 41000 + 18000 && v.totals.payable_sellers === 2 && v.totals.blocked_sellers === 2 && v.totals.blocked_paise === 8200 + 8200, v.totals);
  const r = await call("admin_create_settlement_batch", "C", now());
  check("C06 the frozen batch contains exactly the payable sellers and agrees with the preview", r.seller_count === 2 && r.total_paise === 59000 && r.purchase_count === 3, r);
  const inItems = (await q(`select seller_id from public.settlement_items`)).rows.map((x) => x.seller_id);
  check("C07 the below-minimum seller has no item and none of their sales are in the batch", !inItems.includes(U.s2) && (await sc(`select count(*)::int n from public.purchase_settlements where seller_id = $1`, [U.s2])).n === 0);
  const after = await call("admin_settlement_pending", null, 100);
  check("C08 their sale is still owed after the freeze (it rolls over, nothing is lost or deducted)", reasonOf(after, U.s2) === "below_minimum" && after.blocked.find((b) => b.seller_id === U.s2).amount_paise === 8200);
  const sv = await seller(U.s2);
  check("C09 the seller still sees it as 'unsettled' and is told the minimum", sv.min_payout_paise === 10000 && sv.items.length === 1 && sv.items[0].status === "unsettled" && sv.summary.unsettled_paise === 8200 && sv.summary.action_needed_paise === 0, sv);
  await call("admin_settle_items", r.batch_id, "C-REF", null);
  // next month: the seller earns more, the rolled-over amount joins it
  await mk({ sellerId: U.s2, amount: 50, fee: 9, buyer: U.buyer });                  // +4100 -> 12300 total
  const r2 = await call("admin_create_settlement_batch", "C-next", now());
  check("C10 next month the rolled-over sales plus new ones cross the minimum and are paid together", r2.seller_count === 1 && r2.total_paise === 12300 && r2.purchase_count === 2, r2);
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1, amount: 100, fee: 18 });         // 8200
  await setMin(8200);
  check("D01 a total exactly equal to the minimum is paid (>=)", (await call("admin_settlement_pending", null, 10)).payable.length === 1);
  await setMin(8201);
  const v = await call("admin_settlement_pending", null, 10);
  check("D02 one paisa below -> held back", v.payable.length === 0 && reasonOf(v, U.s1) === "below_minimum");
  check("D03 a batch with everyone below the minimum -> nothing_to_settle and no batch row", (await callErr("admin_create_settlement_batch", "D", now()))?.message === "nothing_to_settle" && (await sc(`select count(*)::int n from public.settlement_batches`)).n === 0);
  await setMin(0);
  check("D04 lowering the minimum makes it payable again", (await call("admin_create_settlement_batch", "D2", now())).total_paise === 8200);
});
await inTxn(async () => {
  await mkUsers(); await acct(U.s1);
  await mk({ sellerId: U.s1, amount: 100, fee: 18 });
  await setMin(10000);
  const sv = await seller(U.s1);
  const text = JSON.stringify(sv);
  check("E01 seller JSON: only allow-listed keys (5.6 added min_payout_paise, 5.7 the two cooldown keys); no ids; no negatives", Object.keys(sv).sort().join() === "account_status,items,min_payout_paise,next_payout_date,payouts,summary,upi_cooldown_hours,upi_masked,upi_unlocks_at" && !text.includes(U.admin) && Object.values(sv.summary).every((n) => n >= 0));
});

console.log(`\nM57-DB: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
