// A42 -- Milestone 4.2 database tests: model pricing, demo config, demo start gates and caps,
// listing_demos RLS/approval, worker step context, prompt secrecy, end-to-end demo run.
//
// Same conventions as m40/m41: plain script, check(), DATABASE_URL = owner connection, every
// behavioural test inside a transaction that is ROLLED BACK (pg_net queues transactionally, so
// nothing reaches the worker). Role-restricted checks use `set local role` + JWT claims.
//
// Requires migrations 20260930100400 + 100500 and a configured dispatch Vault.
// Run:  DATABASE_URL=... node tests/phase4/m42-demo.test.mjs

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
const SYS = "You are the SECRET-DEMO-PROMPT-7731 assistant. Answer briefly.";
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { buyer: id(71), b2: id(72), b3: id(73), b4: id(74), seller: id(75), other: id(76), admin: id(77) };

// ------------------------------------------------------------------ helpers
const step = (o = {}) => ({ id: "s1", model: HAIKU, system: SYS, maxOutputTokens: 300, timeoutSeconds: 20, ...o });
const DEMO = (steps = [step()]) => ({ steps });
async function mkUsers(cli) {
  for (const uid of Object.values(U)) {
    await cli.query(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a42-${uid.slice(-2)}@example.invalid`]);
  }
  await cli.query(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function setFlags(cli, { exec = true, demo = true } = {}) {
  await cli.query(`update private.feature_flags set enabled=$1 where name='phase3_execution'`, [exec]);
  await cli.query(`update private.feature_flags set enabled=$1 where name='phase4_demo'`, [demo]);
}
async function mkListing(cli, { status = "live", type = "workflow", demo = DEMO(), enabled = true, approved = true } = {}) {
  await mkUsers(cli);
  const { rows: [l] } = await cli.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('A42 fixture','n/a','n/a',0,'fixture',$1,$2,$3,'{}'::jsonb) returning id`, [U.seller, status, type]);
  if (demo) {
    await cli.query(`insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,$3)`, [l.id, JSON.stringify(demo), enabled]);
    if (approved) await cli.query(`update public.listing_demos set approved_at = now(), approved_by = $2 where listing_id = $1`, [l.id, U.admin]);
  }
  return l.id;
}
async function as(cli, role, uid, claims, sql, params) {
  await cli.query(`select set_config('request.jwt.claims',$1,true), set_config('request.jwt.claim.sub',$2,true)`,
    [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) }), uid ?? ""]);   // no sub claim at all for anon/no-user
  await cli.query(`set local role ${role}`);
  await cli.query("SAVEPOINT r");
  try { const r = await cli.query(sql, params); await cli.query("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await cli.query("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally {
    await cli.query("reset role");
    await cli.query(`select set_config('request.jwt.claims','',true), set_config('request.jwt.claim.sub','',true)`);
  }
}
async function expectErr(cli, sql, params) {
  await cli.query("SAVEPOINT e");
  try { await cli.query(sql, params); await cli.query("RELEASE SAVEPOINT e"); return null; }
  catch (e) { await cli.query("ROLLBACK TO SAVEPOINT e"); return e; }
}
const startDemo = async (cli, uid, listingId, input = { text: "hello demo" }) =>
  as(cli, "authenticated", uid, null, `select public.start_demo_run($1,$2::jsonb) as v`, [listingId, JSON.stringify(input)]);
const startOk = async (cli, uid, listingId, input) => {
  const r = await startDemo(cli, uid, listingId, input);
  if (r.err) throw new Error("expected demo start to succeed: " + r.err.message);
  return r.rows[0].v;
};
const claim = async (cli, runId) => (await cli.query(`select private.claim_next_step($1) as v`, [runId])).rows[0].v;
const ctxOf = async (cli, runId, c) => (await cli.query(`select private.get_step_context($1,$2,$3) as v`, [runId, c.step_id, c.retry_count])).rows[0].v;
const checkpoint = async (cli, runId, c, output, cost) =>
  (await cli.query(`select private.checkpoint_step($1,$2,$3,$4::jsonb,$5) as v`, [runId, c.step_id, c.retry_count, JSON.stringify(output), cost])).rows[0].v;
const runRow = async (cli, runId) => (await cli.query(`select status, error, cost, is_demo, is_sandbox, input, execution_config from public.runs where id=$1`, [runId])).rows[0];
const maxQ = async () => Number(await val(`select coalesce(max(id),0)::bigint as v from net.http_request_queue`));
const since = async (m) => Number(await val(`select count(*)::int as v from net.http_request_queue where id > $1`, [m]));
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
const codeIs = (e, code, msg) => e?.code === code && (msg === undefined || e?.message === msg || (msg instanceof RegExp && msg.test(e?.message)));

// =================================================================== PRICING
{
  const rows = (await q(`select model, tier, is_active, is_demo_default, input_inr_per_mtok::float8 as i, output_inr_per_mtok::float8 as o,
                                input_usd_per_mtok::float8 as iu, output_usd_per_mtok::float8 as ou, fx_inr_per_usd::float8 as fx, safety_margin::float8 as m
                           from private.model_pricing order by model`)).rows;
  const by = Object.fromEntries(rows.map(r => [r.model, r]));
  check("A42-P01 exactly the two live models are seeded (the retired claude-3-* models are NOT)",
    rows.length === 2 && !!by[HAIKU] && !!by[SONNET] && by[HAIKU].is_active && by[SONNET].is_active, rows.map(r => r.model));
  check("A42-P02 tiers + exactly one demo default (Haiku 4.5)",
    by[HAIKU].tier === "economy" && by[SONNET].tier === "intelligence" && by[HAIKU].is_demo_default && !by[SONNET].is_demo_default);
  check("A42-P03 pinned USD rates, FX 86, 5% margin",
    by[HAIKU].iu === 1 && by[HAIKU].ou === 5 && by[SONNET].iu === 3 && by[SONNET].ou === 15 && by[HAIKU].fx === 86 && by[HAIKU].m === 0.05, by);
  check("A42-P04 derived INR/MTok: Haiku 90.30 / 451.50, Sonnet 270.90 / 1354.50",
    by[HAIKU].i === 90.3 && by[HAIKU].o === 451.5 && by[SONNET].i === 270.9 && by[SONNET].o === 1354.5, [by[HAIKU].i, by[HAIKU].o, by[SONNET].i, by[SONNET].o]);
  check("A42-P05 is_model_allowed: both seeded true; retired / unknown false",
    (await val(`select private.is_model_allowed($1) as v`, [HAIKU])) === true && (await val(`select private.is_model_allowed($1) as v`, [SONNET])) === true
    && (await val(`select private.is_model_allowed('claude-3-5-haiku-20241022') as v`)) === false && (await val(`select private.is_model_allowed('gpt-4o') as v`)) === false
    && (await val(`select private.is_model_allowed(null) as v`)) === false);
}
await inTxn(async () => {
  let e = await expectErr(client, `insert into private.model_pricing (model,tier,input_usd_per_mtok,output_usd_per_mtok,fx_inr_per_usd,is_demo_default) values ('claude-test-x','economy',1,1,86,true)`);
  check("A42-P06 a second demo default is rejected (23505)", e?.code === "23505", e?.code);
  await q(`update private.model_pricing set is_active=false where model=$1`, [SONNET]);
  check("A42-P07 an inactive model is no longer allowed", (await val(`select private.is_model_allowed($1) as v`, [SONNET])) === false);
  e = await expectErr(client, `select private.model_cost_inr($1, 1, 1)`, [SONNET]);
  check("A42-P08 model_cost_inr on an inactive model: CM041 model_not_allowed", codeIs(e, "CM041", "model_not_allowed"), e?.message);
  e = await expectErr(client, `select private.model_cost_inr($1, -1, 1)`, [HAIKU]);
  check("A42-P09 negative token count: CM040", codeIs(e, "CM040"), e?.code);
  e = await expectErr(client, `update private.model_pricing set safety_margin = 2 where model=$1`, [HAIKU]);
  check("A42-P10 table CHECKs hold (margin > 1 rejected)", e?.code === "23514", e?.code);
});
{
  // cost function == exact integer math (the same math the worker uses)
  const rates = { [HAIKU]: [903000n, 4515000n], [SONNET]: [2709000n, 13545000n] }; // INR/MTok * 1e4
  const vectors = [[0, 0], [1, 0], [0, 1], [1000, 500], [7, 3], [123456, 789], [200000, 1024], [999999, 999999]];
  let bad = [];
  for (const m of [HAIKU, SONNET]) for (const [i, o] of vectors) {
    const n = BigInt(i) * rates[m][0] + BigInt(o) * rates[m][1];
    const want = Number((n + 999999n) / 1000000n) / 1e4;
    const got = Number(await val(`select private.model_cost_inr($1,$2,$3) as v`, [m, i, o]));
    if (got !== want) bad.push({ m, i, o, got, want });
  }
  check("A42-P11 model_cost_inr equals exact integer math, rounded UP to 4 decimals, for 16 vectors", bad.length === 0, bad);
  check("A42-P12 cost of 1 input token is rounded UP to 0.0001 (never under-counts)",
    Number(await val(`select private.model_cost_inr($1,1,0) as v`, [HAIKU])) === 0.0001);
}
{
  const fnOwnerOnly = async (sig) => {
    for (const r of ["anon", "authenticated", "service_role"]) {
      if (await val(`select has_function_privilege($1,$2::regprocedure,'execute') as v`, [r, sig])) return false;
    }
    return !(await val(`select has_function_privilege('public',$1::regprocedure,'execute') as v`, [sig]));
  };
  const priv = [];
  for (const sig of ["private.is_model_allowed(text)", "private.model_cost_inr(text,bigint,bigint)", "private.is_demo_enabled()", "private.demo_setting(text)",
    "private.assert_demo_config(jsonb)", "private.build_demo_run_config(jsonb)", "private.assert_demo_run_config(jsonb)", "private.create_demo_run(uuid,uuid,jsonb)",
    "private.get_step_context(uuid,uuid,integer)", "private.runs_enforce_demo_config()", "private.listing_demos_before_write()"]) {
    if (!(await fnOwnerOnly(sig))) priv.push(sig);
  }
  check("A42-PR01 every new private function is owner-only", priv.length === 0, priv);
  const tbl = [];
  for (const t of ["private.model_pricing", "private.demo_settings", "private.demo_run_snapshots"]) {
    for (const r of ["anon", "authenticated", "service_role"]) {
      if (await val(`select has_table_privilege($1,$2,'select') as v`, [r, t])) tbl.push(`${r}:${t}`);
    }
  }
  check("A42-PR02 pricing, settings and prompt-snapshot tables are unreadable by every API role", tbl.length === 0, tbl);
  const g = (r, s) => val(`select has_function_privilege($1,$2::regprocedure,'execute') as v`, [r, s]);
  check("A42-PR03 start_demo_run: authenticated only",
    (await g("authenticated", "public.start_demo_run(uuid,jsonb)")) && !(await g("anon", "public.start_demo_run(uuid,jsonb)")) && !(await g("service_role", "public.start_demo_run(uuid,jsonb)")));
  check("A42-PR04 worker_get_step_context: service_role only",
    (await g("service_role", "public.worker_get_step_context(uuid,uuid,integer)")) && !(await g("authenticated", "public.worker_get_step_context(uuid,uuid,integer)")) && !(await g("anon", "public.worker_get_step_context(uuid,uuid,integer)")));
  check("A42-PR05 set_listing_demo_approval: authenticated only (admin check is inside)",
    (await g("authenticated", "public.set_listing_demo_approval(uuid,boolean)")) && !(await g("anon", "public.set_listing_demo_approval(uuid,boolean)")));
  check("A42-PR06 flag phase4_demo exists and is OFF", (await q(`select enabled from private.feature_flags where name='phase4_demo'`)).rows[0]?.enabled === false
    && (await val(`select private.is_demo_enabled() as v`)) === false);
}
await inTxn(async () => {
  await q(`delete from private.feature_flags where name='phase4_demo'`);
  check("A42-PR07 is_demo_enabled() fails closed when the flag row is missing", (await val(`select private.is_demo_enabled() as v`)) === false);
});

// =================================================================== DEMO CONFIG VALIDATION
await inTxn(async () => {
  const ok = [
    ["one Haiku step", DEMO()],
    ["two steps (Haiku then Sonnet)", DEMO([step(), step({ id: "s2", model: SONNET, maxOutputTokens: 1024 })])],
    ["optional name / explicit retryLimit 0 / timeout 30", DEMO([step({ name: "Draft", retryLimit: 0, timeoutSeconds: 30 })])],
    ["boundary: 3000-char system prompt, 1024 tokens", DEMO([step({ system: "x".repeat(3000), maxOutputTokens: 1024 })])],
  ];
  for (const [label, cfg] of ok) {
    const e = await expectErr(client, `select private.assert_demo_config($1::jsonb)`, [JSON.stringify(cfg)]);
    check(`A42-C valid: ${label}`, e === null, e?.message);
  }
  const bad = [
    ["3 steps (> 2)", DEMO([step(), step(), step()]), "CM001", "demo_config_exceeds_cap:steps"],
    ["0 steps", { steps: [] }, "CM002", "demo_config_invalid:steps"],
    ["steps is not an array", { steps: "x" }, "CM002", "demo_config_invalid:steps"],
    ["config is an array", [], "CM002", "demo_config_invalid:config"],
    ["extra top-level key (limits)", { steps: [step()], limits: { maxCostInr: 50 } }, "CM002", "demo_config_invalid:unknown_key:limits"],
    ["a tool on a step", DEMO([step({ tool: { toolId: "x", permission: "SEND" } })]), "CM002", "demo_config_invalid:steps[0].unknown_key:tool"],
    ["unknown step key (prompt)", DEMO([step({ prompt: "x" })]), "CM002", "demo_config_invalid:steps[0].unknown_key:prompt"],
    ["step is not an object", { steps: [5] }, "CM002", "demo_config_invalid:steps[0]"],
    ["model missing", DEMO([{ ...step(), model: undefined }]), "CM002", "demo_config_invalid:steps[0].model"],
    ["model is a number", DEMO([step({ model: 5 })]), "CM002", "demo_config_invalid:steps[0].model"],
    ["model not on the allowlist (gpt-4o)", DEMO([step({ model: "gpt-4o" })]), "CM002", "demo_config_model_not_allowed:steps[0]"],
    ["retired model claude-3-5-haiku-20241022", DEMO([step({ model: "claude-3-5-haiku-20241022" })]), "CM002", "demo_config_model_not_allowed:steps[0]"],
    ["second step with a bad model", DEMO([step(), step({ model: "nope" })]), "CM002", "demo_config_model_not_allowed:steps[1]"],
    ["system empty", DEMO([step({ system: "" })]), "CM002", "demo_config_invalid:steps[0].system"],
    ["system 3001 chars", DEMO([step({ system: "x".repeat(3001) })]), "CM002", "demo_config_invalid:steps[0].system"],
    ["system missing", DEMO([{ ...step(), system: undefined }]), "CM002", "demo_config_invalid:steps[0].system"],
    ["maxOutputTokens 0", DEMO([step({ maxOutputTokens: 0 })]), "CM002", "demo_config_invalid:steps[0].maxOutputTokens"],
    ["maxOutputTokens 1025", DEMO([step({ maxOutputTokens: 1025 })]), "CM002", "demo_config_invalid:steps[0].maxOutputTokens"],
    ["maxOutputTokens 1.5", DEMO([step({ maxOutputTokens: 1.5 })]), "CM002", "demo_config_invalid:steps[0].maxOutputTokens"],
    ["maxOutputTokens a string", DEMO([step({ maxOutputTokens: "300" })]), "CM002", "demo_config_invalid:steps[0].maxOutputTokens"],
    ["maxOutputTokens missing", DEMO([{ ...step(), maxOutputTokens: undefined }]), "CM002", "demo_config_invalid:steps[0].maxOutputTokens"],
    ["timeoutSeconds 31", DEMO([step({ timeoutSeconds: 31 })]), "CM002", "demo_config_invalid:steps[0].timeoutSeconds"],
    ["timeoutSeconds 0", DEMO([step({ timeoutSeconds: 0 })]), "CM002", "demo_config_invalid:steps[0].timeoutSeconds"],
    ["retryLimit 1", DEMO([step({ retryLimit: 1 })]), "CM002", "demo_config_invalid:steps[0].retryLimit"],
    ["id 65 chars", DEMO([step({ id: "i".repeat(65) })]), "CM002", "demo_config_invalid:steps[0].id"],
  ];
  for (const [label, cfg, code, msg] of bad) {
    const e = await expectErr(client, `select private.assert_demo_config($1::jsonb)`, [JSON.stringify(cfg)]);
    check(`A42-C rejects: ${label}`, codeIs(e, code, msg), { code: e?.code, msg: e?.message });
  }
  const e = await expectErr(client, `select private.assert_demo_config(null)`);
  check("A42-C rejects: SQL NULL config", codeIs(e, "CM002", "demo_config_invalid:config"), e?.message);

  // build_demo_run_config: prompt-free, platform-set limits, valid under both L2 assertions
  const built = (await q(`select private.build_demo_run_config($1::jsonb) as v`, [JSON.stringify(DEMO([step(), step({ id: "s2", model: SONNET, timeoutSeconds: undefined })]))])).rows[0].v;
  check("A42-C build: no prompt text anywhere in the frozen config", !JSON.stringify(built).includes("SECRET-DEMO-PROMPT") && !("system" in built.steps[0]), built);
  check("A42-C build: limits are platform-set (maxCostInr 3, maxSteps 2, timeout = sum of step timeouts), retryLimit 0, default timeout 30",
    built.limits.maxCostInr === 3 && built.limits.maxSteps === 2 && built.limits.timeoutSeconds === 50 && built.steps.every(s => s.retryLimit === 0) && built.steps[1].timeoutSeconds === 30, built);
  const e1 = await expectErr(client, `select private.assert_execution_config_within_ceilings($1::jsonb)`, [JSON.stringify(built)]);
  const e2 = await expectErr(client, `select private.assert_demo_run_config($1::jsonb)`, [JSON.stringify(built)]);
  check("A42-C build: output passes the existing L2 ceilings AND the demo L2", e1 === null && e2 === null, [e1?.message, e2?.message]);

  const mutate = (f) => { const c = JSON.parse(JSON.stringify(built)); f(c); return c; };
  const runBad = [
    ["step carries 'system' (prompt leak)", mutate(c => { c.steps[0].system = "x"; }), "CM002"],
    ["step carries 'prompt'", mutate(c => { c.steps[0].prompt = "x"; }), "CM002"],
    ["step carries a tool", mutate(c => { c.steps[0].tool = { permission: "SEND" }; }), "CM002"],
    ["retryLimit 1", mutate(c => { c.steps[0].retryLimit = 1; }), "CM002"],
    ["model not allowed", mutate(c => { c.steps[0].model = "gpt-4o"; }), "CM002"],
    ["maxOutputTokens 2000", mutate(c => { c.steps[0].maxOutputTokens = 2000; }), "CM002"],
    ["maxCostInr 4 (> demo cap 3)", mutate(c => { c.limits.maxCostInr = 4; }), "CM001"],
    ["3 steps", mutate(c => { c.steps.push({ ...c.steps[0] }); c.limits.maxSteps = 3; }), "CM001"],
  ];
  for (const [label, cfg, code] of runBad) {
    const e = await expectErr(client, `select private.assert_demo_run_config($1::jsonb)`, [JSON.stringify(cfg)]);
    check(`A42-C run-config rejects: ${label}`, e?.code === code, { code: e?.code, msg: e?.message });
  }
});
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  const bad = JSON.parse(JSON.stringify((await q(`select private.build_demo_run_config($1::jsonb) as v`, [JSON.stringify(DEMO())])).rows[0].v));
  bad.steps[0].system = "leak";
  let e = await expectErr(client, `insert into public.runs (user_id, product_id, product_version, is_demo, execution_config) values ($1,$2,1,true,$3::jsonb)`, [U.buyer, listingId, JSON.stringify(bad)]);
  check("A42-C trigger: a demo run row whose frozen config carries a prompt cannot be inserted", e?.code === "CM002", e?.message);
  e = await expectErr(client, `insert into public.runs (user_id, product_id, product_version, is_demo, is_sandbox, execution_config) values ($1,$2,1,true,true,$3::jsonb)`,
    [U.buyer, listingId, JSON.stringify((await q(`select private.build_demo_run_config($1::jsonb) as v`, [JSON.stringify(DEMO())])).rows[0].v)]);
  check("A42-C a run cannot be both demo and owner-sandbox (23514)", e?.code === "23514", e?.code);
  e = await expectErr(client, `insert into public.runs (user_id, product_id, product_version, is_demo, execution_config) values ($1,$2,1,false,$3::jsonb)`,
    [U.buyer, listingId, JSON.stringify(bad)]);
  check("A42-C trigger does not interfere with non-demo runs (same config, is_demo=false, accepted by the demo trigger)", e === null || e?.message?.startsWith("config_") , e?.message);
});

