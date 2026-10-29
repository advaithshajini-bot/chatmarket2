// A67-D -- seller bank settlement display details (migration 20261028100000). REAL schema; rolled-back transactions.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffe${n}`;
const U = { s1: id(11), s2: id(12) };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function as(role, uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role })]);
  await q(`set local role ${role}`); await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const svc = (fn, ...a) => as("service_role", null, `select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(",")}) as v`, a);
const ACC = "acc_BankTest00001";

await inTxn(async () => {
  for (const u of Object.values(U)) await q(`insert into auth.users (id,email) values ($1,$2) on conflict do nothing`, [u, `a67-${u.slice(-2)}@example.invalid`]);
  const cols = (await q(`select column_name, is_generated from information_schema.columns where table_schema='public' and table_name='seller_payout_accounts'`)).rows;
  const names = cols.map((c) => c.column_name);
  check("B01 the new columns exist, and onboarding_status is a GENERATED column", ["bank_account_last4", "bank_ifsc", "bank_name", "bank_beneficiary_name", "bank_account_type", "onboarding_status"].every((c) => names.includes(c)) && cols.find((c) => c.column_name === "onboarding_status").is_generated === "ALWAYS");
  check("B02 there is NO column that could hold a full account number or a PAN", !names.some((n) => /account_number|pan\b|pan_/.test(n)) && !names.includes("bank_account_number"));
  await svc("route_save_linked_account", U.s1, ACC, "created");
  const st = async () => (await q(`select onboarding_status s from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows[0].s;
  const map = {};
  for (const s of ["created", "under_review", "needs_clarification", "rejected", "suspended", "activated"]) { await svc("route_update_account_status", ACC, s); map[s] = await st(); }
  check("B03 onboarding_status follows route_status: draft / submitted / action_required / activated", map.created === "draft" && map.under_review === "submitted" && map.needs_clarification === "action_required" && map.rejected === "action_required" && map.suspended === "action_required" && map.activated === "activated", map);
  const r = await svc("route_save_bank_display", U.s1, "9012", "HDFC0001234", "Asha Rao", "current", "HDFC Bank");
  const row = (await q(`select bank_account_last4 l, bank_ifsc i, bank_beneficiary_name b, bank_account_type t, bank_name n from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows[0];
  check("B04 the display facts are saved (last 4, IFSC, beneficiary, type, bank name)", r.rows[0]?.v.outcome === "saved" && row.l === "9012" && row.i === "HDFC0001234" && row.b === "Asha Rao" && row.t === "current" && row.n === "HDFC Bank", [r.err?.message, row]);
  check("B05 invalid values are refused: last4 not 4 digits, bad IFSC, bad type, short name", (await svc("route_save_bank_display", U.s1, "123", "HDFC0001234", "Asha Rao", "savings")).err?.code === "CM080" && (await svc("route_save_bank_display", U.s1, "1234", "hdfc0001234", "Asha Rao", "savings")).err?.code === "CM080" && (await svc("route_save_bank_display", U.s1, "1234", "HDFC0001234", "Asha Rao", "joint")).err?.code === "CM080" && (await svc("route_save_bank_display", U.s1, "1234", "HDFC0001234", "A", "savings")).err?.code === "CM080");
  check("B06 a user with no linked account gets 'no_account' and nothing is created", (await svc("route_save_bank_display", U.s2, "1234", "HDFC0001234", "Asha Rao", "savings")).rows[0].v.outcome === "no_account" && (await q(`select count(*)::int n from public.seller_payout_accounts where user_id=$1`, [U.s2])).rows[0].n === 0);
  check("B07 only service_role can write bank display facts (authenticated and anon are refused)", (await as("authenticated", U.s1, `select public.route_save_bank_display($1,'1234','HDFC0001234','Asha Rao','savings')`, [U.s1])).err?.code === "42501" && (await as("anon", null, `select public.route_save_bank_display($1,'1234','HDFC0001234','Asha Rao','savings')`, [U.s1])).err?.code === "42501");
  const mine = await as("authenticated", U.s1, `select public.my_route_status() as v`);
  check("B08 my_route_status returns the masked-able display facts and onboarding_status, never the account id", mine.rows[0].v.bank_account_last4 === "9012" && mine.rows[0].v.bank_ifsc === "HDFC0001234" && mine.rows[0].v.onboarding_status === "activated" && mine.rows[0].v.ready === true && !JSON.stringify(mine.rows[0].v).includes("acc_"));
  check("B09 a seller can read their own display columns but not the account id column", !(await as("authenticated", U.s1, `select bank_account_last4, bank_ifsc, onboarding_status from public.seller_payout_accounts`)).err && (await as("authenticated", U.s1, `select razorpay_account_id from public.seller_payout_accounts`)).err?.code === "42501");
  check("B10 another seller cannot see this seller's bank facts (row-level security)", (await as("authenticated", U.s2, `select bank_account_last4 from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows.length === 0);
});

// idempotent: running the migration file a second time changes nothing and does not fail
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261028100000_seller_bank_details.sql"), "utf8");
await q("BEGIN");
let again = null; try { await q(sql); } catch (e) { again = e; }
await q("ROLLBACK");
check("B11 the migration can be run a second time without error (idempotent)", again === null, again?.message);
check("B12 the legacy UPI column and function are untouched", (await q(`select count(*)::int n from information_schema.columns where table_schema='public' and table_name='seller_payout_accounts' and column_name in ('vpa_address','vpa_changed_at')`)).rows[0].n === 2 && (await q(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='set_my_payout_vpa'`)).rows[0].n === 1);

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
