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

## Totals (corrected after actually writing the files, not just planning the matrix)

- **20 RUNNABLE NOW** — 14 L2 + 2 L3 (flag fail-closed) + 3 L3 (RLS/grants) + 1... see each file; exact per-file pass/fail is what running them will report, this count is what the tests are *written* to be able to prove, not a guarantee they'll pass
- **1 discovered while writing, not while planning**: W1-08 moved from "RUNNABLE NOW" (in the original plan) to BLOCKED once I actually tried to write it — a real reminder that a test spec looking reasonable on paper isn't the same as it being honestly implementable
- **24 BLOCKED** pending Part 2 (routes) or Part 3 (worker/validation module)
- **3 KNOWN GAPS** — ceilings with no enforcement anywhere yet, not a test-writing problem

None of the RUNNABLE NOW tests were actually executed by me in this environment — I have `execute_sql` (Supabase MCP), not a raw `DATABASE_URL`/`pg` connection, which these files are written against (matching this project's established Phase 1/2 rolled-back-transaction methodology). Everything they assert is grounded in what Gate 6 already directly verified, but running the files themselves is on you.
