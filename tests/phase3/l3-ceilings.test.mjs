// L3-12 / L3-13 / L3-14 -- the three system ceilings enforced INSIDE the
// database (not in app code), tested against the real deployed SQL:
//   L3-12  maxRunsPerUserPerDay  = 20   (private.create_run, rolling 24h)
//   L3-13  maxStepOutputBytes    = 51200 (private.checkpoint_step)
//   L3-14  maxRunOutputBytes     = 204800 (private.checkpoint_step, cumulative)
//
// EVERYTHING here runs inside BEGIN ... ROLLBACK. Nothing is committed.
//
// FLAG HANDLING (read this before running):
//   * L3-13 / L3-14 do NOT touch the feature flag at all --
//     private.checkpoint_step never calls is_execution_enabled().
//   * L3-12 must: private.create_run checks the flag BEFORE the quota, so
//     with phase3_execution=false the quota branch is unreachable. That one
//     section sets private.feature_flags.enabled=true INSIDE its transaction
//     and always rolls it back. Uncommitted changes are invisible to every
//     other connection (MVCC), and this file PROVES that instead of assuming
//     it: while the flag is ON in this transaction, a second, independent
//     connection reads it and must see OFF.
//   * Guarantees: each section runs in try/catch/finally with a ROLLBACK in
//     the finally (a throwing assertion or DB error cannot skip it), a dropped
//     connection makes Postgres abort the transaction anyway, and after all
//     sections a FRESH connection re-reads the committed flag and fails the
//     run if it is not false.
//
// SIDE EFFECT NOTE: the L3-12 "20th run allowed" case makes create_run insert
// a pending run_step, which fires t1_dispatch_pending_step -> net.http_post
// inside the transaction. pg_net queues that as an ordinary insert, so the
// ROLLBACK discards it. This file checks that instead of assuming it (see
// "dispatch escape check" at the bottom).
//
// Needs: DATABASE_URL (owner-level, session-mode). Skips itself otherwise.

import pg from "pg";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.log("SKIPPED: DATABASE_URL not set. This file needs a direct, owner-level Postgres connection string.");
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, detail !== undefined ? `-- ${JSON.stringify(detail)}` : ""); }
}

const connect = async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  return c;
};

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const client = await connect();

// One transaction per section. ROLLBACK is in `finally`, so it happens whether
// the section passes, fails an assertion, or throws a database error.
async function section(name, fn) {
  await client.query("BEGIN");
  try {
    await fn();
  } catch (e) {
    fail++;
    console.log(`FAIL (section threw): ${name} -- ${e.message}`);
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* connection already gone: Postgres aborts the txn itself */ }
  }
}

// --- fixtures -------------------------------------------------------------
const cfg = (n) => ({
  steps: Array.from({ length: n }, () => ({ retryLimit: 0, timeoutSeconds: 30 })),
  limits: { maxSteps: n, maxCostInr: 10, timeoutSeconds: 60 },
});

// A jsonb STRING whose ::text form is exactly `bytes` bytes long (the value
// plus its two quote characters) -- private.checkpoint_step measures
// octet_length(output::text), so that is the number that must be exact.
const strOutput = (bytes) => JSON.stringify("a".repeat(bytes - 2));
async function textBytes(jsonText) {
  const { rows: [r] } = await client.query("select octet_length($1::jsonb::text) as n", [jsonText]);
  return r.n;
}

async function makeUserAndListing({ live = false, configSteps = 1 } = {}) {
  const uid = randomUUID();
  await client.query("insert into auth.users (id, email) values ($1, $2)", [uid, `ceilings-${uid}@example.invalid`]);
  const { rows: [l] } = await client.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('ceilings fixture','n/a','n/a',0,'fixture',$1,$2,'workflow',$3::jsonb) returning id`,
    [uid, live ? "live" : "pending_review", JSON.stringify(cfg(configSteps))]
  );
  return { uid, listingId: l.id };
}

async function makeRunningRun(uid, listingId, nSteps) {
  const { rows: [run] } = await client.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status)
     values ($1,$2,1,$3::jsonb,'running') returning id`,
    [uid, listingId, JSON.stringify(cfg(nSteps))]
  );
  return run.id;
}

async function checkpoint(runId, stepId, outputJsonText) {
  const { rows: [r] } = await client.query(
    "select private.checkpoint_step($1,$2,0,$3::jsonb,0) as r", [runId, stepId, outputJsonText]
  );
  return r.r;
}

async function runAndStep(runId, stepId) {
  const { rows: [run] } = await client.query("select status, error from public.runs where id=$1", [runId]);
  const { rows: [step] } = await client.query("select status from public.run_steps where id=$1", [stepId]);
  return { run, step };
}