// =================================================================== LISTING_DEMOS RLS + APPROVAL
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client, { demo: DEMO(), approved: false });
  let r = await as(client, "anon", null, null, `select * from public.listing_demos`);
  check("A42-L01 anon cannot read demos at all (42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "authenticated", U.other, null, `select listing_id from public.listing_demos`);
  check("A42-L02 an unrelated signed-in user sees zero demo rows", !r.err && r.rows.length === 0, r);
  r = await as(client, "authenticated", U.buyer, null, `select listing_id from public.listing_demos`);
  check("A42-L02b a would-be demo user cannot read the demo config either", !r.err && r.rows.length === 0, r);
  r = await as(client, "authenticated", U.seller, null, `select demo_config from public.listing_demos where listing_id=$1`, [listingId]);
  check("A42-L03 the seller reads their own demo", !r.err && r.rows.length === 1 && r.rows[0].demo_config.steps[0].system === SYS, r.err?.message);
  r = await as(client, "authenticated", U.admin, { aal: "aal2" }, `select listing_id from public.listing_demos where listing_id=$1`, [listingId]);
  check("A42-L04 an admin can read it", !r.err && r.rows.length === 1, r.err?.message);

  r = await as(client, "authenticated", U.other, null, `insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [listingId + "", JSON.stringify(DEMO())]);
  check("A42-L05 another user cannot create/replace a demo for someone else's listing (RLS or duplicate)", !!r.err, r);
  const l2 = (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type) values ('b','n','n',0,'x',$1,'live','workflow') returning id`, [U.seller])).rows[0].id;
  r = await as(client, "authenticated", U.other, null, `insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [l2, JSON.stringify(DEMO())]);
  check("A42-L05b ...and cannot insert for a listing they do not own (RLS violation 42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "authenticated", U.seller, null, `insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [l2, JSON.stringify(DEMO())]);
  check("A42-L06 the seller can create a demo for their own listing", !r.err, r.err?.message);
  r = await as(client, "authenticated", U.seller, null, `insert into public.listing_demos (listing_id, demo_config, is_enabled, approved_at) values ($1,$2::jsonb,true, now())`, [
    (await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type) values ('c','n','n',0,'x',$1,'live','workflow') returning id`, [U.seller])).rows[0].id, JSON.stringify(DEMO())]);
  check("A42-L07 a seller cannot write approved_at (column privilege, 42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set approved_by = $2 where listing_id=$1`, [listingId, U.seller]);
  check("A42-L07b ...nor approved_by on update (42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set approved_at = now() where listing_id=$1`, [listingId]);
  check("A42-L07c ...nor approved_at on update: a seller cannot self-approve (42501)", r.err?.code === "42501", r.err?.code);
  check("A42-L07d ...and the demo is still unapproved afterwards", (await val(`select approved_at is null as v from public.listing_demos where listing_id=$1`, [listingId])) === true);
  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set is_enabled = true, demo_config = demo_config where listing_id=$1`, [listingId]);
  check("A42-L07e the columns sellers legitimately own (is_enabled, demo_config) remain updatable", !r.err, r.err?.message);
  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set demo_config = $2::jsonb where listing_id=$1`, [listingId, JSON.stringify(DEMO([step({ tools: 1 })]))]);
  check("A42-L08 the seller cannot save an invalid demo config (trigger, CM002)", r.err?.code === "CM002", r.err?.message);
  r = await as(client, "authenticated", U.seller, null, `delete from public.listing_demos where listing_id=$1`, [listingId]);
  check("A42-L09 sellers have no DELETE privilege (42501)", r.err?.code === "42501", r.err?.code);
});
await inTxn(async () => {
  const listingId = await mkListing(client, { approved: false });
  const approve = (uid, claims, flag = true) => as(client, "authenticated", uid, claims, `select public.set_listing_demo_approval($1,$2)`, [listingId, flag]);
  let r = await approve(U.seller, null);
  check("A42-L10 a seller cannot approve their own demo (42501 admin_required)", r.err?.code === "42501" && r.err?.message === "admin_required", r.err?.message);
  r = await approve(U.admin, null);
  check("A42-L11 an admin WITHOUT MFA (aal1) cannot approve either", r.err?.code === "42501", r.err?.message);
  r = await approve(U.admin, { aal: "aal2" });
  const row = (await q(`select approved_at, approved_by from public.listing_demos where listing_id=$1`, [listingId])).rows[0];
  check("A42-L12 an admin with MFA approves: approved_at set, approved_by = the admin", !r.err && row.approved_at !== null && row.approved_by === U.admin, { err: r.err?.message, row });

  await q(`update public.listing_demos set is_enabled = false where listing_id=$1`, [listingId]);
  check("A42-L13 toggling is_enabled keeps the approval (it is a separate switch)", (await val(`select approved_at is not null as v from public.listing_demos where listing_id=$1`, [listingId])) === true);
  await q(`update public.listing_demos set is_enabled = true where listing_id=$1`, [listingId]);

  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set demo_config = demo_config where listing_id=$1`, [listingId]);
  check("A42-L14 re-saving an UNCHANGED config keeps the approval", !r.err && (await val(`select approved_at is not null as v from public.listing_demos where listing_id=$1`, [listingId])) === true, r.err?.message);
  r = await as(client, "authenticated", U.seller, null, `update public.listing_demos set demo_config = $2::jsonb where listing_id=$1`, [listingId, JSON.stringify(DEMO([step({ system: "changed prompt" })]))]);
  const after = (await q(`select approved_at, approved_by from public.listing_demos where listing_id=$1`, [listingId])).rows[0];
  check("A42-L15 ANY change to the demo config WITHDRAWS the approval", !r.err && after.approved_at === null && after.approved_by === null, { err: r.err?.message, after });

  await q(`update public.listing_demos set is_enabled=false where listing_id=$1`, [listingId]);
  r = await approve(U.admin, { aal: "aal2" });
  check("A42-L16 approving a disabled demo is refused (CM031)", r.err?.code === "CM031", r.err?.message);
  await q(`delete from public.listing_demos where listing_id=$1`, [listingId]);
  r = await approve(U.admin, { aal: "aal2" });
  check("A42-L17 approving a listing with no demo is refused (CM031)", r.err?.code === "CM031", r.err?.message);
});
await inTxn(async () => {
  const listingId = await mkListing(client, { approved: true });
  const r = await as(client, "authenticated", U.admin, { aal: "aal2" }, `select public.set_listing_demo_approval($1,false)`, [listingId]);
  check("A42-L18 an admin can withdraw an approval", !r.err && (await val(`select approved_at is null as v from public.listing_demos where listing_id=$1`, [listingId])) === true, r.err?.message);
});

// =================================================================== START_DEMO_RUN GATES
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  const mark = await maxQ();
  const runId = await startOk(client, U.buyer, listingId, { text: "hello demo" });
  const run = await runRow(client, runId);
  const steps = (await q(`select step_index, status from public.run_steps where run_id=$1`, [runId])).rows;
  check("A42-D01a a signed-in NON-buyer can start a demo (no entitlement): queued, demo, not sandbox, input stored",
    run.status === "queued" && run.is_demo === true && run.is_sandbox === false && run.input.text === "hello demo", run);
  check("A42-D01b frozen config: maxCostInr 3, 1 step, retryLimit 0, NO prompt text; step 0 pending",
    run.execution_config.limits.maxCostInr === 3 && run.execution_config.steps.length === 1 && run.execution_config.steps[0].retryLimit === 0
      && !JSON.stringify(run.execution_config).includes("SECRET-DEMO-PROMPT") && steps.length === 1 && steps[0].status === "pending", run.execution_config);
  const snap = (await q(`select demo_config from private.demo_run_snapshots where run_id=$1`, [runId])).rows[0];
  check("A42-D01c the prompt is snapshotted privately", snap?.demo_config.steps[0].system === SYS);
  check("A42-D01d the first step is dispatched exactly once", (await since(mark)) === 1);

  const own = await as(client, "authenticated", U.buyer, null, `select * from public.runs where id=$1`, [runId]);
  check("A42-D02 the demo user can read their run through RLS (select *) and it contains NO prompt text",
    !own.err && own.rows.length === 1 && !JSON.stringify(own.rows[0]).includes("SECRET-DEMO-PROMPT"), own.err?.message);
  const snapRead = await as(client, "authenticated", U.buyer, null, `select * from private.demo_run_snapshots`);
  check("A42-D03 ...and cannot read the snapshot table (schema private, 42501)", snapRead.err?.code === "42501", snapRead.err?.code);
  const other = await as(client, "authenticated", U.other, null, `select id from public.runs where id=$1`, [runId]);
  check("A42-D04 another user cannot see that run", !other.err && other.rows.length === 0);
});
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  const bad = [
    ["missing text key", {}], ["extra key alongside text", { text: "hi", system: "override" }], ["text is a number", { text: 5 }],
    ["text is null", { text: null }], ["empty text", { text: "" }], ["blank text", { text: "   \n " }], ["2001 chars", { text: "a".repeat(2001) }],
    ["input is an array", ["hi"]], ["input is a string", "hi"], ["input is null", null],
  ];
  for (const [label, inp] of bad) {
    const r = await startDemo(client, U.buyer, listingId, inp);
    check(`A42-D05 invalid input (${label}): CM032`, codeIs(r.err, "CM032", "invalid_demo_input"), r.err?.message);
  }
  for (const [label, inp] of [["exactly 2000 chars", { text: "a".repeat(2000) }], ["2000 Hindi chars (multi-byte)", { text: "अ".repeat(2000) }], ["1 char", { text: "a" }]]) {
    const r = await startDemo(client, U.buyer, listingId, inp);
    check(`A42-D06 valid input (${label}) is accepted`, !r.err, r.err?.message);
    if (label !== "1 char") await q(`delete from public.runs where user_id=$1 and is_demo`, [U.buyer]);
  }
});
await inTxn(async () => {
  await setFlags(client, { demo: false });
  const listingId = await mkListing(client);
  let r = await startDemo(client, U.buyer, listingId);
  check("A42-D07 phase4_demo OFF: CM030 demo_disabled", codeIs(r.err, "CM030", "demo_disabled"), r.err?.message);
  await setFlags(client, { exec: false, demo: true });
  r = await startDemo(client, U.buyer, listingId);
  check("A42-D08 phase3_execution OFF: CM010 execution_disabled", codeIs(r.err, "CM010", "execution_disabled"), r.err?.message);
});
await inTxn(async () => {
  await setFlags(client);
  const gone = await startDemo(client, U.buyer, "00000000-0000-4000-8000-00000000dead");
  check("A42-D09 unknown listing: CM011", codeIs(gone.err, "CM011"), gone.err?.message);
  const play = await startDemo(client, U.buyer, await mkListing(client, { type: "playbook" }));
  check("A42-D10 a playbook listing: CM012 product_not_executable", codeIs(play.err, "CM012"), play.err?.message);
  const pend = await startDemo(client, U.buyer, await mkListing(client, { status: "pending_review" }));
  check("A42-D11 a listing that is not live: CM014", codeIs(pend.err, "CM014"), pend.err?.message);
  const rem = await startDemo(client, U.buyer, await mkListing(client, { status: "removed" }));
  check("A42-D11b a removed listing: CM014", codeIs(rem.err, "CM014"), rem.err?.message);
  for (const [label, opts] of [["no demo row", { demo: null }], ["demo disabled", { enabled: false }], ["demo not approved", { approved: false }]]) {
    const r = await startDemo(client, U.buyer, await mkListing(client, opts));
    check(`A42-D12 ${label}: CM031 demo_not_available`, codeIs(r.err, "CM031", "demo_not_available"), r.err?.message);
  }
  const lid = await mkListing(client, { demo: DEMO([step({ model: SONNET })]) });
  await q(`update private.model_pricing set is_active=false where model=$1`, [SONNET]);
  const dead = await startDemo(client, U.buyer, lid);
  check("A42-D13 a model deactivated AFTER approval makes the demo unavailable (CM031), not a runtime failure", codeIs(dead.err, "CM031"), dead.err?.message);
});
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  let r = await as(client, "anon", null, null, `select public.start_demo_run($1,'{"text":"x"}')`, [listingId]);
  check("A42-D14 the anon role cannot execute start_demo_run (42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "service_role", null, null, `select public.start_demo_run($1,'{"text":"x"}')`, [listingId]);
  check("A42-D14b service_role cannot either (42501)", r.err?.code === "42501", r.err?.code);
  r = await as(client, "authenticated", null, null, `select public.start_demo_run($1,'{"text":"x"}')`, [listingId]);
  check("A42-D14c an authenticated role with no user id: 28000 not_authenticated", codeIs(r.err, "28000", "not_authenticated"), r.err?.message);
});

// per-user daily limit
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await startOk(client, U.buyer, listingId));
  let r = await startDemo(client, U.buyer, listingId);
  check("A42-D15 the 4th demo run in 24 h is refused: CM033 demo_daily_limit", codeIs(r.err, "CM033", "demo_daily_limit"), r.err?.message);
  r = await startDemo(client, U.b2, listingId);
  check("A42-D16 a different user is unaffected", !r.err, r.err?.message);
  await q(`update public.runs set created_at = now() - interval '25 hours' where id = $1`, [ids[0]]);
  r = await startDemo(client, U.buyer, listingId);
  check("A42-D17 runs older than 24 h stop counting (rolling window)", !r.err, r.err?.message);
  await q(`update private.demo_settings set value = 1 where key='per_user_daily_runs'`);
  r = await startDemo(client, U.buyer, listingId);
  check("A42-D18 the per-user limit is a setting, not a constant (limit 1 -> refused)", codeIs(r.err, "CM033"), r.err?.message);
});

// platform budget (kill switch): reservations, real cost, day boundary
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  await q(`update private.demo_settings set value = 7 where key='global_daily_budget_inr'`);
  const r1 = await startOk(client, U.buyer, listingId);
  await startOk(client, U.b2, listingId);
  let r = await startDemo(client, U.b3, listingId);
  check("A42-B01 in-flight runs RESERVE their full cap: 2 x Rs3 reserved, a 3rd (Rs9 > Rs7) is refused CM034 demo_budget_exhausted", codeIs(r.err, "CM034", "demo_budget_exhausted"), r.err?.message);
  await q(`update public.runs set status='succeeded', cost=0.5 where id=$1`, [r1]);
  r = await startDemo(client, U.b3, listingId);
  check("A42-B02 a finished run releases its reservation and counts only its REAL cost (0.5): now Rs3.5 + Rs3 <= Rs7 -> allowed", !r.err, r.err?.message);
  r = await startDemo(client, U.b4, listingId);
  check("A42-B03 ...and the next one (Rs6.5 + Rs3 > Rs7) is refused again", codeIs(r.err, "CM034"), r.err?.message);
});
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client);
  await q(`update private.demo_settings set value = 3 where key='global_daily_budget_inr'`);
  const r1 = await startOk(client, U.buyer, listingId);
  let r = await startDemo(client, U.b2, listingId);
  check("A42-B04 budget Rs3: a second concurrent reservation is refused", codeIs(r.err, "CM034"), r.err?.message);
  await q(`update public.runs set created_at = now() - interval '2 days' where id=$1`, [r1]);
  r = await startDemo(client, U.b2, listingId);
  check("A42-B05 a run from a previous IST day does not count against today's budget", !r.err, r.err?.message);
  await q(`update private.demo_settings set value = 0 where key='global_daily_budget_inr'`);
  r = await startDemo(client, U.b3, listingId);
  check("A42-B06 a budget of 0 is a hard stop", codeIs(r.err, "CM034"), r.err?.message);
});
await inTxn(async () => {
  for (const [label, key, v] of [["cap Rs6 (> hard limit Rs5)", "per_run_cost_cap_inr", 6], ["cap 0", "per_run_cost_cap_inr", 0], ["budget 10001", "global_daily_budget_inr", 10001],
    ["budget negative", "global_daily_budget_inr", -1], ["per-user 0", "per_user_daily_runs", 0], ["per-user 1.5", "per_user_daily_runs", 1.5], ["per-user 21", "per_user_daily_runs", 21]]) {
    const e = await expectErr(client, `update private.demo_settings set value=$2 where key=$1`, [key, v]);
    check(`A42-B07 settings CHECK refuses ${label} (23514)`, e?.code === "23514", e?.code);
  }
  const e = await expectErr(client, `insert into private.demo_settings (key, value) values ('mystery', 1)`);
  check("A42-B07b unknown setting keys are refused (23514)", e?.code === "23514", e?.code);
  await setFlags(client);
  const listingId = await mkListing(client);
  await q(`update private.demo_settings set value = 2 where key='per_run_cost_cap_inr'`);
  const runId = await startOk(client, U.buyer, listingId);
  check("A42-B08 lowering the per-run cap lowers the FROZEN limit of new runs", (await runRow(client, runId)).execution_config.limits.maxCostInr === 2);
  const e2 = await expectErr(client, `insert into public.runs (user_id, product_id, product_version, is_demo, execution_config) values ($1,$2,1,true,$3::jsonb)`,
    [U.b2, listingId, JSON.stringify({ ...(await runRow(client, runId)).execution_config, limits: { maxSteps: 1, maxCostInr: 3, timeoutSeconds: 20 } })]);
  check("A42-B09 and the L2 trigger refuses a demo run frozen above the current cap (CM001)", e2?.code === "CM001", e2?.message);
  await q(`delete from private.demo_settings where key='per_user_daily_runs'`);
  const r = await startDemo(client, U.b3, listingId);
  check("A42-B10 a MISSING setting fails closed (CM036), never to 'unlimited'", codeIs(r.err, "CM036"), r.err?.message);
});

// =================================================================== WORKER CONTEXT
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client, { demo: DEMO([step({ maxOutputTokens: 200, timeoutSeconds: 15 }), step({ id: "s2", model: SONNET, system: "Second prompt", maxOutputTokens: 100 })]) });
  const runId = await startOk(client, U.buyer, listingId, { text: "my question" });
  const c0 = await claim(client, runId);
  const x0 = await ctxOf(client, runId, c0);
  check("A42-X01 demo step 0 context: model, system (from the snapshot), input, no previous output, caps, price, full budget",
    x0.outcome === "ok" && x0.mode === "demo" && x0.model === HAIKU && x0.system === SYS && x0.input_text === "my question" && x0.previous_output_text === null
      && x0.max_output_tokens === 200 && x0.timeout_seconds === 15 && Number(x0.budget_remaining_inr) === 3
      && Number(x0.price.input_inr_per_mtok) === 90.3 && Number(x0.price.output_inr_per_mtok) === 451.5, x0);
  check("A42-X01b the context payload has exactly the documented keys",
    Object.keys(x0).sort().join() === "budget_remaining_inr,input_text,max_output_tokens,mode,model,outcome,previous_output_text,price,system,timeout_seconds", Object.keys(x0));

  await q(`update public.listing_demos set demo_config = $2::jsonb where listing_id=$1`, [listingId, JSON.stringify(DEMO([step({ system: "EDITED AFTER START" })]))]);
  check("A42-X02 editing the seller's demo mid-run does NOT change an in-flight run (frozen snapshot)", (await ctxOf(client, runId, c0)).system === SYS);

  const cp0 = await checkpoint(client, runId, c0, { mode: "demo", text: "first answer" }, 0.4);
  check("A42-X03 step 0 checkpoints with its real cost; run continues", cp0.outcome === "checkpointed", cp0);
  const c1 = await claim(client, runId);
  const x1 = await ctxOf(client, runId, c1);
  check("A42-X04 step 1 context: Sonnet, its own prompt, the PREVIOUS step's output text, budget reduced by what step 0 cost",
    x1.model === SONNET && x1.system === "Second prompt" && x1.previous_output_text === "first answer" && Number(x1.budget_remaining_inr) === 2.6
      && Number(x1.price.input_inr_per_mtok) === 270.9, x1);
});
await inTxn(async () => {
  await setFlags(client);
  const runId = await startOk(client, U.buyer, await mkListing(client));
  const c = await claim(client, runId);
  const sq = (stepId, retry, run = runId) => val(`select private.get_step_context($1,$2,$3) as v`, [run, stepId, retry]);
  check("A42-X05 wrong retry_count: rejected fencing_mismatch", (await sq(c.step_id, 9)).reason === "fencing_mismatch");
  check("A42-X06 unknown run / unknown step", (await sq(c.step_id, 0, "00000000-0000-4000-8000-00000000dead")).reason === "run_not_found"
    && (await sq("00000000-0000-4000-8000-00000000dead", 0)).reason === "step_not_found");
  const other = await startOk(client, U.b2, await mkListing(client));
  const oc = await claim(client, other);
  check("A42-X07 a step id from a DIFFERENT run is rejected (step_not_found)", (await sq(oc.step_id, 0)).reason === "step_not_found");
  await q(`update private.model_pricing set is_active=false where model=$1`, [HAIKU]);
  check("A42-X08 a model deactivated after the run started: rejected model_not_allowed", (await sq(c.step_id, 0)).reason === "model_not_allowed");
  await q(`update private.model_pricing set is_active=true where model=$1`, [HAIKU]);
  await setFlags(client, { demo: false });
  check("A42-X09 KILL SWITCH: phase4_demo OFF makes an in-flight demo step fail closed (demo_disabled)", (await sq(c.step_id, 0)).reason === "demo_disabled");
  await setFlags(client);
  await q(`delete from private.demo_run_snapshots where run_id=$1`, [runId]);
  check("A42-X10 a missing snapshot fails closed (snapshot_missing)", (await sq(c.step_id, 0)).reason === "snapshot_missing");
  await q(`update public.run_steps set status='pending' where id=$1`, [c.step_id]);
  check("A42-X11 a step that is not running: rejected step_not_running", (await sq(c.step_id, 0)).reason === "step_not_running");
});
await inTxn(async () => {
  await setFlags(client);
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration) values ('plain','n','n',0,'x',$1,'live','workflow',$2::jsonb) returning id`,
    [(await mkUsers(client), U.seller), JSON.stringify({ steps: [{ retryLimit: 1, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } })]);
  const rid = (await q(`select private.create_run($1,$2,'{}'::jsonb,true) as v`, [U.seller, l.id])).rows[0].v;
  const c = await claim(client, rid);
  const x = await ctxOf(client, rid, c);
  check("A42-X12 a NON-demo run gets mode 'stub' (so it can never reach the provider)", x.outcome === "ok" && x.mode === "stub" && Object.keys(x).length === 2, x);
  const r = await as(client, "service_role", null, null, `select public.worker_get_step_context($1,$2,$3) as v`, [rid, c.step_id, c.retry_count]);
  check("A42-X13 through the real entry point as service_role it works", !r.err && r.rows[0].v.mode === "stub", r.err?.message);
  const d = await as(client, "authenticated", U.seller, null, `select public.worker_get_step_context($1,$2,$3)`, [rid, c.step_id, c.retry_count]);
  check("A42-X14 as authenticated it is denied (42501)", d.err?.code === "42501", d.err?.code);
});

