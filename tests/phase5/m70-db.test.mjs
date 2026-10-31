// A70-D -- media milestone DB: columns, storefront RPCs, bucket. REAL schema; each test in a rolled-back transaction.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffc${n}`;
const U = { s1: id(11), s2: id(12), b1: id(14), b2: id(15) };
async function as(role, sql, params) {
  await q("SAVEPOINT r"); await q(`set local role ${role}`);
  try { const r = await q(sql, params); await q("reset role"); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("reset role"); await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
}
await q("BEGIN");
try {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a70-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set display_name = 'Asha Rao', bio = 'I build prompts' where id = $1`, [U.s1]);
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc) values ($1,'active','123456789012','9012','HDFC0001234')`, [U.s1]);
  const mk = async (seller, title) => (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ($1,'n','n',100,'s',$2,'live') returning id`, [title, seller])).rows[0].id;
  const l1 = await mk(U.s1, "L1"), l2 = await mk(U.s1, "L2"), l3 = await mk(U.s2, "L3");
  const pay = (buyer, l, n) => q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee) values ($1,$2,100,'paid',$3,18)`, [buyer, l, n]);
  await pay(U.b1, l1, "p70a"); await pay(U.b2, l1, "p70b"); await pay(U.b1, l3, "p70c");
  await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id) values ($1,$2,100,'refunded','p70d')`, [U.b2, l2]);

  const col = (await q(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='listings' and column_name in ('preview_video_url','preview_video_duration')`)).rows;
  check("M01 listings has preview_video_url (text) and preview_video_duration (numeric)", col.length === 2);
  await q("SAVEPOINT c");
  const bad = await q(`update public.listings set preview_video_duration = 4.9 where id = $1`, [l1]).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT c");
  check("M02 the column check refuses a duration outside 5.0-15.0", !!bad && bad.code === "23514", bad?.code);

  const p = await as("anon", `select public.seller_public_profile($1) v`, [U.s1]);
  const v = p.rows[0]?.v;
  check("M03 the profile RPC works for anon and returns name, bio, counts, sales and verified", !p.err && v.found && v.display_name === "Asha Rao" && v.bio === "I build prompts" && Number(v.listing_count) === 2 && Number(v.sales_count) === 2 && v.verified === true, p.err?.message ?? v);
  check("M04 it exposes no bank, email or id-document fields", !/bank|email|ifsc|account/i.test(Object.keys(v ?? {}).join(",")), Object.keys(v ?? {}));
  const s2 = (await as("anon", `select public.seller_public_profile($1) v`, [U.s2])).rows[0].v;
  check("M05 a seller without a bank account is not verified; sales count only paid purchases", s2.verified === false && Number(s2.sales_count) === 1, s2);
  check("M06 an unknown seller returns found = false", (await as("anon", `select public.seller_public_profile($1) v`, [id("99")])).rows[0].v.found === false);

  const pop = await as("anon", `select listing_id from public.most_popular_listings(10)`);
  check("M07 most popular: ordered by paid purchases (L1 first, then L3), live only, refunded ignored", !pop.err && pop.rows[0]?.listing_id === l1 && pop.rows[1]?.listing_id === l3, pop.err?.message ?? pop.rows);
  check("M08 the limit is clamped (0 and 1000 do not error)", !(await as("anon", `select * from public.most_popular_listings(0)`)).err && !(await as("anon", `select * from public.most_popular_listings(1000)`)).err);

  const b = (await q(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='listing-media'`)).rows[0];
  check("M09 the listing-media bucket is public, 25MB, images + mp4/webm only", b?.public === true && Number(b.file_size_limit) === 26214400 && b.allowed_mime_types.includes("video/mp4") && b.allowed_mime_types.includes("image/webp") && !b.allowed_mime_types.includes("image/gif"), b);
  const pol = (await q(`select count(*)::int n from pg_policies where schemaname='storage' and tablename='objects' and policyname ilike '%listing media%'`)).rows[0].n;
  check("M10 the bucket has read / upload / delete policies", pol >= 3, pol);
} finally { await q("ROLLBACK"); }
console.log(`A70-D: ${pass} passed, ${fail} failed`); await client.end(); process.exit(fail ? 1 : 0);
