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

if (!process.env.DATABASE_URL) {
  console.log("SKIPPED (a)+(c): DATABASE_URL not set.");
} else {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let pass = 0, fail = 0;

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
  await withRlsFixture(client, async ({ ownerUid, otherUid, runId, productId }) => {
    await asUser(client, otherUid, async () => {
      const { rows } = await client.query(`select id from public.runs where id = $1`, [runId]);
      if (rows.length === 0) { pass++; console.log("PASS: L3-06 non-owner cannot select another user's run"); }
      else { fail++; console.log("FAIL: L3-06 -- non-owner could read another user's run"); }
    });
    await asUser(client, ownerUid, async () => {
      const { rows } = await client.query(`select id from public.runs where id = $1`, [runId]);
      if (rows.length === 1) { pass++; console.log("PASS: L3-11 owner can select their own run"); }
      else { fail++; console.log("FAIL: L3-11 -- owner could not read their own run"); }
    });
  });

  // L3-12 / L3-13 / L3-14: KNOWN GAPS -- no enforcement exists for these
  // three ceilings anywhere (confirmed: not in the L2 function, no route
  // exists to enforce them at L1/L3 either). Written to fail loudly.
  fail++; console.log("FAIL (KNOWN GAP, not a test bug): L3-12 maxRunsPerUserPerDay is not enforced anywhere yet");
  fail++; console.log("FAIL (KNOWN GAP, not a test bug): L3-13 maxStepOutputBytes is not enforced anywhere yet");
  fail++; console.log("FAIL (KNOWN GAP, not a test bug): L3-14 maxRunOutputBytes is not enforced anywhere yet");

  console.log(`\nL3 (a)+(c): ${pass} passed, ${fail} failed (3 of the failures are the known, documented gaps above, not test defects)`);
  await client.end();
}

async function asUser(client, uid, fn) {
  await client.query("BEGIN");
  try {
    await client.query(`set local role authenticated`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await fn();
  } finally {
    await client.query("reset role");
    await client.query("ROLLBACK");
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
    await fn({ ownerUid, otherUid, runId: run.id, productId: listing.id });
  } finally {
    await client.query("ROLLBACK");
  }
}

// --- (b) Route-level, BLOCKED until Part 2 builds the run-initiation route ---
const ROUTE_URL = null; // set once the route exists, e.g. "/api/runs"
if (!ROUTE_URL) {
  console.log("\nSKIPPED (b): L3-03, L3-04, L3-05 -- no run-initiation route exists yet. Nothing to send a request to.");
} else {
  // L3-03: POST ROUTE_URL with a valid session while phase3_execution=false
  //        expect 403 or 503, never 200/201.
  // L3-04: same, plus assert (via a DB-level check afterward) that no new
  //        row was written to public.runs -- proves the route short-
  //        circuited before calling private.create_run, not just that it
  //        returned an error status after calling it.
  // L3-05: source-scan the route file (see tests/phase2/guardrails.test.mjs
  //        for the pattern) to confirm it calls is_execution_enabled()
  //        via an RPC, not a hardcoded/env-var copy of the flag.
}
