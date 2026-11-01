// A72-D -- delete_my_account (migration 20261101200000): anonymise, keep records, refuse when money/disputes are open. REAL schema; rolled back.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-00000000fe${n}`;
const U = { s: id("01"), b: id("02"), adm: id("03"), o: id("04") };
async function as(uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify(uid ? { sub: uid, role: "authenticated" } : { role: "anon" })]);
  await q("SAVEPOINT r"); await q(`set local role ${uid ? "authenticated" : "anon"}`);
  try { const r = await q(sql, params); await q("reset role"); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); await q("reset role"); return { rows: [], err: e }; }
}
const del = (uid) => as(uid, `select public.delete_my_account() v`);
await q("BEGIN");
try {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a72-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id=$1`, [U.adm]);
  await q(`update public.profiles set display_name='Seller Sam', legal_name='Samuel Legal', bio='hello' where id=$1`, [U.s]);
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name, bank_account_type) values ($1,'active','123456789012','9012','HDFC0001234','Samuel Legal','savings')`, [U.s]);
  await q(`insert into public.seller_identity_details (user_id, legal_first_name, legal_last_name, contact_email, phone_number, street_address, country, pan_number, govt_id_type, govt_id_last4) values ($1,'Sam','Legal','s@x.com','9999999999','Main road 12','India','ABCDE1234F','aadhaar','1234')`, [U.s]);
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('L72','n','n',100,'s',$1,'live') returning id`, [U.s]);
  const { rows: [pu] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee) values ($1,$2,100,'paid','pay72',18) returning id`, [U.b, l.id]);

  check("D01 not signed in -> refused", !!(await as(null, `select public.delete_my_account() v`)).err);
  check("D02 an admin account is refused (admin_account)", (await del(U.adm)).rows[0].v.reason === "admin_account");
  check("D03 a seller with a paid sale that is not settled yet is refused (unsettled_earnings) and nothing changes", (await del(U.s)).rows[0].v.reason === "unsettled_earnings" && (await q(`select display_name from public.profiles where id=$1`, [U.s])).rows[0].display_name === "Seller Sam");
  // settle it
  const { rows: [batch] } = await q(`insert into public.settlement_batches (label, period_end, created_by) values ('B72', now(), null) returning id`);
  let settled = false;
  if (batch) {
    const { rows: [item] } = await q(`insert into public.settlement_items (batch_id, seller_id, vpa_address, amount_paise, platform_fee_paise, purchase_count, status, utr, paid_at) values ($1,$2,'a.b@okhdfc',8200,1800,1,'paid','UTR72', now()) returning id`, [batch.id, U.s]);
    if (item) { await q(`insert into public.purchase_settlements (purchase_id, item_id, seller_id, amount_paise, platform_fee_paise) values ($1,$2,$3,8200,1800)`, [pu.id, item.id, U.s]); settled = true; }
  }
  check("D04 (setup) the sale is settled", settled);
  const dispute = await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'r','open') returning id`, [pu.id, l.id, U.b, U.s]);
  if (!dispute.err) {
    check("D05 an open dispute (as buyer or seller) refuses deletion (open_dispute)", (await del(U.s)).rows[0].v.reason === "open_dispute" && (await del(U.b)).rows[0].v.reason === "open_dispute");
    await q(`update public.disputes set status='resolved_denied' where id=$1`, [dispute.rows[0].id]);
  } else check("D05 (dispute insert shape)", false, dispute.err.message);
  const r = await del(U.s);
  check("D06 a settled seller can delete: ok = true", r.rows[0]?.v?.ok === true, r.err?.message ?? r.rows[0]);
  const p = (await q(`select display_name, legal_name, bio from public.profiles where id=$1`, [U.s])).rows[0];
  check("D07 profile anonymised: 'Deleted user', no legal name, no bio", p.display_name === "Deleted user" && p.legal_name === null && p.bio === null, p);
  check("D08 the payout account (bank details) is removed", (await q(`select 1 from public.seller_payout_accounts where user_id=$1`, [U.s])).rowCount === 0);
  check("D09 identity details removed", (await q(`select 1 from public.seller_identity_details where user_id=$1`, [U.s])).rowCount === 0);
  check("D10 listings are taken down (removed), not deleted", (await q(`select status from public.listings where id=$1`, [l.id])).rows[0].status === "removed");
  check("D11 purchase and settlement records are KEPT", (await q(`select 1 from public.purchases where id=$1`, [pu.id])).rowCount === 1 && (await q(`select 1 from public.purchase_settlements where purchase_id=$1`, [pu.id])).rowCount === 1);
  check("D12 the public seller RPC shows no private data after deletion", (await q(`select public.seller_public_profile($1) v`, [U.s])).rows[0].v.display_name === "Deleted user");
  check("D13 a buyer with purchases can delete; their purchase rows stay", (await del(U.b)).rows[0].v.ok === true && (await q(`select 1 from public.purchases where user_id=$1`, [U.b])).rowCount === 1);
  check("D14 an audit-log row records it", (await q(`select 1 from public.audit_log where action='account_deleted' and actor_id=$1`, [U.s])).rowCount === 1);
  const g = (await q(`select has_function_privilege('anon','public.delete_my_account()','execute') a, has_function_privilege('authenticated','public.delete_my_account()','execute') b`)).rows[0];
  check("D15 only signed-in users can call it", g.a === false && g.b === true, g);
} finally { await q("ROLLBACK"); }
console.log(`A72-D: ${pass} passed, ${fail} failed`); await client.end(); process.exit(fail ? 1 : 0);
