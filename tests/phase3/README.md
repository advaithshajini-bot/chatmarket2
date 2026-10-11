# Phase 3 — 48-Test Gate Matrix

This is Part 1 of Phase 3.2: the test **structure**, grounded in what's
actually deployed (verified in Gate 6), not the architecture doc's
abstractions. No implementation code (routes, worker) exists yet — that's
Part 2/3. This matrix and the 4 test files exist so the gate's shape can be
reviewed before that code is written.

## Status legend

- **RUNNABLE NOW** — tests real, already-deployed database objects. Needs a
  direct Postgres connection (not the Supabase JS client — the functions
  under test are owner-only / `service_role`-only, so a `service_role` or
  `postgres`-privileged connection string is required, in a rolled-back
  transaction, the same methodology this project used for the Phase 1/2
  test suites). **Not run by me** — I have `execute_sql` (Supabase MCP)
  access in this environment, not a raw Postgres connection string, so I
  wrote these against what I've already directly verified in Gate 6, but
  actually executing this file requires your own `DATABASE_URL`.
- **BLOCKED — Part 2** — needs the API routes (run initiation / step
  execution) that don't exist yet.
- **BLOCKED — Part 3** — needs the worker (Edge Function) that doesn't
  exist yet.
- **KNOWN GAP** — the ceiling/behavior being tested has no enforcement
  anywhere in the deployed code yet. These are written as tests that
  *should* pass once enforcement exists, and will currently fail honestly
  (not silently skip) if run.

## L1 — Validation (12 tests) — `lib/execution/` doesn't exist yet

| # | Test | Status |
|---|---|---|
| L1-01 | Rejects config missing `steps` | BLOCKED — Part 3 |
| L1-02 | Rejects `steps` as non-array | BLOCKED — Part 3 |
| L1-03 | Rejects empty `steps` array | BLOCKED — Part 3 |
| L1-04 | Rejects config missing `limits` | BLOCKED — Part 3 |
| L1-05 | Rejects `limits.maxSteps` non-integer or < 1 | BLOCKED — Part 3 |
| L1-06 | Rejects `limits.maxSteps` > 10 (never clamps to 10) | BLOCKED — Part 3 |
| L1-07 | Rejects `steps.length` > `limits.maxSteps` | BLOCKED — Part 3 |
| L1-08 | Rejects `limits.maxCostInr` <= 0 or > ₹50 | BLOCKED — Part 3 |
| L1-09 | Rejects `limits.timeoutSeconds` > 300 | BLOCKED — Part 3 |
| L1-10 | Rejects any `step.retryLimit` > 1 | BLOCKED — Part 3 |
| L1-11 | Rejects any `step.timeoutSeconds` > 90 | BLOCKED — Part 3 |
| L1-12 | Accepts a minimal config at exactly-at-ceiling values | BLOCKED — Part 3 |

## L2 — Database assertion (14 tests) — real, deployed, testable today

| # | Test | Status |
|---|---|---|
| L2-01 | `assert_execution_config_within_ceilings(NULL)` raises `CM002` | RUNNABLE NOW |
| L2-02 | Non-object config raises `CM002` | RUNNABLE NOW |
| L2-03 | Missing/non-array `steps` raises `CM002` | RUNNABLE NOW |
| L2-04 | Empty `steps` array raises `CM002` | RUNNABLE NOW |
| L2-05 | Missing/non-object `limits` raises `CM002` | RUNNABLE NOW |
| L2-06 | `limits.maxSteps` > 10 raises `CM001` (not clamped) | RUNNABLE NOW |
| L2-07 | `steps.length` > 10 raises `CM001` | RUNNABLE NOW |
| L2-08 | `steps.length` > `limits.maxSteps` raises `CM001` (self-inconsistent plan) | RUNNABLE NOW |
| L2-09 | `limits.maxCostInr` > 50 raises `CM001` | RUNNABLE NOW |
| L2-10 | `limits.timeoutSeconds` > 300 raises `CM001` | RUNNABLE NOW |
| L2-11 | Any `step.retryLimit` > 1 raises `CM001` | RUNNABLE NOW |
| L2-12 | Any `step.timeoutSeconds` > 90 raises `CM001` | RUNNABLE NOW |
| L2-13 | `INSERT` into `runs` with an invalid `execution_config` is blocked by the L2 trigger | RUNNABLE NOW |
| L2-14 | `UPDATE` changing an already-set `execution_config` raises `CM003` (immutability) | RUNNABLE NOW |