// --- precondition: refuse to run if the committed flag is not OFF ---------
{
  const { rows: [f] } = await client.query("select private.is_execution_enabled() as e");
  if (f.e !== false) {
    console.log("FAIL: PRECONDITION -- phase3_execution is not OFF before this file started. Refusing to run.");
    await client.end();
    process.exit(1);
  }
}
const startedAt = (await client.query("select clock_timestamp() as t")).rows[0].t.toISOString();

// ===========================================================================
// L3-13 -- maxStepOutputBytes (51200): reject above, allow exactly at
// ===========================================================================
await section("L3-13a step output over ceiling", async () => {
  const { uid, listingId } = await makeUserAndListing();
  const runId = await makeRunningRun(uid, listingId, 1);
  const { rows: [step] } = await client.query(
    "insert into public.run_steps (run_id, step_index, status) values ($1,0,'running') returning id", [runId]);
  const out = strOutput(51201);
  check("L3-13 fixture guard: output is exactly 51201 bytes", (await textBytes(out)) === 51201);
  const r = await checkpoint(runId, step.id, out);
  const s = await runAndStep(runId, step.id);
  check("L3-13a 51201-byte step output is rejected (outcome=failed, output_limit_exceeded:step)",
    r.outcome === "failed" && r.reason === "output_limit_exceeded:step", r);
  check("L3-13a ...and the run and step were failed closed, not left running",
    s.run.status === "failed" && s.step.status === "failed", s);
});

await section("L3-13b step output exactly at ceiling", async () => {
  const { uid, listingId } = await makeUserAndListing();
  const runId = await makeRunningRun(uid, listingId, 1); // single step: no next-step insert, no dispatch trigger
  const { rows: [step] } = await client.query(
    "insert into public.run_steps (run_id, step_index, status) values ($1,0,'running') returning id", [runId]);
  const out = strOutput(51200);
  check("L3-13 fixture guard: output is exactly 51200 bytes", (await textBytes(out)) === 51200);
  const r = await checkpoint(runId, step.id, out);
  const s = await runAndStep(runId, step.id);
  check("L3-13b a step output of exactly 51200 bytes is ACCEPTED (limit is inclusive)",
    r.outcome === "succeeded" && s.run.status === "succeeded", r);
});

// ===========================================================================
// L3-14 -- maxRunOutputBytes (204800): cumulative across succeeded steps
// ===========================================================================
async function runCeilingCase({ label, priorSizes, expectOutcome, expectReason, expectTotal }) {
  await section(label, async () => {
    const { uid, listingId } = await makeUserAndListing({ configSteps: 5 });
    const runId = await makeRunningRun(uid, listingId, 5);
    for (let i = 0; i < priorSizes.length; i++) {
      await client.query(
        "insert into public.run_steps (run_id, step_index, status, output) values ($1,$2,'succeeded',$3::jsonb)",
        [runId, i, strOutput(priorSizes[i])]);
    }
    const { rows: [step] } = await client.query(
      "insert into public.run_steps (run_id, step_index, status) values ($1,4,'running') returning id", [runId]);
    const { rows: [t] } = await client.query(
      "select sum(octet_length(output::text))::int as n from public.run_steps where run_id=$1 and status='succeeded'", [runId]);
    check(`${label} fixture guard: prior succeeded outputs total exactly ${expectTotal - 1} bytes`, t.n === expectTotal - 1, t);
    const r = await checkpoint(runId, step.id, "1"); // 1 byte
    const s = await runAndStep(runId, step.id);
    check(`${label}: total ${expectTotal} bytes -> ${expectOutcome}${expectReason ? " (" + expectReason + ")" : ""}`,
      r.outcome === expectOutcome && (expectReason ? r.reason === expectReason : true), r);
    if (expectOutcome === "failed") {
      check(`${label}: run failed closed`, s.run.status === "failed" && s.step.status === "failed", s);
    } else {
      check(`${label}: run completed`, s.run.status === "succeeded", s);
    }
  });
}
// prior 204800 + 1 = 204801 > 204800  -> rejected
await runCeilingCase({ label: "L3-14a", priorSizes: [51200, 51200, 51200, 51200], expectOutcome: "failed", expectReason: "output_limit_exceeded:run", expectTotal: 204801 });
// prior 204799 + 1 = 204800 (exactly at) -> accepted
await runCeilingCase({ label: "L3-14b", priorSizes: [51200, 51200, 51200, 51199], expectOutcome: "succeeded", expectTotal: 204800 });

