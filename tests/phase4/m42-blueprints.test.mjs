// A42-S -- Milestone 4.2 blueprint storage: listing metadata constraints, the private
// 'listing-blueprints' bucket, and the storage.objects policies (seller / buyer / admin / stranger).
// Every test runs in a transaction that is ROLLED BACK. Requires migration 20260930100600.
// Run:  DATABASE_URL=... node tests/phase4/m42-blueprints.test.mjs
//
// Policy checks use `set local role authenticated` + JWT claims against storage.objects. They need
// RLS enabled on storage.objects (it always is on Supabase; scratch databases must enable it).

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
const val = async (sql, params) => (await q(sql, params)).rows[0]?.v;
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { sellerA: id(81), sellerB: id(82), buyer: id(83), refunded: id(84), stranger: id(85), admin: id(86) };
const B = "listing-blueprints";
const SHA = "a".repeat(64);

async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a42s-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function mkListing(seller = U.sellerA) {
  await mkUsers();
  return (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type)
                   values ('A42S','n','n',100,'x',$1,'live','workflow') returning id`, [seller])).rows[0].id;
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true)`,
    [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) }), uid ?? ""]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true), set_config('request.jwt.claim.sub','',true)`); }
}
async function expectErr(sql, params) {
  await q("SAVEPOINT e");
  try { await q(sql, params); await q("RELEASE SAVEPOINT e"); return null; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT e"); return e; }
}
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
const put = (name, owner = null) => q(`insert into storage.objects (bucket_id, name, owner) values ($1,$2,$3)`, [B, name, owner]);

// =================================================================== columns + constraints
{
  const cols = (await q(`select column_name, data_type from information_schema.columns where table_schema='public' and table_name='listings' and column_name like 'blueprint_%' order by 1`)).rows;
  check("A42-S01 listings has blueprint_path/format/sha256/size_bytes", cols.map(c => c.column_name).join() === "blueprint_format,blueprint_path,blueprint_sha256,blueprint_size_bytes", cols);
}
await inTxn(async () => {
  const lid = await mkListing();
  const path = `${U.sellerA}/${lid}/bp.json`;
  const set = (o) => expectErr(`update public.listings set blueprint_path=$2, blueprint_format=$3, blueprint_sha256=$4, blueprint_size_bytes=$5 where id=$1`,
    [lid, o.path ?? path, o.format ?? "n8n", o.sha ?? SHA, o.size ?? 1234]);
  check("A42-S02 a complete, well-formed blueprint is accepted", (await set({})) === null);
  for (const f of ["n8n", "flowise", "langflow"]) check(`A42-S02 format '${f}' accepted`, (await set({ format: f })) === null);
  const bad = [
    ["format 'zapier'", { format: "zapier" }], ["sha256 too short", { sha: "abc" }], ["sha256 uppercase", { sha: "A".repeat(64) }], ["sha256 non-hex", { sha: "g".repeat(64) }],
    ["size 0", { size: 0 }], ["size 5 MiB + 1", { size: 5242881 }], ["size negative", { size: -1 }],
    ["folder 2 is a DIFFERENT listing id", { path: `${U.sellerA}/${U.sellerB}/bp.json` }],
    ["extension .zip", { path: `${U.sellerA}/${lid}/bp.zip` }], ["no file name", { path: `${U.sellerA}/${lid}/` }], ["only two segments", { path: `${U.sellerA}/bp.json` }],
    ["path traversal", { path: `${U.sellerA}/${lid}/../x.json` }], ["file name with a slash", { path: `${U.sellerA}/${lid}/a/b.json` }],
    ["base file name 101 chars (limit is 100)", { path: `${U.sellerA}/${lid}/${"a".repeat(101)}.json` }], ["non-uuid folder 1", { path: `notauuid/${lid}/bp.json` }],
    ["uppercase uuid folder", { path: `${U.sellerA.toUpperCase()}/${lid}/bp.json` }], ["spaces in name", { path: `${U.sellerA}/${lid}/my file.json` }],
  ];
  for (const [label, o] of bad) { const e = await set(o); check(`A42-S03 rejects: ${label} (23514)`, e?.code === "23514", e?.code); }
  await q(`update public.listings set blueprint_path=null, blueprint_format=null, blueprint_sha256=null, blueprint_size_bytes=null where id=$1`, [lid]);
  let e = await expectErr(`update public.listings set blueprint_path=$2 where id=$1`, [lid, path]);
  check("A42-S04 path without format/sha/size is rejected: all-or-none (23514)", e?.code === "23514", e?.code);
  await set({});
  e = await expectErr(`update public.listings set blueprint_format=null where id=$1`, [lid]);
  check("A42-S04b clearing only ONE of the four is rejected (23514)", e?.code === "23514", e?.code);
  e = await expectErr(`update public.listings set blueprint_path=null, blueprint_format=null, blueprint_sha256=null, blueprint_size_bytes=null where id=$1`, [lid]);
  check("A42-S04c clearing all four is allowed", e === null, e?.message);
});

// =================================================================== bucket
{
  const b = (await q(`select public, file_size_limit, allowed_mime_types from storage.buckets where id=$1`, [B])).rows[0];
  check("A42-S05 listing-blueprints is PRIVATE, 5 MiB max, application/json only", b && b.public === false && Number(b.file_size_limit) === 5242880
    && JSON.stringify(b.allowed_mime_types) === JSON.stringify(["application/json"]), b);
  const lf = (await q(`select public, file_size_limit, allowed_mime_types from storage.buckets where id='listing-files'`)).rows[0];
  check("A42-S06 the existing listing-files bucket (chat-export ZIPs) is UNTOUCHED: private, no size/MIME restriction added",
    lf && lf.public === false && lf.file_size_limit === null && lf.allowed_mime_types === null, lf);
  const pol = (await q(`select polname from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage' and c.relname='objects'`)).rows.map(r => r.polname);
  check("A42-S07 listing-files policies are all still present (incl. the existing buyer-download policy)",
    ["Sellers can upload their own listing files", "Sellers can view their own listing files", "Sellers can delete their own listing files", "Admins can view any listing file", "Buyers can download files for purchases they made"].every(n => pol.includes(n)), pol);
  check("A42-S08 the 5 new blueprint policies exist", ["Sellers can upload blueprints for their own listings", "Sellers can read their own blueprints", "Sellers can delete their own blueprints", "Admins can read any blueprint", "Buyers can download blueprints they paid for"].every(n => pol.includes(n)), pol);
}

