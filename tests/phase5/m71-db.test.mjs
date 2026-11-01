// A71-D -- profile auto-provisioning + legal-name resolution (migration 20261101100000). REAL schema; rolled back.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffd${n}`;
const mkUser = (uid, email, meta = {}) => q(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3::jsonb)`, [uid, email, JSON.stringify(meta)]);
const prof = async (uid) => (await q(`select display_name, legal_name from public.profiles where id=$1`, [uid])).rows[0];
const rpc = async (uid) => (await q(`select public.seller_public_profile($1) v`, [uid])).rows[0].v;
await q("BEGIN");
try {
  await mkUser(id("01"), "john.doe@example.com");
  check("P01 a new email sign-up gets a profile; display name comes from the email prefix, no '@'", (await prof(id("01"))).display_name === "john doe" && !/@/.test((await prof(id("01"))).display_name), await prof(id("01")));
  check("P02 the email prefix is NOT stored as the legal name", (await prof(id("01"))).legal_name === null);
  await mkUser(id("02"), "x@example.com", { full_name: "Asha Rao" });
  check("P03 OAuth full_name becomes display and legal name", JSON.stringify(await prof(id("02"))) === JSON.stringify({ display_name: "Asha Rao", legal_name: "Asha Rao" }), await prof(id("02")));
  await mkUser(id("03"), "y@example.com", { name: "evil@phish.com" });
  const p3 = await prof(id("03"));
  check("P04 a provider name that is itself an email is masked to its first part", !/@/.test(p3.display_name) && !/@/.test(p3.legal_name ?? ""), p3);
  await mkUser(id("04"), null);
  check("P05 a sign-up with no email and no name still gets a profile ('Member')", (await prof(id("04")))?.display_name === "Member", await prof(id("04")));
  await mkUser(id("05"), "z@example.com", { display_name: "Zed Creator" });
  check("P06 the sign-up display_name wins for display_name", (await prof(id("05"))).display_name === "Zed Creator");
  const fn = (await q(`select (p.proconfig @> array['search_path=""']) ok, p.prosecdef, has_function_privilege('anon', p.oid,'execute') an, has_function_privilege('authenticated', p.oid,'execute') au from pg_proc p where p.proname='handle_new_user_profile'`)).rows[0];
  check("P07 trigger function: SECURITY DEFINER, empty search_path, not callable by API roles", fn.ok && fn.prosecdef && !fn.an && !fn.au, fn);
  const tg = (await q(`select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid='auth.users'::regclass and t.tgname='on_auth_user_created' and not t.tgisinternal`)).rows;
  check("P08 exactly one on_auth_user_created trigger, running handle_new_user_profile; the old function is kept", tg.length === 1 && tg[0].proname === "handle_new_user_profile" && (await q(`select 1 from pg_proc where proname='handle_new_user'`)).rowCount === 1, tg);
  await q(`insert into auth.users (id, email) values ($1,$2)`, [id("06"), "again@example.com"]);
  await q(`insert into public.profiles (id, display_name) values ($1,'Dup') on conflict (id) do nothing`, [id("06")]);
  check("P09 provisioning is idempotent (no duplicate-profile error)", (await prof(id("06"))).display_name === "again");

  // name resolution
  const s = id("10");
  await mkUser(s, "seller.person@example.com");
  let v = await rpc(s);
  check("N01 with only an email-derived display name, the public name has no '@'", v.display_name === "seller person" && !/@/.test(JSON.stringify(v)), v);
  await q(`update public.profiles set display_name='Display Name', legal_name='Legal Name' where id=$1`, [s]);
  check("N02 legal_name beats display_name", (await rpc(s)).display_name === "Legal Name");
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name) values ($1,'active','123456789012','9012','HDFC0001234','Bank Beneficiary')`, [s]);
  check("N03 the bank beneficiary name beats legal_name and display_name", (await rpc(s)).display_name === "Bank Beneficiary");
  await q(`update public.seller_payout_accounts set bank_beneficiary_name='ops@bank.com' where user_id=$1`, [s]);
  check("N04 an email in any name field is never returned", !/@/.test(JSON.stringify(await rpc(s))), await rpc(s));
  await q(`update public.seller_payout_accounts set bank_beneficiary_name=null where user_id=$1`, [s]);
  await q(`update public.profiles set display_name='@', legal_name=null where id=$1`, [s]);
  check("N05 nothing usable -> 'Verified Creator'", (await rpc(s)).display_name === "Verified Creator", await rpc(s));
  const keys = Object.keys(await rpc(s)).sort().join(",");
  check("N06 the RPC still returns the storefront fields and no private ones", keys === "avg_rating,bio,display_name,found,joined_at,listing_count,review_count,sales_count,verified" && !/email|bank|ifsc/i.test(keys), keys);
  check("N07 unknown id -> found=false; anon may call the RPC", (await rpc(id("99"))).found === false && (await q(`select has_function_privilege('anon','public.seller_public_profile(uuid)','execute') a`)).rows[0].a === true);
  check("N08 private.safe_public_name is not callable by API roles", (await q(`select has_function_privilege('anon','private.safe_public_name(text)','execute') a, has_function_privilege('authenticated','private.safe_public_name(text)','execute') b`)).rows[0].a === false);
} finally { await q("ROLLBACK"); }
console.log(`A71-D: ${pass} passed, ${fail} failed`); await client.end(); process.exit(fail ? 1 : 0);
