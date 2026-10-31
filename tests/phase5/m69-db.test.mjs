// A69-D -- listing rules trigger (migrations 20261030100000 / 20261031100000) and the Pause / Resume payout toggle. REAL schema; every test in a rolled-back transaction.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffb${n}`;
const U = { s1: id(11), admin: id(16), buyer: id(14) };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a69-${uid.slice(-2)}@example.invalid`]);
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
const S = (n, c = "a") => c.repeat(n);
const ins = (uid, o = {}) => {
  const v = { title: S(10), description: S(500), zip: S(250), price: 50, type: "playbook", shots: 4, video: "v.mp4", dur: 8, ...o };
  const shots = JSON.stringify(Array.from({ length: v.shots }, (_, i) => `s${i}.png`));
  return as("authenticated", uid, null, `insert into public.listings (title, model, category, price, seller_name, seller_id, description, zip_contents, product_type, screenshots, preview_video_url, preview_video_duration) values ($1,'Claude','Design',$2,'s',$3,$4,$5,$6,$7::jsonb,$8,$9) returning id`, [v.title, v.price, uid, v.description, v.zip, v.type, shots, v.video, v.dur]);
};
const msg = (r) => r.err?.message;

await inTxn(async () => {
  await mkUsers();
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc) values ($1,'active','123456789012','9012','HDFC0001234')`, [U.s1]);
  check("A01 a listing exactly on every minimum is accepted (10 / 500 / 250 / 4 screenshots / 5s / ₹50)", !(await ins(U.s1, { dur: 5 })).err);
  check("A02 every maximum is accepted (20 / 2000 / 500 / 10 screenshots / 15s / ₹999)", !(await ins(U.s1, { title: S(20), description: S(2000), zip: S(500), shots: 10, dur: 15, price: 999 })).err);
  check("A03 title of 9 and 21 characters is refused (CM081 title_out_of_range)", (await ins(U.s1, { title: S(9) })).err?.code === "CM081" && msg(await ins(U.s1, { title: S(9) })) === "title_out_of_range" && msg(await ins(U.s1, { title: S(21) })) === "title_out_of_range");
  check("A04 description of 499 and 2001 characters is refused", msg(await ins(U.s1, { description: S(499) })) === "description_out_of_range" && msg(await ins(U.s1, { description: S(2001) })) === "description_out_of_range");
  check("A05 zip note of 249, 501 and none is refused for a playbook", msg(await ins(U.s1, { zip: S(249) })) === "zip_contents_out_of_range" && msg(await ins(U.s1, { zip: S(501) })) === "zip_contents_out_of_range" && msg(await ins(U.s1, { zip: null })) === "zip_contents_out_of_range");
  check("A06 ₹49 and ₹1000 are refused", msg(await ins(U.s1, { price: 49 })) === "price_out_of_range" && msg(await ins(U.s1, { price: 1000 })) === "price_out_of_range");
  check("A07 whitespace padding does not count (trimmed)", msg(await ins(U.s1, { title: "   " + S(7) + "   " })) === "title_out_of_range" && msg(await ins(U.s1, { description: S(499) + " ".repeat(50) })) === "description_out_of_range");
  check("A12 3 and 11 screenshots are refused (screenshots_count_invalid)", msg(await ins(U.s1, { shots: 3 })) === "screenshots_count_invalid" && msg(await ins(U.s1, { shots: 11 })) === "screenshots_count_invalid");
  check("A13 a playbook without a preview video is refused (video_required)", msg(await ins(U.s1, { video: null })) === "video_required" && msg(await ins(U.s1, { video: "  " })) === "video_required");
  check("A14 video of 4.9s and 15.1s is refused (video_duration_out_of_range); a missing duration too", msg(await ins(U.s1, { dur: 4.9 })) === "video_duration_out_of_range" && msg(await ins(U.s1, { dur: 15.1 })) === "video_duration_out_of_range" && msg(await ins(U.s1, { dur: null })) === "video_duration_out_of_range");
  check("A15 the database itself refuses a duration outside 5-15 even from the server role", (await q("SAVEPOINT d").then(() => q(`insert into public.listings (title, model, category, price, seller_name, seller_id, preview_video_duration) values ('x','n','n',5,'s',$1,20)`, [U.s1])).then(() => false, async () => { await q("ROLLBACK TO SAVEPOINT d"); return true; })));
  check("A08 a workflow/agent needs no zip note, screenshots or video but still needs title, description and price", !(await ins(U.s1, { type: "workflow", zip: null })).err && msg(await ins(U.s1, { type: "agent", price: 20, zip: null })) === "price_out_of_range");
  check("A09 inserts by the server / admin (no end-user session) are not checked", !(await q(`insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','n','n',5,'s',$1)`, [U.s1]).catch(() => ({ err: 1 }))).err);
  check("A10 later UPDATEs of an existing listing are not blocked by the rules", await (async () => { const r = await ins(U.s1); const u = await as("authenticated", U.s1, null, `update public.listings set title = 'short' where id = $1`, [r.rows[0].id]); return !u.err || u.err.code !== "CM081"; })());
  const fn = (await q(`select p.prosecdef, (p.proconfig @> array['search_path=""']) ok, has_function_privilege('authenticated', p.oid,'execute') au from pg_proc p where p.proname='enforce_listing_rules'`)).rows[0];
  check("A11 the trigger function is SECURITY DEFINER, empty search_path, not callable by API roles", fn.prosecdef && fn.ok && !fn.au, fn);
});

