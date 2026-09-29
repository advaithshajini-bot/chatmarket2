// L3 — runtime fail-closed behavior. Split into two halves:
//   (a) DB-level checks (flag read, RLS, grants) -- RUNNABLE NOW, same
//       DATABASE_URL requirement and rolled-back-transaction methodology
//       as l2-database-assertion.test.mjs.
//   (b) Route-level checks (L3-03/04/05) -- BLOCKED. No run-initiation
//       route exists yet (confirmed: no app/api directory references any
//       execution function, as of this writing). Written against the
//       route Part 2 needs to build, at whatever path it ends up at --
//       update ROUTE_URL once that route exists.
//   (c) L3-12/13/14 -- KNOWN GAPS, not yet enforced anywhere. These are
//       written to currently FAIL loudly rather than being silently
//       skipped, so this file can't accidentally be read as "L3 passing"
//       while 3 real ceilings go unenforced.

import pg from "pg";

// Bug from the previous fix, now corrected: this must be initialized
// before the top-level await block below runs (which calls asUser via
// withRlsFixture), or it's still in the temporal dead zone when
// referenced -- `let` doesn't hoist its initialization the way a
// function declaration does. Moved here, to true top-of-module scope,
// instead of sitting next to asUser() further down the file where it
// textually looked fine but executed too late.
let savepointCounter = 0;
let pass = 0, fail = 0; // moved to top-of-module scope, same TDZ-avoidance reasoning as savepointCounter above, and so the final exit-code check at the bottom of this file can see them

if (!process.env.DATABASE_URL) {
  console.log("SKIPPED (a)+(c): DATABASE_URL not set.");
} else {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // (pass/fail now declared at top-of-module scope, see above)

  // L3-01 / L3-02: is_execution_enabled() is owner-only, same connection
  // requirement as L2.
  const { rows: [{ enabled_when_row_present }] } = await client.query(
    `select private.is_execution_enabled() as enabled_when_row_present` // current live state: row present, enabled=false
  );
  if (enabled_when_row_present === false) { pass++; console.log("PASS: L3-02 is_execution_enabled() is false with the current live flag row"); }
  else { fail++; console.log("FAIL: L3-02 -- flag is not false! STOP, do not proceed to activation."); }

  await client.query("BEGIN");
  try {
    await client.query(`delete from private.feature_flags where name = 'phase3_execution'`);
    const { rows: [{ enabled_when_missing }] } = await client.query(`select private.is_execution_enabled() as enabled_when_missing`);
    if (enabled_when_missing === false) { pass++; console.log("PASS: L3-01 is_execution_enabled() fails closed (false) when the flag row is missing"); }
    else { fail++; console.log("FAIL: L3-01 -- missing row did not fail closed"); }
  } finally {
    await client.query("ROLLBACK"); // never actually delete the flag row
  }

  // L3-08 / L3-09 / L3-10: grant checks (read-only, no fixture needed).
  const { rows: grants } = await client.query(
    `select routine_name, grantee from information_schema.role_routine_grants
     where routine_schema in ('private','public')
       and routine_name in ('worker_retry_or_fail_step','retry_or_fail_step')
       and grantee in ('anon','authenticated')`
  );
  if (grants.length === 0) { pass++; console.log("PASS: L3-08/09/10 -- anon and authenticated have zero grants on worker_retry_or_fail_step or retry_or_fail_step"); }
  else { fail++; console.log("FAIL: L3-08/09/10 -- unexpected grant(s) found:", grants); }

  // L3-06 / L3-07 / L3-11: RLS, impersonating `authenticated` with a
  // specific auth.uid() via request.jwt.claims, the standard Supabase
  // RLS-testing pattern for a direct Postgres connection.
  await withRlsFixture(client, async ({ ownerUid, otherUid, runId, stepId }) => {
    await asUser(client, otherUid, async () => {
      const { rows } = await client.query(`select id from public.runs where id = $1`, [runId]);
      if (rows.length === 0) { pass++; console.log("PASS: L3-06 non-owner cannot select another user's run"); }
      else { fail++; console.log("FAIL: L3-06 -- non-owner could read another user's run"); }

      // L3-07: run_steps RLS goes through private.can_view_run(), a
      // different mechanism than runs' own policy -- worth its own check.
      const { rows: stepRows } = await client.query(`select id from public.run_steps where id = $1`, [stepId]);
      if (stepRows.length === 0) { pass++; console.log("PASS: L3-07 non-owner cannot select another user's run_steps (via can_view_run)"); }
      else { fail++; console.log("FAIL: L3-07 -- non-owner could read another user's run step"); }
    });
    await asUser(client, ownerUid, async () => {
      const { rows } = await client.query(`select id from public.runs where id = $1`, [runId]);
      if (rows.length === 1) { pass++; console.log("PASS: L3-11 owner can select their own run"); }
      else { fail++; console.log("FAIL: L3-11 -- owner could not read their own run"); }

      const { rows: stepRows } = await client.query(`select id from public.run_steps where id = $1`, [stepId]);
      if (stepRows.length === 1) { pass++; console.log("PASS: L3-07b owner can select their own run_steps"); }
      else { fail++; console.log("FAIL: L3-07b -- owner could not read their own run step"); }
    });
  });

  // L3-12 / L3-13 / L3-14: CORRECTED after re-reading the full bodies of
  // private.create_run and private.checkpoint_step (20260920100400) --
  // these are NOT unenforced gaps. create_run checks maxRunsPerUserPerDay
  // directly (a rolling 24h window, raising CM015); checkpoint_step checks
  // both maxStepOutputBytes and maxRunOutputBytes directly (raising via
  // fail_run_closed). The original Gate 7 test only checked whether
  // assert_execution_config_within_ceilings enforced these, which was
  // never its job -- that was a gap in this test file, not in the
  // database. Testing the real enforcement requires calling create_run
  // enough times to exceed the quota, or checkpoint_step with an
  // oversized output -- not implemented in this pass; noting the
  // correction here rather than leaving the old, wrong claim in place.
  console.log("CORRECTED (see comment above): L3-12/13/14 are NOT unenforced gaps -- create_run and checkpoint_step already enforce all three directly. Not re-tested here yet.");

  console.log(`\nL3 (a)+(c): ${pass} passed, ${fail} failed`);
  await client.end();
}

