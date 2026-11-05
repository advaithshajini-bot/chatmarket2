// A76-D -- "Payout Completed" for one seller from the summary row + the database rate limiter (migration 20261105100000). REAL schema; rolled back.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-00000000fb${n}`;
const U = { s1: id("01"), s2: id("02"), s3: id("05"), buyer: id("03"), buyer2: id("06"), admin: id("04") };
const claims = (uid, extra) => q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role: uid ? "authenticated" : "anon", ...(extra ?? {}) })]);
async function as(uid, extra, sql, params) {
  await claims(uid, extra);
  await q("SAVEPOINT r"); await q(`set local role ${uid ? "authenticated" : "anon"}`);
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); await q("reset role"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); await q("reset role"); return { rows: [], err: e }; }
}
const adm = (sql, p) => as(U.admin, { aal: "aal2" }, sql, p);
const hit = async (b, k, l, w) => (await q(`select public.rate_limit_hit($1,$2,$3,$4) v`, [b, k, l, w])).rows[0].v;
async function sp(sql, params) { await q("SAVEPOINT x"); try { const r = await q(sql, params); await q("RELEASE SAVEPOINT x"); return { rows: r.rows, err: null }; } catch (e) { await q("ROLLBACK TO SAVEPOINT x"); return { rows: [], err: e }; } }
await q("BEGIN");
try {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a76-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id=$1`, [U.admin]);
  await q(`update public.profiles set display_name='Asha Rao' where id=$1`, [U.s1]);
  const acct = (uid, num, ifsc) => q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name, bank_account_type) values ($1,'active',$2,$3,$4,'Bene Name','savings')`, [uid, num, num.slice(-4), ifsc]);
  await acct(U.s1, "0012345678901", "HDFC0001234"); await acct(U.s2, "998877665544", "ICIC0004321");   // s3 has no bank account
  await q(`update public.seller_payout_accounts set bank_changed_at = null where user_id in ($1,$2)`, [U.s1, U.s2]);
  const mkListing = async (s) => (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('L76','n','n',500,'s',$1,'live') returning id`, [s])).rows[0].id;
  const l1 = await mkListing(U.s1), l2 = await mkListing(U.s2), l3 = await mkListing(U.s3);
  const mkPurchase = async (l, n, buyer = U.buyer) => (await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,500,'paid',$3,90, now() - interval '2 days') returning id`, [buyer, l, n])).rows[0].id;
  const p1 = await mkPurchase(l1, "pay76a"), p2 = await mkPurchase(l2, "pay76b"); await mkPurchase(l3, "pay76c");
  const complete = (s, ref, date, end) => adm(`select public.admin_complete_seller_payout($1, coalesce($4::timestamptz, now()), $2, $3::date) v`, [s, ref, date, end ?? null]);
  const sell = (uid) => as(uid, null, `select public.seller_settlement_status(50) v`);

  // ---- Payout Completed
  check("C01 a non-admin and an admin without MFA are refused", (await as(U.s1, { aal: "aal2" }, `select public.admin_complete_seller_payout($1, now(), 'UTR1', null)`, [U.s1])).err?.code === "42501" && (await as(U.admin, { aal: "aal1" }, `select public.admin_complete_seller_payout($1, now(), 'UTR1', null)`, [U.s1])).err?.code === "42501");
  check("C02 anon cannot call it", !!(await as(null, null, `select public.admin_complete_seller_payout($1, now(), 'UTR1', null)`, [U.s1])).err);
  check("C03 reference required and validated; date not in the future / not older than 90 days", (await complete(U.s1, " ", null)).err?.code === "CM076" && (await complete(U.s1, "bad;ref", null)).err?.code === "CM076" && (await complete(U.s1, "UTR1", new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10))).err?.code === "CM076" && (await complete(U.s1, "UTR1", new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10))).err?.code === "CM076");
  check("C04 a seller with no bank account (or nothing owed) is refused with nothing_to_settle", (await complete(U.s3, "UTR3", null)).err?.message === "nothing_to_settle" && (await complete(U.buyer, "UTR3", null)).err?.message === "nothing_to_settle");
  check("C05 (guards changed nothing) no batch, item or purchase_settlement exists yet", (await q(`select (select count(*) from public.settlement_batches where label like 'seller-%')::int a, (select count(*) from public.purchase_settlements where purchase_id in ($1,$2))::int b`, [p1, p2])).rows.every((r) => r.a === 0 && r.b === 0));

  // an unrelated monthly batch is open: Payout Completed must still work
  const { rows: [open] } = await q(`insert into public.settlement_batches (label, period_end) values ('OPEN76', now()) returning id`);
  const d3s = new Date(Date.now() - 3 * 864e5 + 5.5 * 36e5).toISOString().slice(0, 10);
  const r = await complete(U.s1, "UTR76-A", d3s);
  check("C06 one seller is completed (net 410.00 = 500 - 90 fee) even while another batch is open", !r.err && r.rows[0].v.settled_paise === 41000 && r.rows[0].v.purchase_count === 1, r.err?.message ?? r.rows[0]);
  const item = (await q(`select i.*, b.status bstatus, b.completed_at, b.total_paise from public.settlement_items i join public.settlement_batches b on b.id=i.batch_id where i.seller_id=$1 and b.label like 'seller-%'`, [U.s1])).rows;
  check("C07 a completed one-seller batch with a PAID line: reference, date (noon IST), bank snapshot, totals", item.length === 1 && item[0].status === "paid" && item[0].utr === "UTR76-A" && item[0].bstatus === "completed" && item[0].completed_at && Number(item[0].total_paise) === 41000 && item[0].bank_account_number === "0012345678901" && new Date(item[0].paid_at).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }) === d3s, item[0]);
  check("C08 the sale is now locked to that line (cannot be paid twice) and the open batch is untouched", (await q(`select item_id from public.purchase_settlements where purchase_id=$1`, [p1])).rows[0].item_id === item[0].id && (await q(`select status from public.settlement_batches where id=$1`, [open.id])).rows[0].status === "open");
  const after = (await sell(U.s1)).rows[0].v;
  check("C09 SYNC: /sell/earnings data shows the sale as settled (Paid) with the reference, date and masked bank account", after.items[0].status === "settled" && after.summary.settled_paise === 41000 && after.payouts.length === 1 && after.payouts[0].reference === "UTR76-A" && !!after.payouts[0].paid_at && /8901/.test(String(after.payouts[0].bank_masked)), after.payouts);
  check("C10 paying the same seller again finds nothing owed", (await complete(U.s1, "UTR76-A2", null)).err?.message === "nothing_to_settle");
  check("C11 the other seller is untouched and still shows nothing paid", (await sell(U.s2)).rows[0].v.summary.settled_paise === 0 && (await q(`select count(*)::int n from public.purchase_settlements where purchase_id=$1`, [p2])).rows[0].n === 0);
  const r2 = await complete(U.s2, "UTR76-B", null);
  check("C12 a second seller, no date given: paid now; each gets its own batch", !r2.err && (await q(`select count(*)::int n from public.settlement_batches where label like 'seller-%'`)).rows[0].n === 2);
  check("C13 the minimum payout still applies (nothing_to_settle below it)", await (async () => {
    await q(`update private.settlement_config set min_payout_paise = 100000 where id`);
    const p4 = await mkPurchase(l1, "pay76d", U.buyer2); const x = await complete(U.s1, "UTR76-M", null); await q(`update private.settlement_config set min_payout_paise = 0 where id`); return x.err?.message === "nothing_to_settle" && !!p4; })());
  check("C14 audit row per completion with reference, amount and seller", (await q(`select count(*)::int n from public.audit_log where action='seller_payout_completed' and metadata->>'reference' in ('UTR76-A','UTR76-B')`)).rows[0].n === 2);
  const f = (await q(`select p.prosecdef, (p.proconfig @> array['search_path=""']) sp, has_function_privilege('anon', p.oid, 'execute') a from pg_proc p where p.proname='admin_complete_seller_payout'`)).rows[0];
  check("C15 SECURITY DEFINER, empty search_path, not callable by anon", f.prosecdef && f.sp && !f.a, f);

  // ---- rate limiter
  const fp = (await q(`select p.proname, has_function_privilege('service_role', p.oid,'execute') sr, has_function_privilege('authenticated', p.oid,'execute') au, has_function_privilege('anon', p.oid,'execute') an from pg_proc p where p.proname in ('rate_limit_hit','rate_limit_reset')`)).rows;
  check("R01 rate_limit_hit / rate_limit_reset: service_role only (not authenticated, not anon)", fp.length === 2 && fp.every((x) => x.sr && !x.au && !x.an), fp);
  check("R02 a seller session cannot call the limiter or read its table", (await as(U.s1, null, `select public.rate_limit_hit('x','y',1,60)`)).err?.code === "42501" && !!(await as(U.s1, null, `select * from private.rate_limit_events`)).err);
  const a = [await hit("t76", "k1", 3, 60), await hit("t76", "k1", 3, 60), await hit("t76", "k1", 3, 60), await hit("t76", "k1", 3, 60)];
  check("R03 sliding window: 3 allowed (remaining 2,1,0), the 4th is refused with a retry time", a.slice(0, 3).every((x) => x.allowed) && a[2].remaining === 0 && a[3].allowed === false && a[3].retry_after_seconds >= 1 && a[3].retry_after_seconds <= 60, a);
  check("R04 refused attempts are not counted (still exactly 3 events)", (await q(`select count(*)::int n from private.rate_limit_events where bucket='t76' and key='k1'`)).rows[0].n === 3);
  check("R05 other keys and other buckets are independent", (await hit("t76", "k2", 3, 60)).allowed && (await hit("t76b", "k1", 3, 60)).allowed);
  await q(`insert into private.rate_limit_events (bucket, key, at) select 't76w','k', now() - interval '2 hours' from generate_series(1,5)`);
  check("R06 events outside the window do not count (and are cleaned up)", (await hit("t76w", "k", 2, 3600)).allowed && (await q(`select count(*)::int n from private.rate_limit_events where bucket='t76w'`)).rows[0].n === 1);
  await q(`select public.rate_limit_reset('t76','k1')`);
  check("R07 reset clears the counter (a successful login does this for the account)", (await hit("t76", "k1", 3, 60)).allowed && (await q(`select count(*)::int n from private.rate_limit_events where bucket='t76' and key='k1'`)).rows[0].n === 1);
  check("R08 invalid input is rejected (limit 0, window 0, empty bucket, over-long key)", (await sp(`select public.rate_limit_hit('b','k',0,60)`)).err?.code === "22023" && (await sp(`select public.rate_limit_hit('b','k',5,0)`)).err?.code === "22023" && (await sp(`select public.rate_limit_hit('','k',5,60)`)).err?.code === "22023" && (await sp(`select public.rate_limit_hit('b',$1,5,60)`, ["k".repeat(129)])).err?.code === "22023");

  // ---- the seller-write triggers (the database cap that holds even for a request that skips the API)
  await claims(null, null);   // setup runs as the system (no session), so it is not counted against the seller
  await q(`insert into public.seller_identity_details (user_id, legal_first_name, legal_last_name, contact_email, phone_number, street_address, country, pan_number, govt_id_type, govt_id_last4) values ($1,'Asha','Rao','a@example.com','9876543210','12 Street, Chennai','India','ABCDE','aadhaar','1234')`.replace("'ABCDE'", "'ABCDE1234F'"), [U.s1]);
  const idCols = [];
  const hasIdentity = (await q(`select count(*)::int n from public.seller_identity_details where user_id=$1`, [U.s1])).rows[0].n === 1;
  check("T00 (setup) an identity row exists for the trigger test", hasIdentity, idCols);
  const upd = async (uid, table, target = U.s1) => { await claims(uid, null); return sp(`update public.${table} set updated_at = now() where user_id = $1`, [target]); };
  let okN = 0, firstErr = null;
  for (let i = 0; i < 12; i++) { const x = await upd(U.s1, "seller_identity_details"); if (x.err) { firstErr = firstErr ?? x.err; } else okN++; }
  check("T01 a seller's own identity writes: 10 per hour, then CM082 rate_limited with a retry hint", okN === 10 && firstErr?.code === "CM082" && Number(firstErr.hint) >= 1, { okN, code: firstErr?.code, hint: firstErr?.hint });
  let okB = 0, errB = null;
  for (let i = 0; i < 12; i++) { const x = await upd(U.s1, "seller_payout_accounts"); if (x.err) errB = errB ?? x.err; else okB++; }
  check("T02 the same cap on the seller's own bank-account writes", okB === 10 && errB?.code === "CM082", { okB, code: errB?.code });
  const adminOk = (await upd(U.admin, "seller_payout_accounts")).err === null && (await upd(U.admin, "seller_payout_accounts")).err === null;
  check("T03 an admin / system write to a seller's row is never counted or blocked", adminOk);
  await claims(null, null);
  check("T04 service / no-session writes (auth.uid() null) are not counted", (await sp(`update public.seller_payout_accounts set updated_at = now() where user_id = $1`, [U.s1])).err === null);
  check("T05 another seller's own counter is separate (their first write is fine)", (await upd(U.s2, "seller_payout_accounts", U.s2)).err === null);
  const tg = (await q(`select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname in ('rate_limit_identity_writes','rate_limit_bank_writes') and not t.tgisinternal`)).rows[0].n;
  check("T06 both triggers exist", tg === 2);
} finally { await q("ROLLBACK"); }
console.log(`A76-D: ${pass} passed, ${fail} failed`); await client.end(); process.exit(fail ? 1 : 0);
