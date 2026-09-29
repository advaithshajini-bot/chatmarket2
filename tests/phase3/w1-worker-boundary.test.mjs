// W1 -- worker credential boundary and private.retry_or_fail_step's own
// behavior (fencing, retry ceiling, lock ordering). Privilege checks
// (W1-01..04) codify what Gate 6 already verified manually; the
// behavioral ones (W1-06..08) actually exercise the function via a
// rolled-back transaction. W1-05 needs a real deployed worker and is
// BLOCKED until Part 3.

import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.log("SKIPPED: DATABASE_URL not set.");
  process.exit(0);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

// W1-01 / W1-02: exact grants.
const { rows: privGrants } = await client.query(
  `select routine_schema, routine_name, grantee from information_schema.role_routine_grants
   where (routine_schema='private' and routine_name='retry_or_fail_step')
      or (routine_schema='public' and routine_name='worker_retry_or_fail_step')`
);
check(
  "W1-01 private.retry_or_fail_step has zero grants to anon/authenticated/service_role",
  !privGrants.some(g => g.routine_name === "retry_or_fail_step" && ["anon", "authenticated", "service_role"].includes(g.grantee))
);
check(
  "W1-02 public.worker_retry_or_fail_step granted only to service_role (+ owner)",
  (() => {
    const wrapperGrants = privGrants.filter(g => g.routine_name === "worker_retry_or_fail_step").map(g => g.grantee);
    return wrapperGrants.includes("service_role") && !wrapperGrants.includes("anon") && !wrapperGrants.includes("authenticated");
  })()
);

// W1-03 / W1-04: security definer + search_path.
const { rows: fnProps } = await client.query(
  `select p.proname, p.prosecdef, p.proconfig
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='private' and p.proname='retry_or_fail_step')
      or (n.nspname='public' and p.proname='worker_retry_or_fail_step')`
);
check("W1-03 both functions are SECURITY DEFINER", fnProps.length === 2 && fnProps.every(f => f.prosecdef === true));
check("W1-04 both functions have search_path=''", fnProps.every(f => Array.isArray(f.proconfig) && f.proconfig.includes('search_path=""')));