// =================================================================== END TO END
await inTxn(async () => {
  await setFlags(client);
  const listingId = await mkListing(client, { demo: DEMO([step(), step({ id: "s2", model: SONNET, system: "Polish the previous output." })]) });
  const mark0 = await maxQ();
  const runId = await startOk(client, U.buyer, listingId, { text: "write a tagline" });
  const c0 = await claim(client, runId);
  const cp0 = await checkpoint(client, runId, c0, { mode: "demo", text: "draft tagline" }, 0.0412);
  const c1 = await claim(client, runId);
  const cp1 = await checkpoint(client, runId, c1, { mode: "demo", text: "polished tagline" }, 0.3);
  const run = await runRow(client, runId);
  check("A42-F01 two-step demo: start -> claim -> checkpoint x2 -> succeeded; cost = exact sum of the reported deltas",
    c0.outcome === "claimed" && cp0.outcome === "checkpointed" && c1.step_index === 1 && cp1.outcome === "succeeded"
      && run.status === "succeeded" && Number(run.cost) === 0.3412, { run, cp0, cp1 });
  check("A42-F01b dispatches: initial insert (1) + step-1 insert (1) = 2, nothing else", (await since(mark0)) === 2);
});
await inTxn(async () => {
  await setFlags(client);
  const runId = await startOk(client, U.buyer, await mkListing(client));
  const c = await claim(client, runId);
  const cp = await checkpoint(client, runId, c, { mode: "demo", text: "x" }, 3.5);
  const run = await runRow(client, runId);
  check("A42-F02 BACKSTOP: a reported cost above the frozen Rs3 cap fails the run closed (cost_limit_exceeded) and records what was spent",
    cp.outcome === "failed" && cp.reason === "cost_limit_exceeded" && run.status === "failed" && Number(run.cost) === 3.5, { cp, run });
});
await inTxn(async () => {
  await setFlags(client);
  const runId = await startOk(client, U.buyer, await mkListing(client));
  const c = await claim(client, runId);
  const r = (await q(`select private.retry_or_fail_step($1,$2,$3,'provider_http_529') as v`, [runId, c.step_id, c.retry_count])).rows[0].v;
  const run = await runRow(client, runId);
  check("A42-F03 demo steps never retry (retryLimit 0): a provider failure FAILS the run immediately (no double spend)",
    r.outcome === "failed" && run.status === "failed", { r, run });
});
await inTxn(async () => {
  await setFlags(client);
  const runId = await startOk(client, U.buyer, await mkListing(client));
  const own = await as(client, "authenticated", U.buyer, null, `select public.cancel_my_run($1) as v`, [runId]);
  const other = await as(client, "authenticated", U.other, null, `select public.cancel_my_run($1) as v`, [runId]);
  check("A42-F04 the demo user can cancel their own demo run; others cannot",
    !own.err && own.rows[0].v.outcome === "cancelled" && other.rows[0]?.v.outcome === "rejected", { own: own.rows, other: other.rows });
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
