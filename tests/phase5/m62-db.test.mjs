// A62-D -- generation type columns (migration 20261023100000). Real schema; every test in a rolled-back transaction.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const SELLER = "00000000-0000-0000-0000-0000000fff01", OTHER = "00000000-0000-0000-0000-0000000fff02";
await c.query("BEGIN");
for (const u of [SELLER, OTHER]) await c.query(`insert into auth.users (id,email) values ($1,$2) on conflict do nothing`, [u, `a62-${u.slice(-2)}@example.invalid`]);
await c.query(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name) values ($1,'active','0012345678901','8901','HDFC0001234','Seller') on conflict do nothing`, [SELLER]);
async function ins(gt, other, uid = SELLER, role = "authenticated") {
  await c.query(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: uid, role })]);
  await c.query(`set local role ${role}`); await c.query("SAVEPOINT s");
  try {
    const r = await c.query(`insert into public.listings (title, model, category, price, seller_name, seller_id, generation_type, generation_type_other) values ('t','Claude','Design',10,'s',$1,$2,$3) returning id`, [SELLER, gt, other]);
    await c.query("RELEASE SAVEPOINT s"); return { id: r.rows[0].id, err: null };
  } catch (e) { await c.query("ROLLBACK TO SAVEPOINT s"); return { err: e }; } finally { await c.query("reset role"); }
}
const cols = (await c.query(`select column_name, is_nullable from information_schema.columns where table_schema='public' and table_name='listings' and column_name like 'generation_type%'`)).rows;
check("D01 both columns exist and are nullable (existing rows stay valid)", cols.length === 2 && cols.every((r) => r.is_nullable === "YES"), cols);
check("D02 a listing without a generation type still inserts (older clients / workflow / agent)", !(await ins(null, null)).err);
for (const t of ["images", "text", "videos"]) check(`D03 '${t}' with no other-text is accepted`, !(await ins(t, null)).err);
check("D04 'others' with text is accepted and stored trimmed-length 1..60", !(await ins("others", "Music")).err && !(await ins("others", "x".repeat(60))).err);
check("D05 'others' without text is rejected", !!(await ins("others", null)).err && !!(await ins("others", "   ")).err);
check("D06 'others' with more than 60 characters is rejected", !!(await ins("others", "x".repeat(61))).err);
check("D07 other-text with a non-'others' type is rejected", !!(await ins("images", "Music")).err && !!(await ins(null, "Music")).err);
check("D08 an unknown type is rejected (case-sensitive values)", !!(await ins("audio", null)).err && !!(await ins("Images", null)).err);
const ok = await ins("others", "3D models");
const back = (await c.query(`select generation_type, generation_type_other from public.listings where id = $1`, [ok.id])).rows[0];
check("D09 the stored values read back exactly", back.generation_type === "others" && back.generation_type_other === "3D models", back);
const pol = (await c.query(`select count(*)::int n from pg_policies where schemaname='public' and tablename='listings' and policyname='Authenticated users can create their own listings'`)).rows[0].n;
check("D11 the insert policy is unchanged", pol === 1, pol);
await c.query("ROLLBACK"); await c.end();
console.log(`\nA62-D: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
