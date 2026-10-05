// M40 -- Milestone 4.0 DB tests: unified dispatch trigger + private.sweep_stale_runs
//        + RPC payload drift check against tests/phase4/worker-contract/fixtures.
//
// Same conventions as tests/phase3: plain script, hand-rolled check(),
// DATABASE_URL (owner-level connection), every behavioural test runs inside a
// transaction that is ROLLED BACK. pg_net queues requests transactionally, so
// nothing is ever actually sent to the worker by this file.
//
// Two groups need committed data and are OFF unless you opt in:
//   PHASE4_DESTRUCTIVE_TESTS=1  -> M40-S07 (SKIP LOCKED, two connections; commits
//                                  a fixture then deletes it) and M40-S08
//                                  (per-run exception isolation; creates and
//                                  drops a temporary trigger on run_steps, which
//                                  takes a brief table lock -- run on a scratch
//                                  DB or a quiet window, not during traffic).
//
// Run:  DATABASE_URL=... node tests/phase4/m40-dispatch-sweep.test.mjs

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
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

// ---------------------------------------------------------------- definitions
const trg = async (name) => (await q(
  `select pg_get_triggerdef(t.oid) as def, t.tgenabled as enabled
     from pg_trigger t where t.tgrelid = 'public.run_steps'::regclass and t.tgname = $1 and not t.tgisinternal`, [name])).rows[0];

const t1 = await trg("t1_dispatch_pending_step");
check("M40-D01 t1 still INSERT-only, WHEN new.status = 'pending' (unchanged)",
  !!t1 && / AFTER INSERT ON /.test(t1.def) && !/UPDATE/.test(t1.def) && /new\.status = 'pending'/.test(t1.def) && t1.enabled === "O", t1?.def);
const t2 = await trg("t2_dispatch_pending_step_on_update");
check("M40-D02 t2 exists: AFTER UPDATE OF status, WHEN pending AND status changed, enabled",
  !!t2 && /AFTER UPDATE OF status ON /.test(t2.def) && /new\.status = 'pending'/.test(t2.def)
    && /old\.status IS DISTINCT FROM new\.status/.test(t2.def) && t2.enabled === "O", t2?.def);
check("M40-D03 both triggers call private.dispatch_run_step()",
  /private\.dispatch_run_step\(\)/.test(t1?.def ?? "") && /private\.dispatch_run_step\(\)/.test(t2?.def ?? ""));

// ---------------------------------------------------------------- privileges
const fn = (await q(
  `select p.prosecdef, p.proconfig, p.provolatile
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'sweep_stale_runs'`)).rows[0];
check("M40-S01a sweep_stale_runs is SECURITY DEFINER with search_path=''",
  fn?.prosecdef === true && Array.isArray(fn.proconfig) && fn.proconfig.includes('search_path=""'), fn);
const grants = (await q(
  `select grantee from information_schema.role_routine_grants
    where routine_schema = 'private' and routine_name = 'sweep_stale_runs'`)).rows.map(r => r.grantee);
check("M40-S01b sweep_stale_runs has no grant to PUBLIC/anon/authenticated/service_role",
  !grants.some(g => ["PUBLIC", "anon", "authenticated", "service_role"].includes(g)), grants);
const pubExec = await val(`select has_function_privilege('anon', 'private.sweep_stale_runs(integer)', 'execute') or
                                  has_function_privilege('authenticated', 'private.sweep_stale_runs(integer)', 'execute') or
                                  has_function_privilege('service_role', 'private.sweep_stale_runs(integer)', 'execute') as v`);
check("M40-S01c anon/authenticated/service_role cannot EXECUTE it", pubExec === false);

// ---------------------------------------------------------------- fixtures
const vaultOk = Number(await val(`select count(*)::int as v from vault.decrypted_secrets
                                   where name in ('execution_worker_url','execution_worker_shared_secret')`)) === 2;
if (!vaultOk) console.log("NOTE: Vault dispatch secrets not configured -> dispatch-count checks will FAIL by design.");