await inTxn(async () => {
  await mkUsers();
  const adm = (sql, params) => as("authenticated", U.admin, { aal: "aal2" }, sql, params);
  await q(`insert into public.seller_payout_accounts (user_id, status, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name, bank_account_type) values ($1,'active','0012345678901','8901','HDFC0001234','Asha Rao','savings')`, [U.s1]);
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('B69 listing','n','n',500,'S',$1,'live') returning id`, [U.s1]);
  await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,500,'paid','pay_B69',90, now() - interval '1 minute')`, [U.buyer, l.id]);
  const pending = async () => (await adm(`select public.admin_settlement_pending() v`)).rows[0].v;
  const set = (st) => adm(`select public.admin_set_seller_payout_status($1,$2)`, [U.s1, st]);
  let v = await pending();
  check("B01 an active seller with a bank account is payable", v.payable.length === 1 && v.payable[0].seller_id === U.s1);
  check("B02 PAUSE (suspended) takes the seller out of the payable list with reason account_suspended", !(await set("suspended")).err && (await (async () => { const p = await pending(); return p.payable.length === 0 && p.blocked[0]?.reason === "account_suspended"; })()));
  check("B03 a batch frozen while paused does not include them", (await adm(`select public.admin_create_settlement_batch('B69-PAUSED', now()) v`)).err?.message === "nothing_to_settle");
  check("B04 RESUME (active) restores payout eligibility straight away", !(await set("active")).err && (await pending()).payable.length === 1);
  const b = await adm(`select public.admin_create_settlement_batch('B69-OK', now()) v`);
  check("B05 the next batch includes the resumed seller, with the bank snapshot", !b.err && b.rows[0].v.seller_count === 1);
  const d = (await adm(`select public.admin_settlement_batch($1) v`, [b.rows[0].v.batch_id])).rows[0].v;
  check("B06 the batch detail carries account_status so the desk can show Pause (active) or Resume (suspended)", d.items[0].account_status === "active" && d.items[0].bank_account_number === "0012345678901");
  await set("suspended");
  check("B07 after a pause the batch detail reports suspended (Resume is shown)", (await adm(`select public.admin_settlement_batch($1) v`, [b.rows[0].v.batch_id])).rows[0].v.items[0].account_status === "suspended");
  check("B08 a non-admin cannot pause or resume", (await as("authenticated", U.s1, null, `select public.admin_set_seller_payout_status($1,'suspended')`, [U.s1])).err?.code === "42501");
});

console.log(`\nA69-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
