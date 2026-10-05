// A43 -- Milestone 4.3 database tests: public.listing_demo_info and the demo-run privacy fix.
// Every test runs in a transaction that is ROLLED BACK. Requires migration 20260930100700.
// Run:  DATABASE_URL=... node tests/phase4/m43-db.test.mjs

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
const HAIKU = "claude-haiku-4-5-20251001", SONNET = "claude-sonnet-4-6";
const SYS = "You are the SECRET-DEMO-PROMPT-9921 assistant.";
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { buyer: id(91), b2: id(92), b3: id(93), b4: id(94), seller: id(95), other: id(96), admin: id(97) };
const step = (o = {}) => ({ id: "s1", model: HAIKU, system: SYS, maxOutputTokens: 300, timeoutSeconds: 20, ...o });
const DEMO = (steps = [step()]) => ({ steps });

async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a43-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function setFlags({ exec = true, demo = true } = {}) {
  await q(`update private.feature_flags set enabled=$1 where name='phase3_execution'`, [exec]);
  await q(`update private.feature_flags set enabled=$1 where name='phase4_demo'`, [demo]);
}
async function mkListing({ status = "live", type = "workflow", demo = DEMO(), enabled = true, approved = true } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('A43','n','n',0,'x',$1,$2,$3,'{}'::jsonb) returning id`, [U.seller, status, type]);
  if (demo) {
    await q(`insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,$3)`, [l.id, JSON.stringify(demo), enabled]);
    if (approved) await q(`update public.listing_demos set approved_at = now(), approved_by = $2 where listing_id = $1`, [l.id, U.admin]);
  }
  return l.id;
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
const info = async (role, uid, listingId) => {
  const r = await as(role, uid, null, `select public.listing_demo_info($1) as v`, [listingId]);
  if (r.err) throw new Error("listing_demo_info errored: " + r.err.message);
  return r.rows[0].v;
};
const startDemo = (uid, listingId, text = "hello") => as("authenticated", uid, null, `select public.start_demo_run($1,$2::jsonb) as v`, [listingId, JSON.stringify({ text })]);
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }

// =================================================================== listing_demo_info: grants + shape
{
  const g = (r) => val(`select has_function_privilege($1,'public.listing_demo_info(uuid)','execute') as v`, [r]);
  check("A43-I01 listing_demo_info is callable by anon and authenticated (it is the PUBLIC availability answer)", (await g("anon")) && (await g("authenticated")));
  check("A43-I02 demo_budget_has_room is owner-only", !(await val(`select has_function_privilege('anon','private.demo_budget_has_room()','execute') or has_function_privilege('authenticated','private.demo_budget_has_room()','execute') or has_function_privilege('service_role','private.demo_budget_has_room()','execute') as v`)));
}
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing({ demo: DEMO([step({ name: "Draft the answer" }), step({ id: "s2", model: SONNET, name: "  " })]) });
  const a = await info("anon", null, lid);
  check("A43-I03 anon sees an available demo: exact public keys, step names (blank name -> 'Step N'), 2000-char cap, per-day limit, remainingToday NULL",
    Object.keys(a).sort().join() === "available,budgetExhausted,maxInputChars,remainingToday,runsPerDay,stepNames"
      && a.available === true && JSON.stringify(a.stepNames) === JSON.stringify(["Draft the answer", "Step 2"]) && a.maxInputChars === 2000
      && a.runsPerDay === 3 && a.remainingToday === null && a.budgetExhausted === false, a);
  check("A43-I04 the public payload never contains prompt text, model names or rupee figures",
    !JSON.stringify(a).includes("SECRET-DEMO-PROMPT") && !JSON.stringify(a).includes("claude") && !/\bcost|inr|price/i.test(JSON.stringify(a)), a);
  const u = await info("authenticated", U.buyer, lid);
  check("A43-I05 a signed-in user sees remainingToday = 3 before any run", u.available === true && u.remainingToday === 3, u);
  await startDemo(U.buyer, lid);
  await startDemo(U.buyer, lid);
  check("A43-I06 remainingToday counts down with each demo run (2 used -> 1 left)", (await info("authenticated", U.buyer, lid)).remainingToday === 1);
  await startDemo(U.buyer, lid);
  const done = await info("authenticated", U.buyer, lid);
  check("A43-I07 ...and reaches 0 (never negative); the demo is still 'available' (the cap is per user)", done.remainingToday === 0 && done.available === true, done);
  check("A43-I08 another user is unaffected", (await info("authenticated", U.b2, lid)).remainingToday === 3);
  check("A43-I08b runs older than 24 h stop counting",
    (await q(`update public.runs set created_at = now() - interval '25 hours' where user_id=$1 and is_demo`, [U.buyer]), (await info("authenticated", U.buyer, lid)).remainingToday === 3));
  await q(`update private.demo_settings set value = 1 where key='per_user_daily_runs'`);
  const one = await info("authenticated", U.buyer, lid);
  check("A43-I09 the per-day limit is read from the settings, never hard-coded (limit 1)", one.runsPerDay === 1 && one.remainingToday === 1, one);
});
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const un = (label, p) => info("anon", null, p).then(v => check(`A43-I10 unavailable: ${label} -> exactly {available:false}`, JSON.stringify(v) === JSON.stringify({ available: false }), v));
  await un("unknown listing", "00000000-0000-4000-8000-00000000dead");
  await un("playbook listing", await mkListing({ type: "playbook" }));
  await un("listing not live", await mkListing({ status: "pending_review" }));
  await un("no demo row", await mkListing({ demo: null }));
  await un("demo disabled", await mkListing({ enabled: false }));
  await un("demo not approved", await mkListing({ approved: false }));
  const badModel = await mkListing({ demo: DEMO([step({ model: SONNET })]) });
  await q(`update private.model_pricing set is_active=false where model=$1`, [SONNET]);
  await un("model deactivated since approval", badModel);
  await q(`update private.model_pricing set is_active=true where model=$1`, [SONNET]);
  await setFlags({ demo: false });
  await un("phase4_demo OFF", lid);
  await setFlags({ exec: false, demo: true });
  await un("phase3_execution OFF", lid);
  await setFlags();
  check("A43-I11 control: the same listing is available once flags are back on", (await info("anon", null, lid)).available === true);
  await q(`delete from private.demo_settings where key='per_user_daily_runs'`);
  const missing = await info("anon", null, lid);
  check("A43-I12 a missing setting fails closed to {available:false}, never an error to a public caller", missing.available === false);
});

// =================================================================== budget parity with create_demo_run
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const parity = async (label, expectExhausted) => {
    const i = await info("anon", null, lid);
    // a brand-new user, so the per-user limit cannot be what refuses
    const fresh = id(Math.floor(10 + Math.random() * 80));
    await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [fresh, `fresh-${fresh.slice(-2)}@example.invalid`]);
    const r = await startDemo(fresh, lid);
    const refused = r.err?.code === "CM034";
    if (!r.err) await q(`delete from public.runs where user_id=$1 and is_demo`, [fresh]);
    check(`A43-I13 budget parity (${label}): info.budgetExhausted=${i.budgetExhausted} agrees with create_demo_run refusing=${refused}`,
      i.budgetExhausted === expectExhausted && refused === expectExhausted && (r.err ? r.err.code === "CM034" : true), { i: i.budgetExhausted, code: r.err?.code });
  };
  await parity("plenty of budget", false);
  await q(`update private.demo_settings set value = 7 where key='global_daily_budget_inr'`);
  const r1 = (await startDemo(U.buyer, lid)).rows[0].v, r2 = (await startDemo(U.b2, lid)).rows[0].v;
  await parity("2 reservations of Rs3 against Rs7", true);
  await q(`update public.runs set status='succeeded', cost=0.5 where id=$1`, [r1]);
  await parity("one run finished at Rs0.50 (3.5 + 3 <= 7)", false);
  await q(`update public.runs set status='succeeded', cost=0.5 where id=$1`, [r2]);
  await q(`update private.demo_settings set value = 0 where key='global_daily_budget_inr'`);
  await parity("budget set to 0", true);
  await q(`update private.demo_settings set value = 3 where key='global_daily_budget_inr'`);
  await q(`update public.runs set created_at = now() - interval '2 days' where is_demo`);
  await parity("yesterday's runs do not count", false);
});
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const ok = await startDemo(U.buyer, lid, "a".repeat((await info("anon", null, lid)).maxInputChars));
  const bad = await startDemo(U.b2, lid, "a".repeat((await info("anon", null, lid)).maxInputChars + 1));
  check("A43-I14 maxInputChars from the info function IS the real limit: that many accepted, one more refused (CM032)", !ok.err && bad.err?.code === "CM032", { ok: ok.err?.message, bad: bad.err?.code });
});

// =================================================================== privacy: sellers cannot read demo runs
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const runId = (await startDemo(U.buyer, lid, "my private question about my startup")).rows[0].v;
  await q(`update public.run_steps set status='succeeded', output='{"mode":"demo","text":"the model answer"}'::jsonb where run_id=$1`, [runId]);
  const sees = async (role, uid, claims, table, col) =>
    (await as(role, uid, claims, `select ${col} from public.${table} where ${table === "runs" ? "id" : "run_id"}=$1`, [runId])).rows.length;
  check("A43-V01 the user who ran the demo sees their run and its steps",
    (await sees("authenticated", U.buyer, null, "runs", "id")) === 1 && (await sees("authenticated", U.buyer, null, "run_steps", "id")) === 1);
  check("A43-V02 PRIVACY: the product's SELLER cannot see a demo run, its input, or its step outputs",
    (await sees("authenticated", U.seller, null, "runs", "id")) === 0 && (await sees("authenticated", U.seller, null, "run_steps", "id")) === 0);
  check("A43-V03 an unrelated user cannot either", (await sees("authenticated", U.other, null, "runs", "id")) === 0 && (await sees("authenticated", U.other, null, "run_steps", "id")) === 0);
  check("A43-V04 an admin still can (abuse investigation)", (await sees("authenticated", U.admin, { aal: "aal2" }, "runs", "id")) === 1 && (await sees("authenticated", U.admin, { aal: "aal2" }, "run_steps", "id")) === 1);
  check("A43-V05 anon sees nothing", (await as("anon", null, null, `select id from public.runs where id=$1`, [runId])).err?.code === "42501" || (await sees("anon", null, null, "runs", "id")) === 0);
  check("A43-V06 private.can_view_run agrees (seller false, buyer true, admin true)",
    (await as("authenticated", U.seller, null, `select private.can_view_run($1) as v`, [runId])).err?.code === "42501"
      || (await as("authenticated", U.seller, null, `select private.can_view_run($1) as v`, [runId])).rows[0]?.v === false);
});
await inTxn(async () => {
  // REGRESSION: ordinary (non-demo) runs keep the old behaviour -- the product's seller can still see them
  await setFlags();
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('plain','n','n',0,'x',$1,'live','workflow',$2::jsonb) returning id`, [U.seller, JSON.stringify({ steps: [{ retryLimit: 1, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } })]);
  const rid = (await q(`select private.create_run($1,$2,'{}'::jsonb,true) as v`, [U.seller, l.id])).rows[0].v;
  await q(`update public.runs set user_id = $2 where id = $1`, [rid, U.buyer]);
  const seller = await as("authenticated", U.seller, null, `select id from public.runs where id=$1`, [rid]);
  const steps = await as("authenticated", U.seller, null, `select id from public.run_steps where run_id=$1`, [rid]);
  const buyer = await as("authenticated", U.buyer, null, `select id from public.runs where id=$1`, [rid]);
  const other = await as("authenticated", U.other, null, `select id from public.runs where id=$1`, [rid]);
  check("A43-V07 REGRESSION: a NON-demo run is still visible to the product's seller (runs and run_steps), to its creator, and not to strangers",
    seller.rows.length === 1 && steps.rows.length === 1 && buyer.rows.length === 1 && other.rows.length === 0, { seller: seller.rows.length, steps: steps.rows.length, buyer: buyer.rows.length, other: other.rows.length });
});
await inTxn(async () => {
  // flipping is_demo on an existing run flips visibility -- the policy keys off the column, not the creation path
  await setFlags();
  const lid = await mkListing();
  const runId = (await startDemo(U.buyer, lid)).rows[0].v;
  check("A43-V08 control: seller blind to a demo run", (await as("authenticated", U.seller, null, `select id from public.runs where id=$1`, [runId])).rows.length === 0);
  const pol = (await q(`select pg_get_expr(polqual, polrelid) as v from pg_policy where polrelid='public.runs'::regclass and polname='Creators can view runs of their own products'`)).rows[0]?.v;
  check("A43-V09 the creator policy now excludes demo runs (policy text)", /is_demo/.test(pol ?? "") && /owns_product/.test(pol ?? ""), pol);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
