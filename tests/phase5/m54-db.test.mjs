// A54-D -- Phase 6 hardening: the self-service payout-account function is no longer callable (migration 20261017100000).
// REAL schema. Rolled-back transactions.   Run:  DATABASE_URL=... node tests/phase5/m54-db.test.mjs
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
const U = "00000000-0000-0000-0000-0000000fff01";
async function as(role, uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const SIG = "public.set_seller_payout_account(text,text)";
await q("BEGIN");
try {
  await q(`insert into auth.users (id, email) values ($1,'a54@example.invalid') on conflict (id) do nothing`, [U]);
  for (const role of ["authenticated", "anon"]) {
    const r = await as(role, role === "anon" ? null : U, `select public.set_seller_payout_account('acc_SelfSet0001','active')`);
    check(`A01 ${role} can no longer call it (42501)`, r.err?.code === "42501", r.err?.code);
    check(`A02 ${role} has no EXECUTE privilege`, (await q(`select has_function_privilege('${role}','${SIG}','execute') as v`)).rows[0].v === false);
  }
  check("A03 PUBLIC has no EXECUTE either", (await q(`select not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = '${SIG}'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as v`)).rows[0].v === true);
  check("A04 the profile row was not touched by the refused call", (await q(`select razorpay_linked_account_id as v from public.profiles where id = $1`, [U])).rows[0]?.v == null);
  check("A05 the function still exists (not dropped)", (await q(`select count(*)::int as v from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0].v === 1);
  check("A06 the admin path is unaffected: admin_set_seller_payout_account is still granted to authenticated", (await q(`select has_function_privilege('authenticated','public.admin_set_seller_payout_account(uuid,text,text)','execute') as v`)).rows[0].v === true);
  // idempotent: running the migration text again changes nothing and does not error
  const fs = await import("node:fs");
  const sql = fs.readFileSync(new URL("../../supabase/migrations/20261017100000_revoke_self_set_payout_account.sql", import.meta.url), "utf8");
  let again = null; try { await q(sql); } catch (e) { again = e; }
  check("A07 the migration is idempotent (re-running it is a no-op)", again === null, again?.message);
} finally { await q("ROLLBACK"); }
console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