## L3 — Runtime fail-closed (14 tests) — no routes exist yet

| # | Test | Status |
|---|---|---|
| L3-01 | `is_execution_enabled()` returns `false` when the flag row is missing (fail-closed) | RUNNABLE NOW (direct SQL) |
| L3-02 | `is_execution_enabled()` returns `false` when `enabled = false` (current live state) | RUNNABLE NOW |
| L3-03 | Run-initiation route returns 403/503 while `phase3_execution = false` | BLOCKED — Part 2 |
| L3-04 | Route never calls `private.create_run` when the flag is false | BLOCKED — Part 2 |
| L3-05 | Route checks the flag via `is_execution_enabled()`, not a client-side/env-var copy | BLOCKED — Part 2 |
| L3-06 | Non-owner cannot `select` another user's `runs` row (RLS) | RUNNABLE NOW |
| L3-07 | Non-owner cannot `select` another user's `run_steps` (RLS via `can_view_run`) | RUNNABLE NOW |
| L3-08 | `anon` cannot call `worker_retry_or_fail_step` | RUNNABLE NOW |
| L3-09 | `authenticated` cannot call `worker_retry_or_fail_step` | RUNNABLE NOW |
| L3-10 | `anon`/`authenticated` cannot call `private.retry_or_fail_step` directly | RUNNABLE NOW |
| L3-11 | Product owner can view runs of their own product, cannot mutate them | RUNNABLE NOW |
| L3-12 | `maxRunsPerUserPerDay` (20) is enforced somewhere before run creation | **KNOWN GAP** |
| L3-13 | `maxStepOutputBytes` (50KB) is enforced somewhere | **KNOWN GAP** |
| L3-14 | `maxRunOutputBytes` (200KB) is enforced somewhere | **KNOWN GAP** |

## W1 — Worker boundary (8 tests)

| # | Test | Status |
|---|---|---|
| W1-01 | `private.retry_or_fail_step`: zero EXECUTE grants to anon/authenticated/service_role | RUNNABLE NOW (already verified Gate 6; codified here as an automated test) |
| W1-02 | `public.worker_retry_or_fail_step`: EXECUTE granted only to `service_role` + owner | RUNNABLE NOW |
| W1-03 | Both functions are `SECURITY DEFINER` | RUNNABLE NOW |
| W1-04 | Both functions have `search_path = ''` | RUNNABLE NOW |
| W1-05 | A real worker process, authenticated via the `service_role` key, successfully calls `worker_retry_or_fail_step` | BLOCKED — Part 3 (no worker deployed) |
| W1-06 | Fencing: stale `expected_retry_count` returns `{outcome:'rejected', reason:'fencing_mismatch'}`, mutates nothing | RUNNABLE NOW (rolled-back transaction) |
| W1-07 | Retry ceiling: after `max_retries`, next failure goes `running→failed` and finalizes the run in the same transaction | RUNNABLE NOW |
| W1-08 | Lock ordering: concurrent `retry_or_fail_step` calls on the same run serialize without deadlock (runs locked first) | **BLOCKED — needs a real concurrency harness** (a single-connection script, which is all this file is, structurally cannot exercise or detect a race/deadlock; writing a fake-passing version of this test would be worse than leaving it honestly blocked) |

## How to run everything

    node tests/phase3/run-all.mjs            # full gate, SKIPPED = not passed
    node tests/phase3/run-all.mjs --verbose  # print every line
    node tests/phase3/run-all.mjs --allow-skip  # deliberately partial (no credentials)

Env vars for a full run: DATABASE_URL (owner-level, session-mode connection),
EXECUTION_WORKER_URL, WORKER_SHARED_SECRET. Each file also runs on its own
(`node tests/phase3/<file>`) and exits non-zero if any check fails.

`node --test tests/phase3/*.test.mjs` is deliberately not used: cmd.exe does not
expand the glob, and these are plain scripts (not node:test suites), so it could
only report per-file pass/fail, not per-check results.

## Coverage of the 48 matrix IDs, by evidence (2026-09-28)