const UID = "00000000-0000-0000-0000-0000000fff40";
const CFG = (retryLimit) => ({ steps: [{ retryLimit, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } });

async function mkRun(cli, { retryLimit = 1, runStatus = "running", stepStatus = "running", startedAgoSec = 600 }) {
  await cli.query(`insert into auth.users (id, email) values ($1,'m40@example.invalid') on conflict (id) do nothing`, [UID]);
  const { rows: [l] } = await cli.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status)
     values ('M40 fixture','n/a','n/a',0,'fixture',$1,'pending_review') returning id`, [UID]);
  const { rows: [r] } = await cli.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status, started_at)
     values ($1,$2,1,$3::jsonb,$4, now() - make_interval(secs => $5)) returning id`,
    [UID, l.id, JSON.stringify(CFG(retryLimit)), runStatus, startedAgoSec]);
  // insert as 'pending' would dispatch; insert directly in the target state, then age it
  const { rows: [s] } = await cli.query(
    `insert into public.run_steps (run_id, step_index, status, started_at)
     values ($1,0,$2, case when $2 = 'running' then now() - make_interval(secs => $3) end) returning id`,
    [r.id, stepStatus, startedAgoSec]);
  return { runId: r.id, stepId: s.id, listingId: l.id };
}
const maxQ = async () => Number(await val(`select coalesce(max(id),0)::bigint as v from net.http_request_queue`));
const dispatchesSince = async (mark) => Number(await val(`select count(*)::int as v from net.http_request_queue where id > $1`, [mark]));
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }

// ---------------------------------------------------------------- trigger behaviour
await inTxn(async () => {
  let mark = await maxQ();
  const { runId, stepId } = await mkRun(client, { stepStatus: "running" });
  check("M40-D04a fixture: inserting a step directly as 'running' does not dispatch", (await dispatchesSince(mark)) === 0);

  mark = await maxQ();
  await q(`insert into public.run_steps (run_id, step_index, status) values ($1,1,'pending')`, [runId]);
  check("M40-D04b INSERT of a pending step dispatches once (t1 path unchanged)", (await dispatchesSince(mark)) === 1);

  mark = await maxQ();
  await q(`update public.run_steps set status='pending', started_at=null where id=$1`, [stepId]);
  check("M40-D05 running -> pending (UPDATE) dispatches once (t2 path)", (await dispatchesSince(mark)) === 1);

  mark = await maxQ();
  await q(`update public.run_steps set status='pending' where id=$1`, [stepId]);
  check("M40-D06 pending -> pending (no change) does NOT dispatch", (await dispatchesSince(mark)) === 0);

  mark = await maxQ();
  await q(`update public.run_steps set output='{"x":1}'::jsonb where id=$1`, [stepId]);
  check("M40-D07 update that does not touch status does NOT dispatch", (await dispatchesSince(mark)) === 0);

  mark = await maxQ();
  await q(`update public.run_steps set status='running', started_at=now() where id=$1`, [stepId]);
  check("M40-D08 pending -> running (claim) does NOT dispatch", (await dispatchesSince(mark)) === 0);

  mark = await maxQ();
  await q(`update public.run_steps set status='succeeded', completed_at=now() where id=$1`, [stepId]);
  check("M40-D09 running -> succeeded does NOT dispatch", (await dispatchesSince(mark)) === 0);
});

// real retry path through private.retry_or_fail_step
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client, { retryLimit: 1 });
  let mark = await maxQ();
  const { rows: [r1] } = await q(`select private.retry_or_fail_step($1,$2,0,'boom') as v`, [runId, stepId]);
  check("M40-D10a retry_or_fail_step 'retried' fires exactly one dispatch",
    r1.v.outcome === "retried" && (await dispatchesSince(mark)) === 1, r1.v);
});
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client, { retryLimit: 0 });
  const mark = await maxQ();
  const { rows: [r1] } = await q(`select private.retry_or_fail_step($1,$2,0,'boom') as v`, [runId, stepId]);
  check("M40-D10b retry_or_fail_step terminal 'failed' fires NO dispatch",
    r1.v.outcome === "failed" && (await dispatchesSince(mark)) === 0, r1.v);
});