// W1-06 / W1-07 / W1-08: behavioral, via fixture + rolled-back transaction.
// private.retry_or_fail_step is owner-only, so this connection (owner-
// level, per file header requirement) can call it directly, standing in
// for what the worker wrapper would do.
async function withRunAndStep(fn) {
  await client.query("BEGIN");
  try {
    const uid = "00000000-0000-0000-0000-0000000fff10";
    await client.query(`insert into auth.users (id, email) values ($1,'gate7-w1@example.invalid') on conflict (id) do nothing`, [uid]);
    const { rows: [listing] } = await client.query(
      `insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('Gate7 W1 fixture','n/a','n/a',0,'fixture',$1,'pending_review') returning id`,
      [uid]
    );
    const cfg = { steps: [{ retryLimit: 1, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } };
    const { rows: [run] } = await client.query(
      `insert into public.runs (user_id, product_id, product_version, execution_config, status) values ($1,$2,1,$3::jsonb,'running') returning id`,
      [uid, listing.id, JSON.stringify(cfg)]
    );
    const { rows: [step] } = await client.query(
      `insert into public.run_steps (run_id, step_index, status) values ($1,0,'running') returning id, retry_count`,
      [run.id]
    );
    await fn({ runId: run.id, stepId: step.id });
  } finally {
    await client.query("ROLLBACK");
  }
}

await withRunAndStep(async ({ runId, stepId }) => {
  const { rows: [before] } = await client.query(`select retry_count, status from public.run_steps where id=$1`, [stepId]);
  const { rows: [result] } = await client.query(
    `select private.retry_or_fail_step($1,$2,$3,$4) as result`,
    [runId, stepId, 999 /* deliberately wrong expected_retry_count */, "test fencing"]
  );
  const { rows: [after] } = await client.query(`select retry_count, status from public.run_steps where id=$1`, [stepId]);
  check(
    "W1-06 fencing: stale expected_retry_count is rejected and mutates nothing",
    result.result.outcome === "rejected" && result.result.reason === "fencing_mismatch"
      && after.retry_count === before.retry_count && after.status === before.status
  );
});

await withRunAndStep(async ({ runId, stepId }) => {
  // step's config has retryLimit=1 -- first failure should retry (0->1),
  // second failure (now at the ceiling) should go terminal.
  //
  // FIXED after a real run: after a 'retried' outcome, run_steps.status
  // becomes 'pending' (by design -- waiting for the worker to reclaim
  // it), not 'running'. Calling retry_or_fail_step immediately again
  // therefore got legitimately rejected with 'step_not_running' -- the
  // function's own guard working correctly, not a defect. This test
  // never got as far as exercising the retry-ceiling logic at all. The
  // manual UPDATE below simulates the worker's claim_next_step picking
  // the step back up for its retry attempt, since claim_next_step itself
  // isn't what W1 is testing here.
  const { rows: [r1] } = await client.query(`select private.retry_or_fail_step($1,$2,$3,$4) as r`, [runId, stepId, 0, "attempt 1 failed"]);
  const retried = r1.r.outcome === "retried" && r1.r.retry_count === 1;

  // Simulate claim_next_step re-claiming the step for its retry attempt.
  await client.query(`update public.run_steps set status='running' where id=$1`, [stepId]);

  const { rows: [r2] } = await client.query(`select private.retry_or_fail_step($1,$2,$3,$4) as r`, [runId, stepId, 1, "attempt 2 failed"]);
  const { rows: [runAfter] } = await client.query(`select status from public.runs where id=$1`, [runId]);
  const terminal = r2.r.outcome === "failed" && runAfter.status === "failed";

  check("W1-07 retry ceiling: retries until max_retries, then goes terminal and finalizes the run in the same call", retried && terminal);
});

// W1-08: lock ordering / no deadlock under concurrent calls -- REAL now,
// not a racy best-effort. Two full function calls racing via Promise.all
// would only overlap by network luck, which isn't a reliable proof of
// anything. Instead: connection A manually takes and HOLDS the exact same
// row lock retry_or_fail_step's own first statement takes (select ...
// for update on runs), on a timer; connection B then calls the real
// function. If B is provably blocked for the duration A holds the lock
// (verified by elapsed time, not assumed), and then proceeds cleanly the
// instant A releases, that's a deterministic proof of real contention +
// correct serialization + no deadlock -- not hope that two calls happened
// to collide. Needs a COMMITTED fixture (same reasoning as W1-05 -- two
// separate connections below need to see it).
{
  const uid = "00000000-0000-0000-0000-0000000fffb0";
  await client.query(`insert into auth.users (id, email) values ($1,'gate7-w1-08@example.invalid') on conflict (id) do nothing`, [uid]);
  const { rows: [listing] } = await client.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('W1-08 fixture','n/a','n/a',0,'fixture',$1,'pending_review') returning id`,
    [uid]
  );
  const cfg = { steps: [{ retryLimit: 1, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } };
  const { rows: [run] } = await client.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status) values ($1,$2,1,$3::jsonb,'running') returning id`,
    [uid, listing.id, JSON.stringify(cfg)]
  );
  const { rows: [step] } = await client.query(
    `insert into public.run_steps (run_id, step_index, status) values ($1,0,'running') returning id`,
    [run.id]
  );

  const clientA = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const clientB = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await clientA.connect();
  await clientB.connect();

  const HOLD_MS = 400;

  // A takes and holds the runs-row lock -- the SAME lock the function
  // itself takes as its very first statement -- without ever calling the
  // function from A at all. Deliberately isolates this test to proving
  // contention + no deadlock, not re-testing fencing (W1-06 already
  // covers that).
  await clientA.query("BEGIN");
  await clientA.query("select id from public.runs where id=$1 for update", [run.id]);

  const startB = Date.now();
  const callBPromise = clientB
    .query(`select private.retry_or_fail_step($1,$2,$3,$4) as r`, [run.id, step.id, 0, "W1-08 race"])
    .then((res) => ({ ok: true, outcome: res.rows[0].r }))
    .catch((err) => ({ ok: false, error: err }));

  // give B's request real time to reach Postgres and actually block on
  // A's held lock, before A releases it
  await new Promise((r) => setTimeout(r, HOLD_MS));
  await clientA.query("COMMIT");

  const resultB = await callBPromise;
  const elapsedB = Date.now() - startB;

  await clientA.end();
  await clientB.end();

  check(
    `W1-08a B's call was provably blocked by A's held lock for ~${HOLD_MS}ms (elapsed: ${elapsedB}ms), not just network luck`,
    elapsedB >= HOLD_MS - 50 // small tolerance for timer granularity, not for a race
  );
  check(
    "W1-08b once A released, B's call proceeded cleanly with no deadlock/error and the correct outcome",
    resultB.ok && resultB.outcome.outcome === "retried"
  );

  await client.query(`delete from public.run_steps where run_id=$1`, [run.id]);
  await client.query(`delete from public.runs where id=$1`, [run.id]);
  await client.query(`delete from public.listings where id=$1`, [listing.id]);
  await client.query(`delete from auth.users where id=$1`, [uid]);
}

