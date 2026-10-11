// A41 -- Milestone 4.1 (approval-resume engine) database tests.
//
// Same conventions as tests/phase3 + m40: plain script, hand-rolled check(),
// DATABASE_URL = owner-level connection, every behavioural test runs inside a
// transaction that is ROLLED BACK (pg_net queues requests transactionally, so
// nothing is ever sent to the worker).
//
//   PHASE4_DESTRUCTIVE_TESTS=1  also runs the two-connection concurrency tests
//   (A41-K*). They COMMIT fixtures and clean them up; scratch DB / quiet window only.
//
// Requires migrations 20260930100200 + 20260930100300 and a configured dispatch
// Vault (otherwise the dispatch-count checks fail by design).
//
// Run:  DATABASE_URL=... node tests/phase4/m41-approvals.test.mjs

import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const destructive = process.env.PHASE4_DESTRUCTIVE_TESTS === "1";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const q = (sql, params) => client.query(sql, params);
const val = async (sql, params) => (await q(sql, params)).rows[0]?.v;
const keys = (o) => Object.keys(o ?? {}).sort().join(",");
const U = {
  owner:  "00000000-0000-0000-0000-0000000fff51", // creates + decides runs
  other:  "00000000-0000-0000-0000-0000000fff52", // unrelated user
  seller: "00000000-0000-0000-0000-0000000fff53", // owns the listing (not the run creator)
};
const TOOL = "00000000-0000-4000-8000-0000000000aa";

// ------------------------------------------------------------------ builders
const step = (permission, extra = {}) => ({
  id: "s", kind: "tool_call", retryLimit: 1, timeoutSeconds: 30,
  ...(permission === undefined ? {} : { tool: { toolId: TOOL, permission } }), ...extra,
});
const plain = () => ({ id: "s", kind: "transform", retryLimit: 1, timeoutSeconds: 30 });
const cfgOf = (steps, permissions) => ({
  steps, limits: { maxSteps: steps.length, maxCostInr: 10, timeoutSeconds: 60 },
  ...(permissions === undefined ? {} : { permissions }),
});
const GATED = () => cfgOf([step("SEND")], [{ permission: "SEND", requiresApproval: true }]);

async function mkUsers(cli) {
  for (const id of Object.values(U)) {
    await cli.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [id, `a41-${id.slice(-2)}@example.invalid`]);
  }
}
async function mkListing(cli, configuration) {
  const { rows: [l] } = await cli.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('A41 fixture','n/a','n/a',0,'fixture',$1,'pending_review','workflow',$2::jsonb) returning id`,
    [U.seller, JSON.stringify(configuration)]);
  return l.id;
}
// run + first step, direct inserts (the L2 trigger still validates the config)
async function mkRun(cli, { cfg = GATED(), runStatus = "queued", stepStatus = "pending", userId = U.owner } = {}) {
  await mkUsers(cli);
  const listingId = await mkListing(cli, cfg);
  const { rows: [r] } = await cli.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status, started_at)
     values ($1,$2,1,$3::jsonb,$4, case when $4 = 'queued' then null else now() end) returning id`,
    [userId, listingId, JSON.stringify(cfg), runStatus]);
  const { rows: [s] } = await cli.query(
    `insert into public.run_steps (run_id, step_index, status, started_at)
     values ($1,0,$2, case when $2 = 'running' then now() end) returning id`, [r.id, stepStatus]);
  return { runId: r.id, stepId: s.id, listingId };
}
async function setFlags(cli, { exec, appr }) {
  if (exec !== undefined) await cli.query(`update private.feature_flags set enabled=$1 where name='phase3_execution'`, [exec]);
  if (appr !== undefined) await cli.query(`update private.feature_flags set enabled=$1 where name='phase4_approvals'`, [appr]);
}
const claim = async (cli, runId) => (await cli.query(`select private.claim_next_step($1) as v`, [runId])).rows[0].v;
const checkpoint = async (cli, runId, c, cost = 0) =>
  (await cli.query(`select private.checkpoint_step($1,$2,$3,$4::jsonb,$5) as v`, [runId, c.step_id, c.retry_count, JSON.stringify({ ok: true }), cost])).rows[0].v;
async function st(cli, runId) {
  const run = (await cli.query(`select status, error, started_at, completed_at, cost from public.runs where id=$1`, [runId])).rows[0];
  const steps = (await cli.query(`select id, step_index, status, retry_count, error, started_at from public.run_steps where run_id=$1 order by step_index`, [runId])).rows;
  const approvals = (await cli.query(
    `select id, step_id, status, requested_permission, decided_by, decided_at, expires_at, created_at from public.approvals where run_id=$1 order by created_at, id`, [runId])).rows;
  return { run, steps, approvals };
}
async function asUser(cli, uid, fn) {
  await cli.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
    [JSON.stringify({ sub: uid, role: "authenticated" }), uid]);
  try { return await fn(); }
  finally { await cli.query(`select set_config('request.jwt.claims','',true), set_config('request.jwt.claim.sub','',true)`); }
}
const decide = (cli, uid, apprId, d) => asUser(cli, uid, async () => (await cli.query(`select public.decide_my_approval($1,$2) as v`, [apprId, d])).rows[0].v);
const cancelMine = (cli, uid, runId) => asUser(cli, uid, async () => (await cli.query(`select public.cancel_my_run($1) as v`, [runId])).rows[0].v);
async function expectErr(cli, sql, params) {
  await cli.query("SAVEPOINT e");
  try { await cli.query(sql, params); await cli.query("RELEASE SAVEPOINT e"); return null; }
  catch (e) { await cli.query("ROLLBACK TO SAVEPOINT e"); return e; }
}
const maxQ = async () => Number(await val(`select coalesce(max(id),0)::bigint as v from net.http_request_queue`));
const since = async (m) => Number(await val(`select count(*)::int as v from net.http_request_queue where id > $1`, [m]));
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }

// =================================================================== SCHEMA
{
  const cols = (await q(`select column_name, data_type from information_schema.columns
                          where table_schema='public' and table_name='approvals' and column_name in ('step_id','expires_at')`)).rows;
  const byName = Object.fromEntries(cols.map(c => [c.column_name, c.data_type]));
  const fk = (await q(`select confdeltype, confrelid::regclass::text as ref from pg_constraint
                        where conrelid='public.approvals'::regclass and contype='f' and conkey = (select array_agg(attnum) from pg_attribute where attrelid='public.approvals'::regclass and attname='step_id')`)).rows[0];
  check("A41-SC01 approvals.step_id (uuid) + expires_at (timestamptz); FK -> run_steps ON DELETE CASCADE",
    byName.step_id === "uuid" && byName.expires_at === "timestamp with time zone" && fk?.confdeltype === "c" && fk?.ref === "run_steps", { byName, fk });

  const idx = (await q(`select i.indisunique, pg_get_expr(i.indpred, i.indrelid) as pred
                          from pg_index i join pg_class c on c.oid=i.indexrelid
                         where c.relname='approvals_one_per_step_idx'`)).rows[0];
  check("A41-SC02 unique partial index on (step_id) WHERE step_id IS NOT NULL", idx?.indisunique === true && /step_id IS NOT NULL/i.test(idx?.pred ?? ""), idx);

  check("A41-SC06a flag phase4_approvals row exists and is OFF",
    (await q(`select enabled from private.feature_flags where name='phase4_approvals'`)).rows[0]?.enabled === false);
  check("A41-SC06b private.is_approvals_enabled() is false with the live flag row", (await val(`select private.is_approvals_enabled() as v`)) === false);
}
await inTxn(async () => {
  await q(`delete from private.feature_flags where name='phase4_approvals'`);
  check("A41-SC06c is_approvals_enabled() fails closed when the flag row is missing", (await val(`select private.is_approvals_enabled() as v`)) === false);
});
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client);
  let e = await expectErr(client, `update public.run_steps set status='waiting_for_approval' where id=$1`, [stepId]);
  check("A41-SC03a run_steps.status accepts 'waiting_for_approval'", e === null, e?.message);
  e = await expectErr(client, `update public.run_steps set status='bogus' where id=$1`, [stepId]);
  check("A41-SC03b run_steps.status still rejects unknown values (23514)", e?.code === "23514", e?.code);

  for (const s of ["expired", "cancelled"]) {
    const sid = (await q(`insert into public.run_steps (run_id, step_index, status) values ($1,$2,'skipped') returning id`, [runId, s === "expired" ? 7 : 8])).rows[0].id;
    e = await expectErr(client, `insert into public.approvals (run_id, step_id, requested_permission, status, expires_at) values ($1,$2,'SEND',$3, now())`, [runId, sid, s]);
    check(`A41-SC04 approvals.status accepts '${s}'`, e === null, e?.message);
  }
  const sid = (await q(`insert into public.run_steps (run_id, step_index, status) values ($1,9,'skipped') returning id`, [runId])).rows[0].id;
  e = await expectErr(client, `insert into public.approvals (run_id, step_id, requested_permission, status, expires_at) values ($1,$2,'SEND','bogus', now())`, [runId, sid]);
  check("A41-SC04c approvals.status still rejects unknown values (23514)", e?.code === "23514", e?.code);

  e = await expectErr(client, `insert into public.approvals (run_id, step_id, requested_permission) values ($1,$2,'SEND')`, [runId, stepId]);
  check("A41-SC05a step_id without expires_at is rejected (23514)", e?.code === "23514", e?.code);
  e = await expectErr(client, `insert into public.approvals (run_id, requested_permission, expires_at) values ($1,'SEND', now())`, [runId]);
  check("A41-SC05b expires_at without step_id is rejected (23514)", e?.code === "23514", e?.code);
  e = await expectErr(client, `insert into public.approvals (run_id, requested_permission) values ($1,'SEND')`, [runId]);
  check("A41-SC05c legacy shape (both NULL) is still allowed", e === null, e?.message);

  await q(`insert into public.approvals (run_id, step_id, requested_permission, expires_at) values ($1,$2,'SEND', now() + interval '1 hour')`, [runId, stepId]);
  e = await expectErr(client, `insert into public.approvals (run_id, step_id, requested_permission, expires_at) values ($1,$2,'SEND', now() + interval '1 hour')`, [runId, stepId]);
  check("A41-SC08 a second approval for the same step is rejected (23505, one-shot)", e?.code === "23505", e?.code);

  await q(`delete from public.run_steps where id=$1`, [stepId]);
  check("A41-SC07 deleting a step cascades to its approval",
    Number(await val(`select count(*)::int as v from public.approvals where step_id=$1`, [stepId])) === 0);
});