// ---------------------------------------------------------------- sweep behaviour
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client, { retryLimit: 1, startedAgoSec: 600 });
  const mark = await maxQ();
  const { rows: [{ v }] } = await q(`select private.sweep_stale_runs() as v`);
  const step = (await q(`select status, retry_count, error from public.run_steps where id=$1`, [stepId])).rows[0];
  const run = (await q(`select status from public.runs where id=$1`, [runId])).rows[0];
  check("M40-S02a stale step + retries left: step -> pending, retry_count 1, run stays running",
    step.status === "pending" && step.retry_count === 1 && step.error === "stale_worker_recovered" && run.status === "running", { step, run });
  check("M40-S02b summary counts it as recovered", v.scanned >= 1 && v.recovered >= 1 && v.errors === 0, v);
  check("M40-S02c the retry is dispatched (via t2) exactly once", (await dispatchesSince(mark)) === 1);
});
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client, { retryLimit: 0, startedAgoSec: 600 });
  const mark = await maxQ();
  await q(`select private.sweep_stale_runs()`);
  const run = (await q(`select status, error from public.runs where id=$1`, [runId])).rows[0];
  const step = (await q(`select status from public.run_steps where id=$1`, [stepId])).rows[0];
  check("M40-S03a stale step + retryLimit 0: run failed 'stale_worker_recovered', step failed",
    run.status === "failed" && run.error === "stale_worker_recovered" && step.status === "failed", { run, step });
  check("M40-S03b terminal failure dispatches nothing", (await dispatchesSince(mark)) === 0);
});
await inTxn(async () => {
  const { runId, stepId } = await mkRun(client, { retryLimit: 1, startedAgoSec: 30 }); // fresh: < 120 s
  const mark = await maxQ();
  const { rows: [{ v }] } = await q(`select private.sweep_stale_runs() as v`);
  const step = (await q(`select status, retry_count from public.run_steps where id=$1`, [stepId])).rows[0];
  check("M40-S04 a step running for < stale threshold is untouched",
    step.status === "running" && step.retry_count === 0 && (await dispatchesSince(mark)) === 0, { step, v });
});
await inTxn(async () => {
  for (const rs of ["cancelled", "succeeded", "failed"]) {
    // NB: a non-running run with a stale-looking 'running' step is an inconsistent state; the sweep must still leave it alone
    const { runId, stepId } = await mkRun(client, { retryLimit: 1, runStatus: rs, startedAgoSec: 600 });
    await q(`select private.sweep_stale_runs()`);
    const step = (await q(`select status, retry_count from public.run_steps where id=$1`, [stepId])).rows[0];
    const run = (await q(`select status from public.runs where id=$1`, [runId])).rows[0];
    check(`M40-S05 run '${rs}' is never touched by the sweep`, step.status === "running" && step.retry_count === 0 && run.status === rs, { step, run });
  }
});
await inTxn(async () => {
  for (let i = 0; i < 3; i++) await mkRun(client, { retryLimit: 1, startedAgoSec: 600 + i });
  const { rows: [{ v }] } = await q(`select private.sweep_stale_runs(2) as v`);
  const remaining = Number(await val(`select count(*)::int as v from public.run_steps where status='running' and started_at < now() - interval '120 seconds'`));
  check("M40-S06a batch limit honoured: limit 2 recovers 2", v.scanned === 2 && v.recovered === 2, v);
  check("M40-S06b the third stale run is left for the next tick", remaining >= 1);
  const { rows: [{ v: v0 }] } = await q(`select private.sweep_stale_runs(0) as v`);
  const { rows: [{ v: vn }] } = await q(`select private.sweep_stale_runs(null) as v`);
  check("M40-S06c limit 0 / null are clamped, not errors", typeof v0.scanned === "number" && typeof vn.scanned === "number", { v0, vn });
});
await inTxn(async () => {
  const { rows: [{ v }] } = await q(`select private.sweep_stale_runs() as v`);
  check("M40-S06d returns {scanned,recovered,noop,errors} even with nothing to do",
    ["scanned", "recovered", "noop", "errors"].every(k => Number.isInteger(v[k])), v);
});

