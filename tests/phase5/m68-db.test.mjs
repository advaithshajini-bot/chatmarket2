// A68-D -- manual bank payouts (migration 20261029100000). REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffc${n}`;
const U = { s1: id(11), s2: id(12), admin: id(16), buyer: id(14) };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a68-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const save = (uid, num = "0012345678901", ifsc = "hdfc0001234", name = "  Asha   Rao ", type = "savings") =>
  as("authenticated", uid, null, `select public.set_my_bank_payout($1,$2,$3,$4) as v`, [num, ifsc, name, type]);
const row = async (uid) => (await q(`select * from public.seller_payout_accounts where user_id=$1`, [uid])).rows[0];
const listing = (uid) => as("authenticated", uid, null, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','Claude','Design',10,'s',$1) returning id`, [uid]);

await inTxn(async () => {
  await mkUsers();
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='seller_payout_accounts'`)).rows.map((r) => r.column_name);
  check("A01 bank_account_number and bank_changed_at exist", cols.includes("bank_account_number") && cols.includes("bank_changed_at"));
  check("A02 authenticated cannot select the full number or the change time", (await as("authenticated", U.s1, null, `select bank_account_number from public.seller_payout_accounts`)).err?.code === "42501"
    && (await as("authenticated", U.s1, null, `select bank_changed_at from public.seller_payout_accounts`)).err?.code === "42501");
  check("A03 anon cannot select it either", (await as("anon", null, null, `select bank_account_number from public.seller_payout_accounts`)).err?.code === "42501");
  check("A04 service_role can read it (payout server)", !(await as("service_role", null, null, `select bank_account_number from public.seller_payout_accounts`)).err);
  check("A05 the database refuses an account number that is not 9-18 digits", await (async () => { try { await q("SAVEPOINT c"); await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number) values ($1,'active','12345678')`, [U.s1]); return false; } catch { await q("ROLLBACK TO SAVEPOINT c"); return true; } })());
  const fn = (await q(`select p.prosecdef, (p.proconfig @> array['search_path=""']) ok, has_function_privilege('anon', p.oid,'execute') an, has_function_privilege('authenticated', p.oid,'execute') au from pg_proc p where p.proname='set_my_bank_payout'`)).rows[0];
  check("A06 set_my_bank_payout: SECURITY DEFINER, empty search_path, authenticated only", fn.prosecdef && fn.ok && !fn.an && fn.au, fn);
});

await inTxn(async () => {
  await mkUsers();
  const r = await save(U.s1);
  check("B01 saving returns outcome 'saved'", !r.err && r.rows[0].v.outcome === "saved", r);
  const a = await row(U.s1);
  check("B02 stored: full number, last4, upper-cased IFSC, trimmed name, type, active", a.bank_account_number === "0012345678901" && a.bank_account_last4 === "8901" && a.bank_ifsc === "HDFC0001234" && a.bank_beneficiary_name === "Asha Rao" && a.bank_account_type === "savings" && a.status === "active", a);
  check("B03 a bank-only row (no razorpay account, no UPI) satisfies the destination constraint", a.razorpay_account_id === null && a.vpa_address === null);
  check("B04 the first save starts no cooldown", a.bank_changed_at === null && r.rows[0].v.bank_unlocks_at === null);
  const same = await save(U.s1);
  check("B05 re-saving the same account starts no cooldown", (await row(U.s1)).bank_changed_at === null && !same.err);
  const ch = await save(U.s1, "999988887777", "ICIC0004321", "Asha Rao", "current");
  const a2 = await row(U.s1);
  check("B06 CHANGING the account starts the cooldown and reports the unlock time", a2.bank_changed_at !== null && ch.rows[0].v.bank_unlocks_at !== null && a2.bank_account_type === "current" && a2.bank_account_last4 === "7777", ch.rows[0]?.v);
  check("B07 an audit row is written with last4 + IFSC only (never the full number)", (await q(`select metadata from public.audit_log where action='payout_bank_set' and actor_id=$1`, [U.s1])).rows.every((m) => !JSON.stringify(m.metadata).includes("99998888")));
  await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.s1]);
  await save(U.s1, "111122223333");
  check("B08 a suspension survives a new save", (await row(U.s1)).status === "suspended");
});