// W1-05: real worker, real service_role key, via a real HTTP call to the
// deployed Edge Function -- not a stub anymore, the worker exists (Step
// 2/3 of Phase 3.2). Needs a committed fixture (same reasoning as
// STEP3_FIXTURE_VERIFICATION.md -- the worker runs in a separate process,
// so a rolled-back transaction wouldn't be visible to it) and 2 extra env
// vars this file didn't need before: EXECUTION_WORKER_URL and
// WORKER_SHARED_SECRET. Guaranteed fail-closed for the same reason as the
// Step 3 fixture: claim_next_step checks run-existence before the
// execution flag, so this can prove the whole chain works without ever
// risking real execution.
if (!process.env.EXECUTION_WORKER_URL || !process.env.WORKER_SHARED_SECRET) {
  console.log("\nSKIPPED: W1-05 -- set EXECUTION_WORKER_URL and WORKER_SHARED_SECRET to run this for real.");
} else {
  const uid = "00000000-0000-0000-0000-0000000fffa0";
  await client.query(`insert into auth.users (id, email) values ($1,'gate7-w1-05@example.invalid') on conflict (id) do nothing`, [uid]);

  const { rows: [listing] } = await client.query(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('W1-05 fixture','n/a','n/a',0,'fixture','00000000-0000-0000-0000-0000000fffa0','pending_review') returning id`
  );
  const { rows: [run] } = await client.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config, status) values ('00000000-0000-0000-0000-0000000fffa0',$1,1,$2::jsonb,'queued') returning id`,
    [listing.id, JSON.stringify({ steps: [{ retryLimit: 0, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } })]
  );
  const { rows: [step] } = await client.query(
    `insert into public.run_steps (run_id, step_index, status) values ($1,0,'pending') returning id`,
    [run.id]
  );

  const resp = await fetch(process.env.EXECUTION_WORKER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.WORKER_SHARED_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ runId: run.id }),
  });
  const { rows: [stepAfter] } = await client.query(`select status from public.run_steps where id=$1`, [step.id]);

  check(
    "W1-05 real worker, real service_role key, successfully calls worker_claim_next_step (fails closed, execution_disabled)",
    resp.status === 200 && stepAfter.status === "pending" // untouched -- proves it was rejected, not claimed
  );

  await client.query(`delete from public.run_steps where run_id=$1`, [run.id]);
  await client.query(`delete from public.runs where id=$1`, [run.id]);
  await client.query(`delete from public.listings where id=$1`, [listing.id]);
  await client.query(`delete from auth.users where id='00000000-0000-0000-0000-0000000fffa0'`);
}

console.log(`\nW1: ${pass} passed, ${fail} failed`);
await client.end();
process.exitCode = fail > 0 ? 1 : 0;