// =================================================================== PRIVILEGES
{
  const NEW = ["private.is_approvals_enabled()", "private.approval_ttl()", "private.step_approval_permission(jsonb,integer)",
    "private.request_approval(uuid,uuid,integer,text)", "private.resume_after_approval(uuid,uuid)", "private.expire_pending_approvals(integer)"];
  const REPLACED = ["private.claim_next_step(uuid)", "private.decide_approval(uuid,text,uuid)", "private.fail_run_closed(uuid,text)", "private.cancel_run(uuid)"];
  let bad = [];
  for (const f of [...NEW, ...REPLACED]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      if ((await val(`select has_function_privilege($1, $2::regprocedure, 'execute') as v`, [role, f])) !== false) bad.push(`${role}:${f}`);
    }
    if ((await val(`select has_function_privilege('public', $1::regprocedure, 'execute') as v`, [f])) !== false) bad.push(`PUBLIC:${f}`);
  }
  check("A41-PR01 every new/replaced private function is owner-only (no anon/authenticated/service_role/PUBLIC)", bad.length === 0, bad);

  const props = (await q(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                           where n.nspname='private' and p.proname in ('is_approvals_enabled','step_approval_permission','request_approval','resume_after_approval','expire_pending_approvals','claim_next_step','decide_approval','fail_run_closed','cancel_run')`)).rows;
  check("A41-PR02 those 9 functions are SECURITY DEFINER with search_path=''",
    props.length === 9 && props.every(p => p.prosecdef && Array.isArray(p.proconfig) && p.proconfig.includes('search_path=""')), props.map(p => p.proname));

  const g = async (role, f) => val(`select has_function_privilege($1, $2::regprocedure, 'execute') as v`, [role, f]);
  check("A41-PR03 public wrapper grants unchanged (decide_my_approval/cancel_my_run: authenticated only; worker_claim_next_step: service_role only)",
    (await g("authenticated", "public.decide_my_approval(uuid,text)")) && !(await g("anon", "public.decide_my_approval(uuid,text)")) && !(await g("service_role", "public.decide_my_approval(uuid,text)"))
    && (await g("authenticated", "public.cancel_my_run(uuid)")) && !(await g("anon", "public.cancel_my_run(uuid)"))
    && (await g("service_role", "public.worker_claim_next_step(uuid)")) && !(await g("authenticated", "public.worker_claim_next_step(uuid)")) && !(await g("anon", "public.worker_claim_next_step(uuid)")));
}

// =================================================================== GATE DERIVATION (pure)
{
  const R = (perm) => ({ permission: perm, requiresApproval: false });
  const T = (perm) => ({ permission: perm, requiresApproval: true });
  const cases = [
    ["no tool",                                   cfgOf([plain()]),                                   null],
    ["tool without permission",                   cfgOf([step(undefined, { tool: { toolId: TOOL } })]), null],
    ["permission is JSON null",                   cfgOf([step(null)]),                                null],
    ["SEND, no grants",                           cfgOf([step("SEND")]),                              "SEND"],
    ["PUBLISH",                                   cfgOf([step("PUBLISH")]),                           "PUBLISH"],
    ["DELETE",                                    cfgOf([step("DELETE")]),                            "DELETE"],
    ["FINANCIAL_ACTION",                          cfgOf([step("FINANCIAL_ACTION")]),                  "FINANCIAL_ACTION"],
    ["SEND 'waived' by grant -> high-risk can't be waived", cfgOf([step("SEND")], [R("SEND")]),       "SEND"],
    ["READ, undeclared -> gated (fail closed)",   cfgOf([step("READ")]),                              "READ"],
    ["READ, grant requiresApproval=true",         cfgOf([step("READ")], [T("READ")]),                 "READ"],
    ["READ, grant requiresApproval=false -> waived", cfgOf([step("READ")], [R("READ")]),              null],
    ["WRITE, grant requiresApproval=false -> waived", cfgOf([step("WRITE")], [R("WRITE")]),           null],
    ["READ, grant lacks requiresApproval -> gated", cfgOf([step("READ")], [{ permission: "READ" }]),  "READ"],
    ["READ, duplicate grants (false + true) -> gated", cfgOf([step("READ")], [R("READ"), T("READ")]), "READ"],
    ["READ, waiver is for a different permission", cfgOf([step("READ")], [R("WRITE")]),               "READ"],
    ["READ, requiresApproval is the string 'false' -> gated", cfgOf([step("READ")], [{ permission: "READ", requiresApproval: "false" }]), "READ"],
    ["permissions is not an array -> gated",      cfgOf([step("READ")], "nope"),                      "READ"],
  ];
  for (const [label, cfg, want] of cases) {
    const got = await val(`select private.step_approval_permission($1::jsonb, 0) as v`, [JSON.stringify(cfg)]);
    check(`A41-G ${label}: ${want ?? "no gate"}`, got === want, { got, want });
  }
  const errCases = [
    ["permission 'ROOT'",        cfgOf([step("ROOT")]),                         0, "config_invalid_for_execution:steps[0].tool.permission"],
    ["permission lowercase",     cfgOf([step("send")]),                         0, "config_invalid_for_execution:steps[0].tool.permission"],
    ["permission is a number",   cfgOf([step(5)]),                              0, "config_invalid_for_execution:steps[0].tool.permission"],
    ["tool is a string",         cfgOf([step(undefined, { tool: "x" })]),       0, "config_invalid_for_execution:steps[0].tool"],
    ["step is not an object",    { steps: [5], limits: {} },                    0, "config_invalid_for_execution:steps[0]"],
    ["step index out of range",  cfgOf([step("SEND")]),                         3, "config_invalid_for_execution:steps[3]"],
  ];
  await inTxn(async () => {
    for (const [label, cfg, idx, msg] of errCases) {
      const e = await expectErr(client, `select private.step_approval_permission($1::jsonb, $2)`, [JSON.stringify(cfg), idx]);
      check(`A41-G ${label} -> CM002 ${msg}`, e?.code === "CM002" && e?.message === msg, { code: e?.code, message: e?.message });
    }
  });
}

// =================================================================== CLAIM GATE
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId, stepId } = await mkRun(client, { cfg: cfgOf([plain()]) });
  const c = await claim(client, runId);
  const s = await st(client, runId);
  check("A41-C01 ungated step: claimed, same payload keys as before, no approval, step running",
    c.outcome === "claimed" && keys(c) === "outcome,retry_count,step_id,step_index" && c.step_id === stepId
      && s.run.status === "running" && s.steps[0].status === "running" && s.approvals.length === 0, { c, s });
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: false });
  const { runId } = await mkRun(client, { cfg: cfgOf([plain()]) });
  check("A41-C02 ungated step is unaffected by the approvals flag being OFF", (await claim(client, runId)).outcome === "claimed");
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: false });
  const { runId } = await mkRun(client);
  const mark = await maxQ();
  const c = await claim(client, runId);
  const s = await st(client, runId);
  check("A41-C03 gated step + phase4_approvals OFF: run FAILED closed 'approvals_disabled', step skipped, no approval, nothing dispatched",
    c.outcome === "failed" && c.reason === "approvals_disabled" && s.run.status === "failed" && s.run.error === "approvals_disabled"
      && s.steps[0].status === "skipped" && s.approvals.length === 0 && (await since(mark)) === 0, { c, s });
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId, stepId } = await mkRun(client);
  const mark = await maxQ();
  const c = await claim(client, runId);
  const s = await st(client, runId);
  const a = s.approvals[0];
  check("A41-C04a gated step + both flags ON: outcome 'waiting_for_approval' with the documented payload",
    c.outcome === "waiting_for_approval" && keys(c) === "approval_id,expires_at,outcome,permission,step_id,step_index"
      && c.step_id === stepId && c.step_index === 0 && c.permission === "SEND" && c.approval_id === a?.id, c);
  check("A41-C04b step is waiting_for_approval, claim released (started_at NULL), retry_count untouched",
    s.steps[0].status === "waiting_for_approval" && s.steps[0].started_at === null && s.steps[0].retry_count === 0, s.steps);
  check("A41-C04c run is waiting_for_approval and has a started_at (it did start)", s.run.status === "waiting_for_approval" && s.run.started_at !== null, s.run);
  check("A41-C04d exactly one pending approval: right run/step/permission, no decider",
    s.approvals.length === 1 && a.status === "pending" && a.step_id === stepId && a.requested_permission === "SEND" && a.decided_by === null && a.decided_at === null, s.approvals);
  check("A41-C05 expires_at is exactly created_at + 24 hours (the TTL decision)",
    (await val(`select (a.expires_at - a.created_at) = interval '24 hours' as v from public.approvals a where a.id=$1`, [a.id])) === true);
  check("A41-C04e the park itself dispatches nothing (no worker should wake)", (await since(mark)) === 0);

  const again = await claim(client, runId);
  const s2 = await st(client, runId);
  check("A41-C06 claiming again: rejected run_not_claimable, still exactly one approval",
    again.outcome === "rejected" && again.reason === "run_not_claimable" && s2.approvals.length === 1, again);
  const sw = await val(`select private.sweep_stale_runs() as v`);
  const s3 = await st(client, runId);
  check("A41-C10 sweep_stale_runs never touches a run waiting for approval",
    s3.run.status === "waiting_for_approval" && s3.steps[0].status === "waiting_for_approval" && sw.errors === 0, { sw, s3 });
});
await inTxn(async () => {
  await setFlags(client, { exec: false, appr: true });
  const { runId } = await mkRun(client);
  const c = await claim(client, runId);
  const s = await st(client, runId);
  check("A41-C07 gated step + phase3_execution OFF: rejected execution_disabled, no approval, step still pending",
    c.outcome === "rejected" && c.reason === "execution_disabled" && s.approvals.length === 0 && s.steps[0].status === "pending", { c, s });
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId } = await mkRun(client, { cfg: cfgOf([step("ROOT")]) });
  const c = await claim(client, runId);
  const s = await st(client, runId);
  check("A41-C08 malformed permission in the frozen config: run FAILED closed with the exact reason, no approval",
    c.outcome === "failed" && c.reason === "config_invalid_for_execution:steps[0].tool.permission" && s.run.status === "failed" && s.approvals.length === 0, { c, s });
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: false });
  const { runId } = await mkRun(client, { cfg: cfgOf([step("READ")], [{ permission: "READ", requiresApproval: false }]) });
  const c = await claim(client, runId);
  check("A41-C09 READ explicitly waived in the config: claimed with no approval (even with approvals OFF)", c.outcome === "claimed", c);
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId } = await mkRun(client);
  await q(`set local role service_role`);
  let c;
  try { c = (await q(`select public.worker_claim_next_step($1) as v`, [runId])).rows[0].v; } finally { await q(`reset role`); }
  check("A41-C11 through the real worker entry point (public.worker_claim_next_step as service_role): same waiting payload",
    c.outcome === "waiting_for_approval" && keys(c) === "approval_id,expires_at,outcome,permission,step_id,step_index", c);
});

// =================================================================== request_approval direct
async function runningGated(cli) {
  await setFlags(cli, { exec: true, appr: true });
  const r = await mkRun(cli, { runStatus: "running", stepStatus: "running" });
  return r;
}
const reqA = async (cli, ...a) => (await cli.query(`select private.request_approval($1,$2,$3,$4) as v`, a)).rows[0].v;
await inTxn(async () => {
  const { runId, stepId } = await runningGated(client);
  await setFlags(client, { appr: false });
  const r = await reqA(client, runId, stepId, 0, "SEND");
  check("A41-R01 flag OFF: rejected approvals_disabled, nothing changed", r.reason === "approvals_disabled" && (await st(client, runId)).approvals.length === 0, r);
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId, stepId } = await mkRun(client, { runStatus: "queued", stepStatus: "running" });
  const r = await reqA(client, runId, stepId, 0, "SEND");
  check("A41-R02 run not 'running': rejected run_not_running", r.reason === "run_not_running", r);
});
await inTxn(async () => {
  const { runId, stepId } = await runningGated(client);
  for (const bad of ["ROOT", "send", null]) {
    const r = await reqA(client, runId, stepId, 0, bad);
    check(`A41-R03 invalid permission ${JSON.stringify(bad)}: rejected invalid_permission`, r.reason === "invalid_permission", r);
  }
});
await inTxn(async () => {
  const { runId } = await runningGated(client);
  const other = await mkRun(client, { runStatus: "running", stepStatus: "running" });
  const r = await reqA(client, runId, other.stepId, 0, "SEND");
  check("A41-R04 a step that belongs to a different run: rejected step_not_in_run", r.reason === "step_not_in_run", r);
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId, stepId } = await mkRun(client, { runStatus: "running", stepStatus: "pending" });
  const r = await reqA(client, runId, stepId, 0, "SEND");
  check("A41-R05 step not running (pending): rejected step_not_running", r.reason === "step_not_running", r);
});
await inTxn(async () => {
  const { runId, stepId } = await runningGated(client);
  const r = await reqA(client, runId, stepId, 7, "SEND");
  const s = await st(client, runId);
  check("A41-R06 wrong retry_count (fence): rejected fencing_mismatch, state unchanged",
    r.reason === "fencing_mismatch" && s.approvals.length === 0 && s.steps[0].status === "running" && s.run.status === "running", r);
});
await inTxn(async () => {
  const { runId, stepId } = await runningGated(client);
  const r = await reqA(client, runId, stepId, 0, "FINANCIAL_ACTION");
  const s = await st(client, runId);
  check("A41-R07 happy path: waiting payload; step + run waiting_for_approval; claim released; permission recorded",
    r.outcome === "waiting_for_approval" && s.run.status === "waiting_for_approval" && s.steps[0].status === "waiting_for_approval"
      && s.steps[0].started_at === null && s.approvals[0].requested_permission === "FINANCIAL_ACTION", { r, s });
});
await inTxn(async () => {
  const { runId, stepId } = await runningGated(client);
  await reqA(client, runId, stepId, 0, "SEND");
  // put the step back to 'running' to prove the one-approval-per-step rule, not the status check, is what rejects
  await q(`update public.run_steps set status='running', started_at=now() where id=$1`, [stepId]);
  await q(`update public.runs set status='running' where id=$1`, [runId]);
  const r = await reqA(client, runId, stepId, 0, "SEND");
  check("A41-R08 second request for the same step: rejected approval_already_exists, still exactly one approval",
    r.reason === "approval_already_exists" && (await st(client, runId)).approvals.length === 1, r);
});

// =================================================================== DECIDE
async function parked(cli, cfg = GATED()) {
  await setFlags(cli, { exec: true, appr: true });
  const r = await mkRun(cli, { cfg });
  const c = await claim(cli, r.runId);
  if (c.outcome !== "waiting_for_approval") throw new Error("fixture did not park: " + JSON.stringify(c));
  return { ...r, approvalId: c.approval_id };
}
await inTxn(async () => {
  const { runId, stepId, approvalId } = await parked(client);
  const mark = await maxQ();
  const d = await decide(client, U.owner, approvalId, "approved");
  const s = await st(client, runId);
  const a = s.approvals[0];
  check("A41-D01a owner approves via public.decide_my_approval: decided/approved/running",
    d.outcome === "decided" && d.decision === "approved" && d.run_status === "running", d);
  check("A41-D01b approval row: approved, decided_by = the owner, decided_at set",
    a.status === "approved" && a.decided_by === U.owner && a.decided_at !== null, a);
  check("A41-D01c step back to pending (retry_count unchanged, started_at NULL); run running",
    s.steps[0].status === "pending" && s.steps[0].retry_count === 0 && s.steps[0].started_at === null && s.run.status === "running", s);
  check("A41-D01d the resume dispatches the worker exactly once (t2 trigger)", (await since(mark)) === 1);

  const c2 = await claim(client, runId);
  const s2 = await st(client, runId);
  check("A41-D01e the worker's next claim succeeds on the SAME step and does not ask again",
    c2.outcome === "claimed" && c2.step_id === stepId && s2.approvals.length === 1 && s2.steps[0].status === "running", { c2, approvals: s2.approvals.length });
  const cp = await checkpoint(client, runId, c2);
  check("A41-D01f ...and the run then completes", cp.outcome === "succeeded" && (await st(client, runId)).run.status === "succeeded", cp);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  const mark = await maxQ();
  const d = await decide(client, U.owner, approvalId, "rejected");
  const s = await st(client, runId);
  check("A41-D02a rejection: decided/rejected, run FAILED 'approval_rejected', step failed with the same error",
    d.outcome === "decided" && d.decision === "rejected" && s.run.status === "failed" && s.run.error === "approval_rejected"
      && s.steps[0].status === "failed" && s.steps[0].error === "approval_rejected", { d, s });
  check("A41-D02b approval 'rejected' with decider recorded; nothing dispatched",
    s.approvals[0].status === "rejected" && s.approvals[0].decided_by === U.owner && (await since(mark)) === 0, s.approvals);
  const d2 = await decide(client, U.owner, approvalId, "approved");
  check("A41-D02c deciding again afterwards: noop already_decided, run stays failed", d2.outcome === "noop" && d2.reason === "already_decided" && (await st(client, runId)).run.status === "failed", d2);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  const before = await st(client, runId);
  for (const [who, uid] of [["an unrelated user", U.other], ["the product's seller", U.seller]]) {
    const d = await decide(client, uid, approvalId, "approved");
    check(`A41-D03 ${who} cannot decide: rejected not_found (no existence leak)`, d.outcome === "rejected" && d.reason === "not_found", d);
  }
  const after = await st(client, runId);
  check("A41-D03c state completely unchanged by the unauthorised attempts",
    JSON.stringify(after) === JSON.stringify(before), { before: before.run.status, after: after.run.status });
});
await inTxn(async () => {
  const { approvalId } = await parked(client);
  await q(`select set_config('request.jwt.claim.sub', $1, true)`, [U.owner]);
  await q(`set local role anon`);
  const e = await expectErr(client, `select public.decide_my_approval($1, 'approved')`, [approvalId]);
  await q(`reset role`);
  check("A41-D04 the anon role cannot even execute decide_my_approval (42501)", e?.code === "42501", e?.code);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  for (const bad of ["approve", "APPROVED", "", null]) {
    const d = await decide(client, U.owner, approvalId, bad);
    check(`A41-D05 invalid decision ${JSON.stringify(bad)}: rejected invalid_decision`, d.reason === "invalid_decision", d);
  }
  check("A41-D05e still pending afterwards", (await st(client, runId)).approvals[0].status === "pending");
});
await inTxn(async () => {
  const { approvalId } = await parked(client);
  await decide(client, U.owner, approvalId, "approved");
  const mark = await maxQ();
  const d = await decide(client, U.owner, approvalId, "approved");
  check("A41-D06 approving twice: second is noop already_decided and dispatches nothing more", d.outcome === "noop" && d.reason === "already_decided" && (await since(mark)) === 0, d);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  await setFlags(client, { appr: false });
  const d = await decide(client, U.owner, approvalId, "approved");
  const s = await st(client, runId);
  check("A41-D07 approve with phase4_approvals OFF: rejected approvals_disabled, nothing changed",
    d.reason === "approvals_disabled" && s.approvals[0].status === "pending" && s.steps[0].status === "waiting_for_approval" && s.run.status === "waiting_for_approval", d);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  await setFlags(client, { exec: false });
  const d = await decide(client, U.owner, approvalId, "approved");
  const s = await st(client, runId);
  check("A41-D08 approve with phase3_execution OFF: rejected execution_disabled (no stranded pending step), nothing changed",
    d.reason === "execution_disabled" && s.approvals[0].status === "pending" && s.steps[0].status === "waiting_for_approval", d);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  await setFlags(client, { exec: false, appr: false });
  const d = await decide(client, U.owner, approvalId, "rejected");
  const s = await st(client, runId);
  check("A41-D09 REJECT still works with both flags OFF (it only fails the run closed)", d.outcome === "decided" && s.run.status === "failed" && s.run.error === "approval_rejected", d);
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [approvalId]);
  const mark = await maxQ();
  const d = await decide(client, U.owner, approvalId, "approved");
  const s = await st(client, runId);
  check("A41-D11a approving a LAPSED approval: rejected approval_expired; approval 'expired'; run FAILED 'approval_expired'; step failed",
    d.outcome === "rejected" && d.reason === "approval_expired" && s.approvals[0].status === "expired" && s.run.status === "failed"
      && s.run.error === "approval_expired" && s.steps[0].status === "failed" && (await since(mark)) === 0, { d, s });
});
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [approvalId]);
  const d = await decide(client, U.owner, approvalId, "rejected");
  const s = await st(client, runId);
  check("A41-D11b even a REJECT of a lapsed approval is recorded as expiry (consistent audit trail)", d.reason === "approval_expired" && s.approvals[0].status === "expired" && s.run.error === "approval_expired", d);
  const d2 = await decide(client, U.owner, approvalId, "approved");
  check("A41-D11c ...and it stays closed: noop approval_expired", d2.outcome === "noop" && d2.reason === "approval_expired", d2);
});
await inTxn(async () => {
  // the expiry decision uses the DB clock; a not-yet-due approval is NOT treated as expired
  const { runId, approvalId } = await parked(client);
  await q(`update public.approvals set expires_at = now() + interval '1 second' where id=$1`, [approvalId]);
  const d = await decide(client, U.owner, approvalId, "approved");
  check("A41-D11d an approval that has not yet lapsed can still be approved", d.outcome === "decided" && (await st(client, runId)).run.status === "running", d);
});
await inTxn(async () => {
  // retry after approval: the one approval carries over, the step is never re-gated
  const { runId, stepId, approvalId } = await parked(client);
  await decide(client, U.owner, approvalId, "approved");
  const c1 = await claim(client, runId);
  const mark = await maxQ();
  const r = (await q(`select private.retry_or_fail_step($1,$2,$3,'provider_timeout') as v`, [runId, stepId, c1.retry_count])).rows[0].v;
  check("A41-D12a a failed attempt after approval is retried (retried, dispatched once)", r.outcome === "retried" && (await since(mark)) === 1, r);
  const c2 = await claim(client, runId);
  const s = await st(client, runId);
  check("A41-D12b the retry claims at retry_count 1 WITHOUT a new approval (still exactly one, still 'approved')",
    c2.outcome === "claimed" && c2.retry_count === 1 && s.approvals.length === 1 && s.approvals[0].status === "approved", { c2, approvals: s.approvals.length });
});
await inTxn(async () => {
  // a worker that dies after the approved claim is recovered by the existing stale sweep
  const { runId, approvalId } = await parked(client);
  await decide(client, U.owner, approvalId, "approved");
  await claim(client, runId);
  await q(`update public.run_steps set started_at = now() - interval '10 minutes' where run_id=$1`, [runId]);
  const sw = await val(`select private.sweep_stale_runs() as v`);
  const s = await st(client, runId);
  check("A41-D13 stale recovery still works for a step that ran after approval (retried, approval untouched)",
    sw.recovered === 1 && s.steps[0].status === "pending" && s.steps[0].retry_count === 1 && s.approvals.length === 1 && s.approvals[0].status === "approved", { sw, s });
});

// =================================================================== CANCEL
await inTxn(async () => {
  const { runId, approvalId } = await parked(client);
  const r = await cancelMine(client, U.owner, runId);
  const s = await st(client, runId);
  check("A41-X01a cancelling a run that is waiting for approval: cancelled, step skipped 'run_cancelled', approval 'cancelled'",
    r.outcome === "cancelled" && s.run.status === "cancelled" && s.steps[0].status === "skipped" && s.steps[0].error === "run_cancelled"
      && s.approvals[0].status === "cancelled" && s.approvals[0].decided_at !== null && s.approvals[0].decided_by === null, { r, s });
  const d = await decide(client, U.owner, approvalId, "approved");
  check("A41-X01b deciding it afterwards: noop approval_cancelled, nothing resumes", d.outcome === "noop" && d.reason === "approval_cancelled" && (await st(client, runId)).run.status === "cancelled", d);
});
await inTxn(async () => {
  const { runId } = await parked(client);
  const r = await cancelMine(client, U.other, runId);
  check("A41-X02 another user cannot cancel it (not_found); the approval stays pending",
    r.reason === "not_found" && (await st(client, runId)).approvals[0].status === "pending", r);
});
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  const { runId } = await mkRun(client, { cfg: cfgOf([plain()]) });
  await claim(client, runId);
  const r = await cancelMine(client, U.owner, runId);
  const s = await st(client, runId);
  check("A41-X03 cancelling an ordinary running run is unchanged (step skipped, run cancelled)", r.outcome === "cancelled" && s.steps[0].status === "skipped" && s.run.status === "cancelled", { r, s });
  const r2 = await cancelMine(client, U.owner, runId);
  check("A41-X04 cancelling a terminal run is still a noop", r2.outcome === "noop" && r2.reason === "already_terminal", r2);
});

// =================================================================== EXPIRY SWEEP
await inTxn(async () => {
  const due  = await parked(client);
  const keep = await parked(client);
  await q(`update public.approvals set expires_at = now() - interval '5 minutes' where id=$1`, [due.approvalId]);
  const r = await val(`select private.expire_pending_approvals() as v`);
  const sd = await st(client, due.runId), sk = await st(client, keep.runId);
  check("A41-E01a due approval: expired; run FAILED 'approval_expired'; step failed", sd.approvals[0].status === "expired" && sd.approvals[0].decided_at !== null
    && sd.approvals[0].decided_by === null && sd.run.status === "failed" && sd.run.error === "approval_expired" && sd.steps[0].status === "failed", sd);
  check("A41-E01b a not-yet-due approval is left alone", sk.approvals[0].status === "pending" && sk.run.status === "waiting_for_approval", sk);
  check("A41-E01c summary counts it", r.expired >= 1 && r.errors === 0 && ["scanned", "expired", "noop", "errors"].every(k => Number.isInteger(r[k])), r);
  const r2 = await val(`select private.expire_pending_approvals() as v`);
  check("A41-E02 idempotent: a second sweep expires nothing more", r2.expired === 0, r2);
});
await inTxn(async () => {
  await setFlags(client, { exec: false, appr: false });
  const p = await parked(client).catch(() => null);
  // parked() re-enables flags; switch them off AFTER parking to prove expiry is flag-independent
  const x = p ?? await parked(client);
  await setFlags(client, { exec: false, appr: false });
  await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [x.approvalId]);
  const r = await val(`select private.expire_pending_approvals() as v`);
  check("A41-E03 expiry works with both flags OFF (it only fails runs closed)", r.expired >= 1 && (await st(client, x.runId)).run.error === "approval_expired", r);
});
await inTxn(async () => {
  for (let i = 0; i < 3; i++) {
    const p = await parked(client);
    await q(`update public.approvals set expires_at = now() - interval '5 minutes' where id=$1`, [p.approvalId]);
  }
  const r = await val(`select private.expire_pending_approvals(2) as v`);
  check("A41-E04a batch limit honoured: limit 2 expires exactly 2", r.scanned === 2 && r.expired === 2, r);
  const r0 = await val(`select private.expire_pending_approvals(0) as v`), rn = await val(`select private.expire_pending_approvals(null) as v`);
  check("A41-E04b limit 0 / null are clamped, not errors", Number.isInteger(r0.scanned) && Number.isInteger(rn.scanned), { r0, rn });
});
await inTxn(async () => {
  // a pending approval on a run that is NOT waiting is not the sweep's business
  const { runId, approvalId } = await parked(client);
  await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [approvalId]);
  await q(`update public.runs set status='running' where id=$1`, [runId]);
  const r = await val(`select private.expire_pending_approvals() as v`);
  check("A41-E05 a lapsed approval on a run that is not waiting is not touched by the sweep",
    r.expired === 0 && (await st(client, runId)).approvals[0].status === "pending", r);
});

// =================================================================== END TO END (through create_run)
await inTxn(async () => {
  await setFlags(client, { exec: true, appr: true });
  await mkUsers(client);
  const cfg = cfgOf([plain(), step("SEND")], [{ permission: "SEND", requiresApproval: true }]);
  const listingId = await mkListing(client, cfg);
  const mark0 = await maxQ();
  const runId = (await q(`select private.create_run($1,$2,'{}'::jsonb,true) as v`, [U.seller, listingId])).rows[0].v;  // owner sandbox run
  check("A41-F01a create_run dispatches the first step (1)", (await since(mark0)) === 1);

  const c0 = await claim(client, runId);
  check("A41-F01b step 0 (no tool) is claimed straight through", c0.outcome === "claimed" && c0.step_index === 0, c0);
  const mark1 = await maxQ();
  const cp0 = await checkpoint(client, runId, c0);
  check("A41-F01c step 0 checkpoint creates step 1 and dispatches it (1)", cp0.outcome === "checkpointed" && (await since(mark1)) === 1, cp0);

  const c1 = await claim(client, runId);
  const s1 = await st(client, runId);
  check("A41-F01d step 1 (tool.permission SEND) parks: run + step waiting_for_approval, one pending approval, step 0 succeeded",
    c1.outcome === "waiting_for_approval" && c1.step_index === 1 && s1.run.status === "waiting_for_approval"
      && s1.steps.map(x => x.status).join() === "succeeded,waiting_for_approval" && s1.approvals.length === 1, { c1, s1 });

  const mark2 = await maxQ();
  const d = await decide(client, U.seller, c1.approval_id, "approved");   // the run creator (here: the sandbox owner)
  check("A41-F01e creator approves: resumed, dispatched exactly once", d.outcome === "decided" && (await since(mark2)) === 1, d);

  const c1b = await claim(client, runId);
  const cp1 = await checkpoint(client, runId, c1b);
  const sf = await st(client, runId);
  check("A41-F01f step 1 runs and the run SUCCEEDS; both steps succeeded; one approval, approved",
    c1b.outcome === "claimed" && c1b.step_index === 1 && cp1.outcome === "succeeded" && sf.run.status === "succeeded"
      && sf.steps.map(x => x.status).join() === "succeeded,succeeded" && sf.approvals.length === 1 && sf.approvals[0].status === "approved"
      && Number(sf.run.cost) === 0, sf);
});

// =================================================================== CONCURRENCY (opt-in)
if (destructive) {
  const mk = async () => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; };
  const cleanup = async (fx) => {
    await q(`delete from public.approvals where run_id=$1`, [fx.runId]);
    await q(`delete from public.run_steps where run_id=$1`, [fx.runId]);
    await q(`delete from public.runs where id=$1`, [fx.runId]);
    await q(`delete from public.listings where id=$1`, [fx.listingId]);
  };
  const flagsBefore = (await q(`select name, enabled from private.feature_flags where name in ('phase3_execution','phase4_approvals')`)).rows;
  const restoreFlags = async () => { for (const f of flagsBefore) await q(`update private.feature_flags set enabled=$1 where name=$2`, [f.enabled, f.name]); };
  const commitParked = async () => {
    await setFlags(client, { exec: true, appr: true });
    await mkUsers(client);
    const r = await mkRun(client);
    const c = await claim(client, r.runId);
    return { ...r, approvalId: c.approval_id };
  };
  const A = await mk(), B = await mk();
  let fx;
  try {
    // K01: two approvals racing -> exactly one wins, exactly one dispatch
    fx = await commitParked();
    const mark = await maxQ();
    await A.query("BEGIN");
    const first = await decide(A, U.owner, fx.approvalId, "approved");
    await B.query("BEGIN");
    let bDone = false;
    const bP = decide(B, U.owner, fx.approvalId, "approved").then(v => { bDone = true; return v; });
    await new Promise(r => setTimeout(r, 400));
    const blocked = !bDone;
    await A.query("COMMIT");
    const second = await bP; await B.query("COMMIT");
    const s = await st(client, fx.runId);
    check("A41-K01 two concurrent approvals: the second WAITS on the run lock, then gets noop already_decided; exactly one dispatch",
      first.outcome === "decided" && blocked && second.outcome === "noop" && second.reason === "already_decided"
        && (await since(mark)) === 1 && s.run.status === "running" && s.steps[0].status === "pending", { first, blocked, second, dispatched: await since(mark) });
    await cleanup(fx);

    // K02: approve in flight, cancel arrives -> cancel waits, then cancels cleanly (no half-resumed run)
    fx = await commitParked();
    await A.query("BEGIN");
    await decide(A, U.owner, fx.approvalId, "approved");
    await B.query("BEGIN");
    let cDone = false;
    const cP = cancelMine(B, U.owner, fx.runId).then(v => { cDone = true; return v; });
    await new Promise(r => setTimeout(r, 400));
    const cBlocked = !cDone;
    await A.query("COMMIT");
    const cr = await cP; await B.query("COMMIT");
    const s2 = await st(client, fx.runId);
    check("A41-K02 approve vs cancel: cancel waits, then wins cleanly (run cancelled, step skipped, nothing left pending/running)",
      cBlocked && cr.outcome === "cancelled" && s2.run.status === "cancelled" && s2.steps[0].status === "skipped", { cBlocked, cr, s2 });
    await cleanup(fx);

    // K03: expiry sweep never queues behind a decision in flight (SKIP LOCKED)
    fx = await commitParked();
    await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [fx.approvalId]);
    await A.query("BEGIN");
    await A.query(`select id from public.runs where id=$1 for update`, [fx.runId]);
    const t0 = Date.now();
    await q(`set statement_timeout = 3000`);
    let sw = null, swErr = null;
    try { sw = await val(`select private.expire_pending_approvals() as v`); } catch (e) { swErr = e.message; }
    await q(`reset statement_timeout`);
    const ms = Date.now() - t0;
    const sk = await st(client, fx.runId);
    check("A41-K03 expiry sweep skips a locked run without blocking and leaves it untouched",
      swErr === null && ms < 1500 && sk.approvals[0].status === "pending" && sk.run.status === "waiting_for_approval", { ms, swErr, sw });
    await A.query("ROLLBACK");
    const sw2 = await val(`select private.expire_pending_approvals() as v`);
    check("A41-K03b once unlocked, the next sweep expires it", sw2.expired === 1 && (await st(client, fx.runId)).run.error === "approval_expired", sw2);
    await cleanup(fx); fx = null;

    // K04: one approval raising must not abort the batch
    const f1 = await commitParked(), f2 = await commitParked();
    for (const f of [f1, f2]) await q(`update public.approvals set expires_at = now() - interval '1 minute' where id=$1`, [f.approvalId]);
    await q(`create function public.a41_boom() returns trigger language plpgsql as $$ begin
               if old.id = '${f1.approvalId}' then raise exception 'a41 induced failure'; end if; return new; end $$`);
    await q(`create trigger a41_boom before update on public.approvals for each row execute function public.a41_boom()`);
    try {
      const r = await val(`select private.expire_pending_approvals() as v`);
      const s1x = await st(client, f1.runId), s2x = await st(client, f2.runId);
      check("A41-K04 an exception on one approval is counted; the other is still expired",
        r.errors >= 1 && s1x.approvals[0].status === "pending" && s2x.approvals[0].status === "expired", { r, a1: s1x.approvals[0].status, a2: s2x.approvals[0].status });
    } finally {
      await q(`drop trigger if exists a41_boom on public.approvals`);
      await q(`drop function if exists public.a41_boom()`);
      await cleanup(f1); await cleanup(f2);
    }
  } finally {
    await A.query("ROLLBACK").catch(() => {}); await B.query("ROLLBACK").catch(() => {});
    await A.end(); await B.end();
    if (fx) await cleanup(fx).catch(() => {});
    await restoreFlags();
  }
} else {
  console.log("NOTE: A41-K* concurrency tests not run (set PHASE4_DESTRUCTIVE_TESTS=1 on a scratch DB).");
}

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