await inTxn(async () => {
  await mkUsers();
  const bad = [["12345678", "HDFC0001234", "Asha"], ["1234567890123456789", "HDFC0001234", "Asha"], ["12345678901a", "HDFC0001234", "Asha"], ["123456789012", "HDFC1001234", "Asha"], ["123456789012", "HDFC000123", "Asha"], ["123456789012", "HDFC0001234", "A"], ["123456789012", "HDFC0001234", "x".repeat(121)]];
  let ok = true;
  for (const [n, i, nm] of bad) { const r = await save(U.s1, n, i, nm); if (r.err?.code !== "CM080") ok = false; }
  check("C01 invalid account number / IFSC / beneficiary are all refused with CM080", ok);
  check("C02 an invalid account type is refused", (await save(U.s1, "123456789012", "HDFC0001234", "Asha", "wallet")).err?.code === "CM080");
  check("C03 nothing was stored by the refused calls", (await row(U.s1)) === undefined);
  check("C04 anonymous callers are refused", (await as("anon", null, null, `select public.set_my_bank_payout('123456789012','HDFC0001234','Asha','savings')`)).err?.code === "42501");
  for (let i = 0; i < 5; i++) await save(U.s1, `12345678901${i}`);
  check("C05 more than 5 saves in 24 hours is refused", (await save(U.s1, "123456789019")).err?.message === "too_many_changes");
});

await inTxn(async () => {
  await mkUsers();
  check("D01 flags OFF, no bank account: listing is refused (CM079 bank_account_required)", (await listing(U.s1)).err?.message === "bank_account_required");
  await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status) values ($1,'seller@okbank','active')`, [U.s2]);
  check("D02 a legacy UPI-only seller is also refused until a bank account is saved", (await listing(U.s2)).err?.message === "bank_account_required");
  await save(U.s1);
  check("D03 with a saved bank account (number + IFSC) the seller can list", !(await listing(U.s1)).err);
  await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.s1]);
  check("D04 a suspended account cannot list", (await listing(U.s1)).err?.message === "bank_account_required");
  check("D05 my_bank_payout never returns the full number", await (async () => { await q(`update public.seller_payout_accounts set status='active' where user_id=$1`, [U.s1]); const r = await as("authenticated", U.s1, null, `select public.my_bank_payout() v`); const v = r.rows[0].v; return v.configured === true && v.last4 === "8901" && v.ifsc === "HDFC0001234" && !JSON.stringify(v).includes("0012345678901"); })());
  check("D06 my_bank_payout for a seller with nothing saved: configured=false", (await as("authenticated", U.s2, null, `select public.my_bank_payout() v`)).rows[0].v.configured === false);
});

await inTxn(async () => {
  await mkUsers();
  await save(U.s1);
  const pend = await as("authenticated", U.admin, { aal: "aal2" }, `select public.admin_settlement_pending() v`);
  check("E01 admin preview works for admin+MFA and exposes the cooldown under bank_ keys", !pend.err && "bank_cooldown_hours" in pend.rows[0].v && !("upi_cooldown_hours" in pend.rows[0].v));
  check("E02 a plain seller cannot call the admin batch detail", (await as("authenticated", U.s1, null, `select public.admin_settlement_batch($1) v`, [id(99)])).err?.code === "42501");
  check("E03 an admin WITHOUT MFA cannot either", (await as("authenticated", U.admin, null, `select public.admin_settlement_batch($1) v`, [id(99)])).err?.code === "42501");
  check("E04 a preview never contains a full account number", !JSON.stringify(pend.rows[0].v).includes("0012345678901"));
});

console.log(`\nA68-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