// ===========================================================================
// L3-12 -- maxRunsPerUserPerDay (20). The ONLY section that touches the flag,
// and only inside its own transaction.
// ===========================================================================
let clientB;
await section("L3-12 daily run quota", async () => {
  const { uid, listingId } = await makeUserAndListing({ live: true, configSteps: 1 });
  await client.query("insert into public.entitlements (user_id, product_id, kind) values ($1,$2,'purchase')", [uid, listingId]);
  await client.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status)
     select $1,$2,1,$3::jsonb,'succeeded' from generate_series(1,19)`,
    [uid, listingId, JSON.stringify(cfg(1))]);
  const count = async () => (await client.query("select count(*)::int as n from public.runs where user_id=$1", [uid])).rows[0].n;
  check("L3-12 fixture guard: exactly 19 runs already exist for the user in the last 24h", (await count()) === 19);

  // The only flag write in this whole file: uncommitted, rolled back in section().
  const upd = await client.query("update private.feature_flags set enabled = true where name = 'phase3_execution'");
  check("L3-12 fixture guard: flag row updated inside the transaction", upd.rowCount === 1, upd.rowCount);
  const { rows: [inTxn] } = await client.query("select private.is_execution_enabled() as e");
  check("L3-12 fixture guard: flag reads ON inside this transaction (otherwise create_run would stop at CM010)", inTxn.e === true);

  // MVCC isolation, PROVEN: an independent connection must still see OFF.
  clientB = await connect();
  const { rows: [other] } = await withTimeout(
    clientB.query("select private.is_execution_enabled() as e"), 5000, "second connection reading the flag");
  check("L3-12 isolation: a SEPARATE connection still sees the flag OFF while it is ON inside this transaction", other.e === false, other);

  // 19 existing -> the 20th run is still allowed (limit is inclusive)
  const { rows: [created] } = await client.query("select private.create_run($1,$2,'{}'::jsonb,false) as id", [uid, listingId]);
  check("L3-12a with 19 existing runs, the 20th is ALLOWED", typeof created.id === "string" && (await count()) === 20, created);

  // 20 existing -> the 21st is rejected with CM015. SAVEPOINT because a raised
  // error would otherwise abort the whole transaction.
  await client.query("SAVEPOINT quota_probe");
  let err = null, countAfterAttempt = null;
  try {
    await client.query("select private.create_run($1,$2,'{}'::jsonb,false)", [uid, listingId]);
    // Reached only if create_run did NOT raise. Count BEFORE the savepoint
    // rollback, or a wrongly-created 21st row would be erased before we look
    // (found by mutation testing: counting afterwards made this check vacuous).
    countAfterAttempt = await count();
  } catch (e) { err = e; }
  await client.query("ROLLBACK TO SAVEPOINT quota_probe");
  if (err) countAfterAttempt = await count();
  check("L3-12b with 20 existing runs, the 21st is REJECTED with CM015 daily_run_quota_exceeded",
    err && err.code === "CM015" && /daily_run_quota_exceeded/.test(err.message), err && { code: err.code, message: err.message });
  check("L3-12b ...and no 21st run row was created", countAfterAttempt === 20, countAfterAttempt);
});
if (clientB) await clientB.end();

// ===========================================================================
// Post-conditions: nothing may have leaked out of the rolled-back transactions
// ===========================================================================
{
  const fresh = await connect(); // a brand-new session: sees only COMMITTED state
  const { rows: [f] } = await fresh.query("select enabled from private.feature_flags where name='phase3_execution'");
  check("SAFETY: the COMMITTED phase3_execution flag is still false after this file ran", f && f.enabled === false, f);
  const { rows: [leak] } = await fresh.query(
    "select count(*)::int as n from auth.users where email like 'ceilings-%@example.invalid'");
  check("SAFETY: no fixture users leaked (everything rolled back)", leak.n === 0, leak);

  // dispatch escape check: the L3-12a create_run fired the dispatch trigger
  // inside a transaction that was rolled back. If pg_net's queue insert were
  // NOT transactional, a request would have gone out and a response row would
  // appear shortly. Wait, then look for any response created since we started.
  const { rows: [hasResp] } = await fresh.query("select to_regclass('net._http_response') is not null as ok");
  if (hasResp.ok) {
    await new Promise((r) => setTimeout(r, 4000));
    const { rows: [esc] } = await fresh.query("select count(*)::int as n from net._http_response where created > $1", [startedAt]);
    check("SAFETY: no pg_net dispatch escaped the rolled-back transaction (no http response rows since this file started)", esc.n === 0, esc);
  } else {
    console.log("NOTE: net._http_response not present here; dispatch escape check not applicable in this database.");
  }
  await fresh.end();
}

await client.end();
console.log(`\nL3 ceilings: ${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