// =================================================================== policies
await inTxn(async () => {
  const lid = await mkListing(U.sellerA);
  const lidB = await mkListing(U.sellerB);
  const ins = (uid, name) => as("authenticated", uid, null, `insert into storage.objects (bucket_id, name, owner) values ($1,$2,$3)`, [B, name, uid]);
  let r = await ins(U.sellerA, `${U.sellerA}/${lid}/blueprint.json`);
  check("A42-S10 a seller can upload a blueprint for THEIR listing in THEIR folder", !r.err, r.err?.message);
  r = await ins(U.sellerA, `${U.sellerA}/${lidB}/blueprint.json`);
  check("A42-S11 ...but not for a listing they do not own (RLS 42501)", r.err?.code === "42501", r.err?.code);
  r = await ins(U.sellerA, `${U.sellerB}/${lidB}/blueprint.json`);
  check("A42-S12 ...nor into another seller's folder (42501)", r.err?.code === "42501", r.err?.code);
  for (const [label, name] of [["non-uuid listing folder", `${U.sellerA}/notauuid/blueprint.json`], ["a .zip", `${U.sellerA}/${lid}/blueprint.zip`],
    ["no listing folder", `${U.sellerA}/blueprint.json`], ["path traversal", `${U.sellerA}/${lid}/../x.json`], ["spaces", `${U.sellerA}/${lid}/my file.json`]]) {
    const x = await ins(U.sellerA, name);
    check(`A42-S13 malformed path rejected: ${label} (42501)`, x.err?.code === "42501", x.err?.code);
  }
  r = await as("anon", null, null, `insert into storage.objects (bucket_id, name) values ($1,$2)`, [B, `${U.sellerA}/${lid}/anon.json`]);
  check("A42-S14 anon cannot upload (42501)", r.err?.code === "42501", r.err?.code);
});
await inTxn(async () => {
  const lid = await mkListing(U.sellerA);
  const name = `${U.sellerA}/${lid}/blueprint.json`;
  await put(name, U.sellerA);
  await put(`${U.sellerB}/${(await mkListing(U.sellerB))}/blueprint.json`, U.sellerB);
  await q(`insert into public.purchases (user_id, listing_id, amount, status) values ($1,$2,100,'paid')`, [U.buyer, lid]);
  await q(`insert into public.purchases (user_id, listing_id, amount, status) values ($1,$2,100,'refunded')`, [U.refunded, lid]);
  const read = (role, uid, claims) => as(role, uid, claims, `select name from storage.objects where bucket_id=$1 and name=$2`, [B, name]);

  let r = await read("authenticated", U.buyer);
  check("A42-S20 a buyer with a PAID purchase can read the blueprint", !r.err && r.rows.length === 1, r.err?.message);
  r = await read("authenticated", U.refunded);
  check("A42-S21 a REFUNDED purchase gives no access", !r.err && r.rows.length === 0, r);
  r = await read("authenticated", U.stranger);
  check("A42-S22 a signed-in user with no purchase gets nothing", !r.err && r.rows.length === 0, r);
  r = await read("anon", null);
  check("A42-S23 anon gets nothing (no error, zero rows)", (!r.err && r.rows.length === 0) || r.err?.code === "42501", r);
  r = await read("authenticated", U.sellerA);
  check("A42-S24 the seller can read their own blueprint", !r.err && r.rows.length === 1, r.err?.message);
  r = await read("authenticated", U.sellerB);
  check("A42-S25 a DIFFERENT seller cannot read it", !r.err && r.rows.length === 0, r);
  r = await read("authenticated", U.admin, { aal: "aal2" });
  check("A42-S26 an admin can read it", !r.err && r.rows.length === 1, r.err?.message);
  r = await read("authenticated", U.admin);
  check("A42-S26b an admin with NO MFA factor enrolled can read at aal1 (private.is_admin semantics: aal2 is only demanded once a factor is verified)", !r.err && r.rows.length === 1, r.err?.message);

  const all = await as("authenticated", U.buyer, null, `select name from storage.objects where bucket_id=$1`, [B]);
  check("A42-S27 the buyer's LIST sees only the blueprint they paid for, not another seller's", !all.err && all.rows.length === 1 && all.rows[0].name === name, all);
  const del = await as("authenticated", U.buyer, null, `delete from storage.objects where bucket_id=$1 and name=$2`, [B, name]);
  check("A42-S28 a buyer cannot delete it", (!del.err && del.rows.length === 0) && (await val(`select count(*)::int as v from storage.objects where bucket_id=$1 and name=$2`, [B, name])) === 1, del.err?.message);
  const del2 = await as("authenticated", U.sellerA, null, `delete from storage.objects where bucket_id=$1 and name=$2`, [B, name]);
  check("A42-S29 the seller can delete their own", !del2.err && (await val(`select count(*)::int as v from storage.objects where bucket_id=$1 and name=$2`, [B, name])) === 0, del2.err?.message);
});
await inTxn(async () => {
  // a malformed object sitting in the bucket must not break anyone else's reads (no uuid casts in policies)
  const lid = await mkListing(U.sellerA);
  const good = `${U.sellerA}/${lid}/blueprint.json`;
  await put(good, U.sellerA);
  await put(`${U.sellerA}/notauuid/poison.json`, U.sellerA);   // inserted as owner, bypassing RLS
  await put(`${U.sellerA}/12345/other.json`, U.sellerA);
  await put(`not-even-a-path.json`, U.sellerA);
  await q(`insert into public.purchases (user_id, listing_id, amount, status) values ($1,$2,100,'paid')`, [U.buyer, lid]);
  const r = await as("authenticated", U.buyer, null, `select name from storage.objects where bucket_id=$1 order by name`, [B]);
  check("A42-S30 CAST SAFETY: with malformed objects present, a buyer's bucket-wide query still succeeds and returns the paid blueprint",
    !r.err && r.rows.length === 1 && r.rows[0].name === good, r.err?.message ?? r.rows);
});
await inTxn(async () => {
  // the existing listing-files access still works exactly as before
  const lid = await mkListing(U.sellerA);
  await q(`insert into storage.objects (bucket_id, name, owner) values ('listing-files',$1,$2)`, [`${U.sellerA}/${lid}/export.zip`, U.sellerA]);
  await q(`insert into public.purchases (user_id, listing_id, amount, status) values ($1,$2,100,'paid')`, [U.buyer, lid]);
  const buyer = await as("authenticated", U.buyer, null, `select name from storage.objects where bucket_id='listing-files'`);
  const stranger = await as("authenticated", U.stranger, null, `select name from storage.objects where bucket_id='listing-files'`);
  check("A42-S31 REGRESSION: listing-files ZIP downloads still work for a buyer and still hide from strangers",
    !buyer.err && buyer.rows.length === 1 && !stranger.err && stranger.rows.length === 0, { buyer: buyer.err?.message ?? buyer.rows.length, stranger: stranger.err?.message ?? stranger.rows.length });
  const wrongBucket = await as("authenticated", U.buyer, null, `select name from storage.objects where bucket_id=$1`, [B]);
  check("A42-S32 a paid purchase does NOT cross buckets (the ZIP purchase grants nothing in listing-blueprints)", !wrongBucket.err && wrongBucket.rows.length === 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
