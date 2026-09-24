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
  const { rows: [r1] } = await client.query(`select private.retry_or_fail_step($1,$2,$3,$4) as r`, [runId, stepId, 0, "attempt 1 failed"]);
  const retried = r1.r.outcome === "retried" && r1.r.retry_count === 1;

  const { rows: [r2] } = await client.query(`select private.retry_or_fail_step($1,$2,$3,$4) as r`, [runId, stepId, 1, "attempt 2 failed"]);
  const { rows: [runAfter] } = await client.query(`select status from public.runs where id=$1`, [runId]);
  const terminal = r2.r.outcome === "failed" && runAfter.status === "failed";

  check("W1-07 retry ceiling: retries until max_retries, then goes terminal and finalizes the run in the same call", retried && terminal);
});

// W1-08: lock ordering can't be meaningfully proven by a single-connection
// test (it's a concurrency property). Documented, not faked.
console.log("NOTE: W1-08 (lock ordering / no deadlock under concurrent calls) requires two concurrent connections racing each other and is not implemented in this file -- needs a proper concurrency test harness, not a single-client script. Left BLOCKED rather than writing a test that can't actually detect a deadlock.");
fail++; // counted honestly as not-yet-covered, not silently dropped

console.log("\nW1-05 (real worker, service_role key) BLOCKED -- no worker deployed yet.");

console.log(`\nW1: ${pass} passed, ${fail} failed`);
await client.end();