// ---------------------------------------------------------------- opt-in destructive tests
if (destructive) {
  // S07: SKIP LOCKED -- run B's sweep must not wait for run A's lock
  const other = new pg.Client({ connectionString: process.env.DATABASE_URL }); await other.connect();
  let fx;
  try {
    fx = await mkRun(client, { retryLimit: 1, startedAgoSec: 600 }); // autocommit -> visible to `other`
    await other.query("BEGIN");
    await other.query(`select id from public.runs where id=$1 for update`, [fx.runId]);
    const t0 = Date.now();
    let v = null, blockedErr = null;
    await q(`set statement_timeout = 3000`); // a blocking sweep must FAIL this test, not hang it
    try { v = (await q(`select private.sweep_stale_runs() as v`)).rows[0].v; }
    catch (e) { blockedErr = e.message; }
    await q(`reset statement_timeout`);
    const ms = Date.now() - t0;
    const step = (await q(`select status, retry_count from public.run_steps where id=$1`, [fx.stepId])).rows[0];
    check("M40-S07 sweep skips a locked run without blocking and leaves it unchanged",
      blockedErr === null && ms < 1500 && step.status === "running" && step.retry_count === 0, { ms, step, v, blockedErr });
    await other.query("ROLLBACK");
    const { rows: [{ v: v2 }] } = await q(`select private.sweep_stale_runs() as v`);
    const step2 = (await q(`select status, retry_count from public.run_steps where id=$1`, [fx.stepId])).rows[0];
    check("M40-S07b once unlocked, the next sweep recovers it", step2.status === "pending" && step2.retry_count === 1 && v2.recovered >= 1, { step2, v2 });
  } finally {
    await other.query("ROLLBACK").catch(() => {}); await other.end();
    if (fx) {
      await q(`delete from public.run_steps where run_id=$1`, [fx.runId]);
      await q(`delete from public.runs where id=$1`, [fx.runId]);
      await q(`delete from public.listings where id=$1`, [fx.listingId]);
    }
  }
  // S08: one run whose recovery raises must not abort the batch
  let a, b;
  try {
    a = await mkRun(client, { retryLimit: 1, startedAgoSec: 700 });
    b = await mkRun(client, { retryLimit: 1, startedAgoSec: 600 });
    await q(`create function public.m40_boom() returns trigger language plpgsql as $$ begin
               if old.id = '${a.stepId}' then raise exception 'm40 induced failure'; end if; return new; end $$`);
    await q(`create trigger m40_boom before update on public.run_steps for each row execute function public.m40_boom()`);
    const { rows: [{ v }] } = await q(`select private.sweep_stale_runs() as v`);
    const sa = (await q(`select status, retry_count from public.run_steps where id=$1`, [a.stepId])).rows[0];
    const sb = (await q(`select status, retry_count from public.run_steps where id=$1`, [b.stepId])).rows[0];
    check("M40-S08 an exception on one run is counted; the other run is still recovered",
      v.errors >= 1 && sa.status === "running" && sb.status === "pending" && sb.retry_count === 1, { v, sa, sb });
  } finally {
    await q(`drop trigger if exists m40_boom on public.run_steps`);
    await q(`drop function if exists public.m40_boom()`);
    for (const x of [a, b]) if (x) {
      await q(`delete from public.run_steps where run_id=$1`, [x.runId]);
      await q(`delete from public.runs where id=$1`, [x.runId]);
      await q(`delete from public.listings where id=$1`, [x.listingId]);
    }
  }
} else {
  console.log("NOTE: M40-S07 / M40-S08 not run (set PHASE4_DESTRUCTIVE_TESTS=1 on a scratch DB).");
}

// ---------------------------------------------------------------- payload drift vs committed fixtures
const fxPath = path.join(here, "worker-contract", "fixtures", "rpc-payloads.json");
if (fs.existsSync(fxPath)) {
  const committed = JSON.parse(fs.readFileSync(fxPath, "utf8"));
  const { generate } = await import("./worker-contract/gen-fixtures.mjs");
  await q("BEGIN");
  try {
    const live = await generate(client);
    const keys = (o) => Object.keys(o).sort().join(",");
    for (const name of Object.keys(committed.payloads)) {
      check(`M40-F ${name}: committed fixture keys == live DB payload keys`,
        keys(committed.payloads[name]) === keys(live.payloads[name] ?? {}), { committed: keys(committed.payloads[name]), live: keys(live.payloads[name] ?? {}) });
    }
    for (const name of Object.keys(committed.signatures)) {
      check(`M40-F signature ${name}: committed == live`,
        JSON.stringify(committed.signatures[name]) === JSON.stringify(live.signatures[name]), { committed: committed.signatures[name], live: live.signatures[name] });
    }
  } finally { await q("ROLLBACK"); }
} else {
  check("M40-F fixtures file exists (run gen-fixtures.mjs)", false);
}

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
