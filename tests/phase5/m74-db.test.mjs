// A74-D -- individual "Payout Made" + single-seller bank details (migration 20261103100000). REAL schema; every test rolled back.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-00000000fa${n}`;
const U = { s1: id("01"), s2: id("02"), buyer: id("03"), admin: id("04") };
async function as(uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role: uid ? "authenticated" : "anon", ...(claims ?? {}) })]);
  await q("SAVEPOINT r"); await q(`set local role ${uid ? "authenticated" : "anon"}`);
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); await q("reset role"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); await q("reset role"); return { rows: [], err: e }; }
}
const adm = (sql, p) => as(U.admin, { aal: "aal2" }, sql, p);
await q("BEGIN");
try {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a74-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id=$1`, [U.admin]);
  await q(`update public.profiles set display_name='Asha Rao' where id=$1`, [U.s1]);
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name, bank_account_type) values ($1,'active','0012345678901','8901','HDFC0001234','Asha Rao','savings'), ($2,'active','998877665544','5544','ICIC0004321','Ben Two','current')`, [U.s1, U.s2]);
  const mkListing = async (s) => (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('L74','n','n',500,'s',$1,'live') returning id`, [s])).rows[0].id;
  const l1 = await mkListing(U.s1), l2 = await mkListing(U.s2);
  const mkPurchase = async (l, n) => (await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,500,'paid',$3,90, now() - interval '2 days') returning id`, [U.buyer, l, n])).rows[0].id;
  const p1 = await mkPurchase(l1, "pay74a"), p2 = await mkPurchase(l2, "pay74b");
  const { rows: [b] } = await q(`insert into public.settlement_batches (label, period_end) values ('B74', now()) returning id`);
  const mkItem = async (s, bank, ifsc) => (await q(`insert into public.settlement_items (batch_id, seller_id, vpa_address, amount_paise, platform_fee_paise, purchase_count, status, bank_account_number, bank_ifsc, bank_beneficiary_name, bank_account_type) values ($1,$2,'a.b@okhdfc',41000,9000,1,'pending',$3,$4,'Bene Name','savings') returning id`, [b.id, s, bank, ifsc])).rows[0].id;
  const i1 = await mkItem(U.s1, "0012345678901", "HDFC0001234"), i2 = await mkItem(U.s2, "998877665544", "ICIC0004321");
  await q(`insert into public.purchase_settlements (purchase_id, item_id, seller_id, amount_paise, platform_fee_paise) values ($1,$2,$3,41000,9000), ($4,$5,$6,41000,9000)`, [p1, i1, U.s1, p2, i2, U.s2]);
  const settle = (item, ref, date) => adm(`select public.admin_settle_single_item($1,$2,$3::date) v`, [item, ref, date]);

  // guards first (nothing changes)
  check("S01 a non-admin is refused", (await as(U.s1, { aal: "aal2" }, `select public.admin_settle_single_item($1,'UTR1',null)`, [i1])).err?.code === "42501");
  check("S02 an admin without MFA (aal1) is refused", (await as(U.admin, { aal: "aal1" }, `select public.admin_settle_single_item($1,'UTR1',null)`, [i1])).err?.code === "42501");
  check("S03 anon cannot call it", !!(await as(null, null, `select public.admin_settle_single_item($1,'UTR1',null)`, [i1])).err);
  check("S04 the bank reference is required and validated (blank, symbols, 81 chars)", (await settle(i1, "  ", null)).err?.code === "CM076" && (await settle(i1, "bad;ref", null)).err?.code === "CM076" && (await settle(i1, "A".repeat(81), null)).err?.code === "CM076" && (await settle(i1, null, null)).err?.code === "CM076");
  check("S05 the payment date cannot be in the future or more than 90 days back", (await settle(i1, "UTR1", new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10))).err?.code === "CM076" && (await settle(i1, "UTR1", new Date(Date.now() - 95 * 864e5).toISOString().slice(0, 10))).err?.code === "CM076");
  check("S06 an unknown item is refused", (await settle(id("99"), "UTR1", null)).err?.code === "CM076");
  check("S07 (guards changed nothing) both items are still pending", (await q(`select count(*)::int n from public.settlement_items where batch_id=$1 and status='pending'`, [b.id])).rows[0].n === 2);

  // seller sees "Being paid" before
  const sell = (uid) => as(uid, null, `select public.seller_settlement_status(50) v`);
  const before = (await sell(U.s1)).rows[0].v;
  check("S08 before: the seller's sale is 'in_batch' (Being paid) and nothing is paid out", before.items[0].status === "in_batch" && before.summary.in_batch_paise === 41000 && before.summary.settled_paise === 0 && before.payouts.length === 0, before);

  // pay ONE seller, three days ago
  const d3 = new Date(Date.now() - 3 * 864e5); const d3s = new Date(d3.getTime() + 5.5 * 36e5).toISOString().slice(0, 10);
  const r = await settle(i1, "UTR74-A", d3s);
  check("S09 an admin settles one seller: ok, amount returned, batch stays open", !r.err && r.rows[0].v.settled_paise === 41000 && r.rows[0].v.batch_completed === false, r.err?.message ?? r.rows[0]);
  const rows = (await q(`select id, status, utr, paid_at from public.settlement_items where batch_id=$1 order by amount_paise, seller_id`, [b.id])).rows;
  const paid = rows.find((x) => x.id === i1), other = rows.find((x) => x.id === i2);
  check("S10 that line is 'paid' with the reference and the chosen date (noon IST), the other seller's line is untouched", paid.status === "paid" && paid.utr === "UTR74-A" && new Date(paid.paid_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === d3s && other.status === "pending" && other.utr === null, { paid, other });
  const after = (await sell(U.s1)).rows[0].v;
  check("S11 SYNC: the seller's earnings now show the sale as 'settled' (Paid) and a payout row with the reference, date and masked bank account", after.items[0].status === "settled" && after.summary.settled_paise === 41000 && after.summary.in_batch_paise === 0 && after.payouts[0].reference === "UTR74-A" && !!after.payouts[0].paid_at && after.payouts[0].bank_masked === "****8901" && after.payouts[0].amount_paise === 41000, after);
  check("S12 the other seller still sees 'Being paid'", (await sell(U.s2)).rows[0].v.items[0].status === "in_batch");
  check("S13 a paid line is final: paying it again is refused", (await settle(i1, "UTR74-A2", null)).err?.message === "batch_not_open");
  const last = await settle(i2, "UTR74-B", null);
  check("S14 paying the last pending line completes the batch (paid_at = now when no date given)", last.rows[0]?.v?.batch_completed === true && (await q(`select status from public.settlement_batches where id=$1`, [b.id])).rows[0].status === "completed", last.err?.message);
  check("S15 audit log has one row per payment with reference, date and seller", (await q(`select count(*)::int n from public.audit_log where action='settlement_item_paid' and (metadata->>'reference') in ('UTR74-A','UTR74-B')`)).rows[0].n === 2);
  check("S16 the older all-items function still works for other batches (unchanged)", (await q(`select pg_get_function_identity_arguments('public.admin_settle_items(uuid,text,uuid[])'::regprocedure) a`)).rows[0].a.includes("p_item_ids"));

  // bank details for the single-seller file
  const bd = await adm(`select public.admin_seller_bank_details($1) v`, [U.s1]);
  check("B01 admin + MFA gets the full details (leading zeros kept) and the read is audited", bd.rows[0]?.v?.bank_account_number === "0012345678901" && bd.rows[0].v.bank_ifsc === "HDFC0001234" && bd.rows[0].v.bank_beneficiary_name === "Asha Rao" && bd.rows[0].v.bank_account_type === "savings" && (await q(`select count(*)::int n from public.audit_log where action='seller_bank_details_exported' and target_id=$1`, [U.s1])).rows[0].n === 1, bd.err?.message);
  check("B02 a seller, a plain admin session and anon cannot read it", (await as(U.s1, { aal: "aal2" }, `select public.admin_seller_bank_details($1)`, [U.s1])).err?.code === "42501" && (await as(U.admin, { aal: "aal1" }, `select public.admin_seller_bank_details($1)`, [U.s1])).err?.code === "42501" && !!(await as(null, null, `select public.admin_seller_bank_details($1)`, [U.s1])).err);
  check("B03 a seller with no bank account returns found = false", (await adm(`select public.admin_seller_bank_details($1) v`, [U.buyer])).rows[0].v.found === false);
  const g = (await q(`select p.proname, p.prosecdef, (p.proconfig @> array['search_path=""']) sp, has_function_privilege('anon', p.oid, 'execute') a from pg_proc p where p.proname in ('admin_settle_single_item','admin_seller_bank_details')`)).rows;
  check("B04 both functions are SECURITY DEFINER with an empty search_path and not callable by anon", g.length === 2 && g.every((x) => x.prosecdef && x.sp && !x.a), g);
} finally { await q("ROLLBACK"); }
console.log(`A74-D: ${pass} passed, ${fail} failed`); await client.end(); process.exit(fail ? 1 : 0);
