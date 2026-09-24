// L2 — private.assert_execution_config_within_ceilings() and the
// runs_enforce_execution_config trigger. These are REAL, deployed,
// verified-live (Gate 6) objects — this file tests them for real, not a
// mock.
//
// REQUIRES: a direct Postgres connection string with owner/postgres-level
// privilege in process.env.DATABASE_URL (the anon/service_role Supabase
// client cannot call this function -- it's owner-only by design, per
// v9 §2.2 / v10 §2.3). Every test runs inside BEGIN ... ROLLBACK so
// nothing persists, matching this project's established Phase 1/2
// rolled-back-transaction methodology. If DATABASE_URL is unset, this
// file prints a clear message and exits without pretending to have run.
//
// NOT EXECUTED BY ME in this environment -- I have Supabase MCP
// (execute_sql) access, not a raw DATABASE_URL. Grounded in the real SQL
// text of 20260920100100_add_system_ceilings_and_config_assertion.sql
// and 20260920100200_add_execution_columns_and_l2_trigger.sql, both
// confirmed executed against production in Gate 6.

import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.log("SKIPPED: DATABASE_URL not set. This file needs a direct, owner-level Postgres connection string -- see file header.");
  process.exit(0);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

let pass = 0, fail = 0;
async function checkRaises(name, cfgLiteral, expectedCode) {
  try {
    await client.query("BEGIN");
    await client.query(`select private.assert_execution_config_within_ceilings($1::jsonb)`, [cfgLiteral]);
    fail++; console.log("FAIL (did not raise):", name);
  } catch (e) {
    const ok = e.code === expectedCode;
    if (ok) { pass++; console.log("PASS:", name); }
    else { fail++; console.log(`FAIL (wrong code, got ${e.code} want ${expectedCode}):`, name); }
  } finally {
    await client.query("ROLLBACK");
  }
}
async function checkPasses(name, cfgLiteral) {
  try {
    await client.query("BEGIN");
    await client.query(`select private.assert_execution_config_within_ceilings($1::jsonb)`, [cfgLiteral]);
    pass++; console.log("PASS:", name);
  } catch (e) {
    fail++; console.log(`FAIL (raised ${e.code} unexpectedly):`, name);
  } finally {
    await client.query("ROLLBACK");
  }
}

const validStep = { retryLimit: 0, timeoutSeconds: 30 };
const validCfg = { steps: [validStep], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } };

await checkRaises("L2-01 NULL config raises CM002", null, "CM002");
await checkRaises("L2-02 non-object config raises CM002", "not-an-object", "CM002"); // note: cast will fail differently if not valid jsonb; adjust if needed
await checkRaises("L2-03 missing steps raises CM002", { limits: validCfg.limits }, "CM002");
await checkRaises("L2-04 empty steps array raises CM002", { ...validCfg, steps: [] }, "CM002");
await checkRaises("L2-05 missing limits raises CM002", { steps: [validStep] }, "CM002");
await checkRaises("L2-06 limits.maxSteps > 10 raises CM001", { steps: [validStep], limits: { maxSteps: 11, maxCostInr: 10, timeoutSeconds: 60 } }, "CM001");
await checkRaises(
  "L2-07 steps.length > 10 raises CM001",
  { steps: Array(11).fill(validStep), limits: { maxSteps: 11, maxCostInr: 10, timeoutSeconds: 60 } },
  "CM001"
);
await checkRaises(
  "L2-08 steps.length > limits.maxSteps raises CM001 (self-inconsistent plan)",
  { steps: [validStep, validStep], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } },
  "CM001"
);
await checkRaises("L2-09 limits.maxCostInr > 50 raises CM001", { steps: [validStep], limits: { maxSteps: 1, maxCostInr: 51, timeoutSeconds: 60 } }, "CM001");
await checkRaises("L2-10 limits.timeoutSeconds > 300 raises CM001", { steps: [validStep], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 301 } }, "CM001");
await checkRaises("L2-11 step.retryLimit > 1 raises CM001", { steps: [{ ...validStep, retryLimit: 2 }], limits: validCfg.limits }, "CM001");
await checkRaises("L2-12 step.timeoutSeconds > 90 raises CM001", { steps: [{ ...validStep, timeoutSeconds: 91 }], limits: validCfg.limits }, "CM001");
await checkPasses("L2-boundary a valid, at-ceiling config does not raise", {
  steps: [{ retryLimit: 1, timeoutSeconds: 90 }],
  limits: { maxSteps: 10, maxCostInr: 50, timeoutSeconds: 300 },
});

// L2-13 / L2-14: exercise the actual trigger on public.runs, with a
// throwaway fixture user + listing created and rolled back in the same
// transaction.
async function withFixture(fn) {
  await client.query("BEGIN");
  try {
    const uid = "00000000-0000-0000-0000-00000000ffff";
    await client.query(
      `insert into auth.users (id, email) values ($1, 'gate7-fixture@example.invalid') on conflict (id) do nothing`,
      [uid]
    );
    const { rows: [listing] } = await client.query(
      `insert into public.listings (title, model, category, price, seller_name, seller_id, status)
       values ('Gate7 fixture', 'n/a', 'n/a', 0, 'fixture', $1, 'pending_review') returning id`,
      [uid]
    );
    await fn({ uid, productId: listing.id });
  } finally {
    await client.query("ROLLBACK");
  }
}

await withFixture(async ({ uid, productId }) => {
  try {
    await client.query(
      `insert into public.runs (user_id, product_id, product_version, execution_config) values ($1, $2, 1, $3::jsonb)`,
      [uid, productId, JSON.stringify({ steps: [], limits: validCfg.limits })] // invalid: empty steps
    );
    fail++; console.log("FAIL (did not raise): L2-13 trigger blocks invalid execution_config on INSERT");
  } catch (e) {
    if (e.code === "CM002") { pass++; console.log("PASS: L2-13 trigger blocks invalid execution_config on INSERT"); }
    else { fail++; console.log(`FAIL (wrong code ${e.code}): L2-13`); }
  }
});

await withFixture(async ({ uid, productId }) => {
  const { rows: [run] } = await client.query(
    `insert into public.runs (user_id, product_id, product_version, execution_config) values ($1, $2, 1, $3::jsonb) returning id`,
    [uid, productId, JSON.stringify(validCfg)]
  );
  try {
    await client.query(`update public.runs set execution_config = $1::jsonb where id = $2`, [JSON.stringify({ ...validCfg, limits: { ...validCfg.limits, maxCostInr: 5 } }), run.id]);
    fail++; console.log("FAIL (did not raise): L2-14 execution_config is immutable after insert");
  } catch (e) {
    if (e.code === "CM003") { pass++; console.log("PASS: L2-14 execution_config is immutable after insert"); }
    else { fail++; console.log(`FAIL (wrong code ${e.code}): L2-14`); }
  }
});

console.log(`\nL2: ${pass} passed, ${fail} failed`);
await client.end();