| IDs | Covered by | Evidence |
|---|---|---|
| L1-01..12 | l1-validation | executed 12/12 (sandbox + your run) |
| L2-01..14 (+boundary check) | l2-database-assertion | executed 15/15 (your run; also 15/15 against a local copy of the real SQL, sandbox) |
| L3-01, L3-02, L3-06, L3-07, L3-08/09/10, L3-11 | l3-runtime-failclosed | executed 7/7 (your run; also 7/7 locally) -- L3-07 (run_steps RLS) is included in this count now |
| L3-03, L3-04, L3-05 | l3-route-handlers (mocked client) | executed 20/20 (sandbox) |
| **L3-12, L3-13, L3-14** | **l3-ceilings** | **executed 21/21 against a local copy of the real, unmodified migration SQL (sandbox) -- see method below. Not yet run against your live DB.** |
| W1-01..04, W1-06, W1-07, W1-08 | w1-worker-boundary | executed 8/8 (your run; also locally) |
| W1-05 | w1-worker-boundary | executed against your live worker once you set EXECUTION_WORKER_URL + WORKER_SHARED_SECRET (not in the "8 passed" run) |

**48/48 IDs now have a test that has executed and passed, in at least one
environment.** L3-12/13/14 are the exception: proven against a faithful local
copy of your real SQL, not yet against your actual live database -- that's the
one thing still worth running for real before calling this closed.

### How l3-ceilings.test.mjs was actually verified (not just written)

1. Installed a disposable local Postgres and loaded ALL of `supabase/migrations/`
   in order, unmodified byte-for-byte -- the same baseline, the same 5 Phase 3.1
   files, the same wrappers, the same dispatch trigger.
2. Ran the three existing DB-backed suites (L2, L3-runtime, W1) against that
   local copy first, as a calibration -- they reproduced your exact live
   numbers (15/15, 7/7, 8/8-with-W1-05-skipped), which is what made the local
   copy trustworthy enough to test new code against.
3. Wrote l3-ceilings.test.mjs, ran it: 21/21 real passes against the real,
   unmodified `create_run` / `checkpoint_step` logic.
4. **Mutation-tested it**: temporarily broke the real local functions 6
   different ways (each system ceiling off by one in both directions, an
   off-by-one in create_run's own comparison, and an injected exception after
   the flag is switched on) and re-ran the file after each. All 6 broke the
   test with a clear FAIL naming the exact wrong ceiling -- confirming the
   test would actually catch a real regression, not just pass by construction.
   One of the 6 mutations (M1, the quota ceiling) initially only produced 1
   failing assertion instead of 2, because the row-count check ran after a
   `ROLLBACK TO SAVEPOINT` that had already erased the wrongly-created row --
   a vacuous check. Fixed by moving the count to before the rollback; re-ran
   mutation M1 and confirmed it now fails both assertions as it should.
   Original code restored and reverted to 21/21 after every mutation.
5. Local Postgres crashed once between the mutation run and the final
   calibration (a sandbox resource limit, unrelated to the tests) -- restarted
   it and re-verified the database state (flag, fixture rows, trigger) was
   intact before re-running, rather than assuming it was fine.
6. Final full-suite run against the local copy: **83 individual assertions,
   0 failures**, only W1-05 skipped (needs a real network call this sandbox
   can't make). Confirmed no leaked fixture data or flag state afterward.

### Safety design specific to this file
- The ONLY flag write in the whole test suite lives in the L3-12 section, and
  it's inside that section's own `BEGIN...ROLLBACK`.
- `section()` wraps every block in try/catch/finally with the ROLLBACK in
  `finally`, so a throwing assertion cannot skip it -- proven by mutation M6,
  which injects an exception specifically after the flag is turned on.
- MVCC isolation is verified with a **second, independent connection**
  reading the flag while the first has it ON in an uncommitted transaction --
  not just assumed.
- The file refuses to even start if the flag isn't already OFF, and re-checks
  with a brand-new connection at the end that the COMMITTED flag is still OFF.
- The dispatch trigger fires during the L3-12a case (a real INSERT into
  `run_steps`); the file checks afterward that no `pg_net` request actually
  escaped the rolled-back transaction, rather than assuming pg_net's queue
  insert is transactional.


Note: l2/l3-runtime/w1 were edited after their last live run (exit-code fix;
L3-07 added; pass/fail scoping in l3). They are syntax-checked but need a re-run
against the live DB to confirm no regression.