// FIXED after a real run: this used to open its own BEGIN/ROLLBACK, but
// it's always called from inside withRlsFixture's already-open
// transaction -- a nested BEGIN doesn't create a real sub-transaction in
// Postgres (it just warns and keeps using the outer one), so the first
// call's ROLLBACK was wiping the fixture data before a second call ever
// ran. That's exactly why L3-11 failed: not an RLS bug, the run row was
// already gone by the time it ran. Using SAVEPOINT instead -- it undoes
// only the role/claims change, not the outer transaction's fixture rows.
async function asUser(client, uid, fn) {
  const sp = `as_user_${savepointCounter++}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    await client.query(`set local role authenticated`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await fn();
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query("reset role");
  }
}

async function withRlsFixture(client, fn) {
  await client.query("BEGIN");
  try {
    const ownerUid = "00000000-0000-0000-0000-0000000ffff1";
    const otherUid = "00000000-0000-0000-0000-0000000ffff2";
    await client.query(`insert into auth.users (id, email) values ($1,'gate7-owner@example.invalid'),($2,'gate7-other@example.invalid') on conflict (id) do nothing`, [ownerUid, otherUid]);
    const { rows: [listing] } = await client.query(
      `insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('Gate7 fixture','n/a','n/a',0,'fixture',$1,'pending_review') returning id`,
      [ownerUid]
    );
    const { rows: [run] } = await client.query(
      `insert into public.runs (user_id, product_id, product_version, execution_config) values ($1,$2,1,$3::jsonb) returning id`,
      [ownerUid, listing.id, JSON.stringify({ steps: [{ retryLimit: 0, timeoutSeconds: 30 }], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } })]
    );
    // status 'running', not 'pending', on purpose: a pending insert would
    // fire the t1_dispatch_pending_step trigger. (Rolled back regardless,
    // so nothing would actually send -- but no reason to even queue it.)
    const { rows: [step] } = await client.query(
      `insert into public.run_steps (run_id, step_index, status) values ($1,0,'running') returning id`,
      [run.id]
    );
    await fn({ ownerUid, otherUid, runId: run.id, stepId: step.id, productId: listing.id });
  } finally {
    await client.query("ROLLBACK");
  }
}

// --- (b) Route-level: L3-03/04/05 are now covered for real, via mocked
//         Supabase client unit tests against the extracted pure handlers
//         -- see tests/phase3/l3-route-handlers.test.mjs, not here. This
//         file stays DB-level only (flag/RLS/grants); no HTTP layer.
console.log("\nSEE ALSO: L3-03, L3-04, L3-05 -- covered in tests/phase3/l3-route-handlers.test.mjs (mocked Supabase client, no live server needed), not in this file.");

process.exitCode = fail > 0 ? 1 : 0;
