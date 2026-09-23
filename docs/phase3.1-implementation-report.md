# Chatmarket 2.0 — Phase 3.1 Implementation Report

**Baseline:** architecture v10 (locked). **Status:** implemented and tested in a
throwaway environment. **Not applied to production. Feature flag OFF.**
No deployment, no production-data mutation.

Evidence classes (unchanged from v10): **R** repository · **D** Supabase
documentation · **P** prior/live observation · **I** inference/unverified.
Verification levels used below: **implemented** · **locally verified** (throwaway
local PostgreSQL) · **database verified** (real Supabase, guaranteed-rollback dry
run) · **not verified**.

---

## 0. Read this first

1. **Scope.** The handoff omits v6/v7 and tests 1–30. Where v10 is silent I took the
   most restrictive option and listed it (§14, §15) instead of inventing
   architecture.
2. **Repository HEAD could not be inspected** (the GitHub remote is private, and the
   nested `.git` in the snapshot holds one stub commit). Everything was built and
   diffed against the supplied snapshot. Please diff the delivered files against
   your real HEAD.
3. **What "passed" means.** Local results come from PostgreSQL 16.15 with a
   Supabase-equivalent shim, and from PostgREST 12.2.3 (not Supabase's gateway).
   Supabase-specific privilege behaviour was confirmed separately on the real
   project via a dry run that rolled back everything it did.

## 1. Files changed

**Modified (1 of the original files):** `lib/validation/shared.js` — step
`timeoutSeconds` default 120 → 90 (D-1; comment explains why). `.max(3600)` is
unchanged.

**New:**
- `supabase/migrations/20260920100000_create_private_feature_flags.sql`
- `supabase/migrations/20260920100100_add_system_ceilings_and_config_assertion.sql`
- `supabase/migrations/20260920100200_add_execution_columns_and_l2_trigger.sql`
- `supabase/migrations/20260920100300_add_retry_or_fail_step_and_worker_wrapper.sql`
- `supabase/migrations/20260920100400_add_run_lifecycle_functions.sql`
- `lib/execution/ceilings.js`, `lib/execution/executability.js`
- `tests/phase3/` (L1 tests, fixture, DB suite, Data API suite, local-DB setup and shim, README)
- `docs/phase3.1-implementation-report.md` (this report)

**Verified by diff against the pristine snapshot:** exactly one original file
changed (`shared.js`); `app/`, `components/`, `middleware.js`, `package.json`,
`package-lock.json`, `next.config.js`, `lib/supabase/`, `lib/domain/` are
byte-identical.

## 2. Database changes (all additive)

| Object | Purpose |
| --- | --- |
| `private.feature_flags` (+ `private.is_execution_enabled()`) | Fail-closed flag, seeded **OFF** (`phase3_execution`). No privileges for any client or service role. |
| `private.system_ceilings()` | The ceiling constants (SQL side of D-3). |
| `private.assert_execution_config_within_ceilings(jsonb)` | The L2 assertion, reused by L3. SQLSTATE `CM001` = exceeds, `CM002` = malformed. |
| `runs.execution_config jsonb`, `run_steps.retry_count integer not null default 0` | Frozen plan; retry counter and fencing token. |
| Trigger `runs_enforce_execution_config` | L2 on insert; makes `execution_config` immutable (`CM003`). |
| `private.retry_or_fail_step` | The single authoritative retry/failure transition. |
| `public.worker_retry_or_fail_step` | W1 wrapper. |
| `private.create_run / claim_next_step / checkpoint_step / cancel_run / decide_approval / recover_stale_run / fail_run_closed` | Minimal lifecycle so the fencing, ceilings and lock order are exercised. **Owner-only; no client exposure.** |

## 3. L1 / L2 / L3 (policy: REJECT, NEVER CLAMP)

- **L1** — `lib/execution/executability.js`: runs after Zod, returns ok or a list of
  violations, and never returns a modified configuration. Nothing inside a step's
  free-form `config` is ever read as a limit.
- **L2** — trigger on `runs` (D-3). It covers the run-creation function **and**
  any direct privileged write (verified with a `service_role` INSERT).
- **L3** — `claim_next_step` and `checkpoint_step` re-assert the frozen config and
  fail the run closed; `retry_or_fail_step` fails a step terminally if the frozen
  `retryLimit` exceeds 1. Cost is checked twice, independently (frozen limit, then
  the constant ₹50). Output ceilings use constants only.
- Reason strings are machine-readable: `config_exceeds_system_ceiling:<field>`,
  `config_invalid_for_execution:<field>`, `output_limit_exceeded:step|run`,
  `cost_limit_exceeded`.

## 4. Retry implementation

`retry_or_fail_step(run_id, step_id, expected_retry_count, error)` — plain PL/pgSQL
function, no transaction control. Sequence exactly as v8 §1: lock `runs` → verify
`running` → verify `step.run_id = run_id` → verify step `running` → verify
`retry_count = expected` → frozen `retryLimit` via `execution_config -> 'steps' ->
step_index` (never the UUID) → `running→pending` (retry_count + 1) or
`running→failed` with run finalization in the same transaction. Limit 1 gives
exactly one retry; limit 0 fails at once; a limit above 1 fails closed and is
**not** clamped.

## 5. W1 privilege boundary

- `private.retry_or_fail_step`: `SECURITY DEFINER`, `SET search_path = ''`, fully
  schema-qualified, no dynamic SQL; `EXECUTE` owner-only (revoked from PUBLIC,
  anon, authenticated **and service_role**).
- `public.worker_retry_or_fail_step`: thin single-statement definer wrapper;
  `EXECUTE` = `service_role` + owner; revoked from PUBLIC, anon, authenticated.
- The credential boundary is possession of the server-side secret key
  (`service_role`); the database does not distinguish trusted backend components
  holding it (v10 §2.2).

## 6. Recovery

`recover_stale_run(run_id)`: the only input is the run id; the stale step and its
`retry_count` are read from the database (stale = running longer than 120 s) and
handed to the same `retry_or_fail_step`. **Not implemented:** recovery's approval
mismatch check (see §14).

## 7. Frozen execution configuration

`create_run` copies `listings.configuration` into `runs.execution_config` and the L2
trigger asserts it. Nothing in execution reads `listings.configuration` again.
Verified by test 32: reordering/editing the listing changes nothing for existing
runs, and `UPDATE ... SET execution_config` is rejected even for the owner and for
a bypass-RLS `service_role`.

## 8–9. Tests executed and results

| Suite | Environment | Result |
| --- | --- | --- |
| L1 (JS) `tests/phase3/ceilings.test.mjs` | Node | **47 / 47 pass** |
| DB suite `run_db_tests.py` | local PG 16.15 | **36 pass, 0 fail, 2 not implemented** |
| Data API `run_dataapi_tests.py` | local PG + real PostgREST 12.2.3 | **21 / 21 pass** |
| Phase 1 regression | Node | 41 / 41 (24 + 17) |
| Phase 2 regression | Node | 42 / 42 (12 + 12 + 7 + 4 + 7) |
| `next build` | Next 14.2.35 | succeeds, 28 static pages generated |
| Real-Supabase dry run (rolled back) | production project, read/rolled-back only | all checks as expected (§10) |

**Gate mapping.** 31 (60+60 concurrent trials, both real calling paths, no partial
state ever observed), 32, 33 (120 concurrent trials, zero deadlocks, static
lock-order audit, and control 33b proving the harness detects a deadlock), 34–37,
38 (config half), 39, 40 (L2 via the real path; L3 with L2 bypassed in the isolated
DB; control shows the same seed is rejected when L2 is active; retryLimit 3 fails
terminally without retry; `maxCostInr` 100 cannot execute beyond ₹50), 41 (JS ↔ SQL
parity), 42, 43, 44, 45, 46, 47, 48. Supplemental `S-*` tests cover the flag, quota
(including a 30-way race → exactly 20 runs), entitlement gating, ownership,
stale-worker fencing, cancellation fencing, RLS, and end-to-end.

**Not runnable / not implemented (stated plainly):**
- **Tests 1–30** — specification not in the handoff.
- **Test 38 runtime half** (`timed_out` on cumulative active processing) — no
  accounting method is specified; the config ceiling is enforced at L1/L2/L3.
- **Data-API test against Supabase's own gateway** — not possible; PostgREST used.

**Mutation testing (do the tests fail when the code is wrong?)** Eight
non-equivalent mutants were introduced and **all eight were caught**: fence check
removed (S-7, 47); retry clamp instead of fail (40); L2 insert check removed
(34, S-5, 40); run-status check removed (S-6); step-ownership check removed (S-8);
`service_role` granted the private function (43, 44, 48); PUBLIC not revoked (43,
48); wrapper left open to anon (43, 44, 47, 48). One further mutant survived and is
*equivalent* (removing a no-op revoke).

**Harness defects found and fixed during the run** (none were product defects): a
barrier that hung test 31, a fixture writing `auth.users` as the wrong role, a
too-strict message expectation for a config that violates two ceilings, an
`auth.uid()` shim that ignored PostgREST's JSON claims, and two static-scan false
positives.

## 10. Security verification

**Database verified (real Supabase, rolled back).** One `DO` block applied all five
migrations then raised a forced exception, so PostgreSQL discarded everything.
Results: owner `postgres`; private functions executable by **no** anon/authenticated/
service_role and **not** by PUBLIC; one overload; wrapper executable by
service_role and owner only, not by PUBLIC; `USAGE` on `private` false for all
three; `private.feature_flags` privileges none; anon and authenticated denied on the
wrapper and on the private function; **service_role denied on the private function
and allowed on the wrapper** (`rejected:run_not_found`); L2 rejected an over-ceiling
config, a NULL config, and a direct `service_role` insert; at-ceiling accepted;
`execution_config` immutable; `create_run` refused while the flag is OFF.
**Post-check:** 0 new functions, 0 `private` tables, 0 new columns, 0 triggers,
0 runs, 45 migrations, 15 playbook listings — production unchanged.

**Locally verified:** the same matrix plus `search_path` hijack resistance (hostile
schema and `pg_temp` shadows never used), `EXECUTE` revocation as an *independent*
barrier (still closed even if schema `USAGE` were granted), definition audit, and
drift detection.

**Not verified:** the Supabase gateway's secret-key handling (D-class fact only);
the project's *exposed schemas* setting (I).

## 11. Feature-flag status

**OFF.** Seeded OFF by migration; the suite restores OFF; no application code
references `feature_flags`; production was never touched. Activation is manual and
still requires your explicit approval.

## 12. D-1 status

Changed the Phase 1 step `timeoutSeconds` default to 90 (forward-looking only).
No rows migrated. **Live check:** 15 listings, all `playbook`, no Workflow/Agent
rows, so no existing data is affected. A legacy stored `timeoutSeconds: 120` is
rejected, never rewritten or clamped (tested). **Needs your approval** because it
edits a closed Phase 1 file.

## 13. D-3 implementation choice

L2 = `BEFORE INSERT OR UPDATE OF execution_config` trigger on `runs` calling one SQL
assertion; ceilings = SQL immutable function mirrored in JS, parity-tested, stored
in no table. Chosen because it covers every write path, not only one function.

## 14. Deviations and gaps from v10 (none silent)

- **Not implemented (input or another phase needed):** T1/T2/T3 dispatch triggers
  (`pg_net` is not installed live); the Edge Function worker and AI provider (3.2);
  approval pause/resume and recovery's approval-mismatch check (`approvals` has no
  step link; Phase 1 docs place approvals in Phase 4; only a decision-only
  `decide_approval` exists); idempotent "matching run" lookup and `usage_events`
  writes (v6/v7 not provided); 300 s active-time accounting.
- **Exposure:** v9 §2.5 leaves open whether other functions get wrappers. All are
  private, owner-only. No client-callable create/cancel/claim/checkpoint/approval
  entry point exists. Only the retry wrapper is exposed.
- **Test 35 differs from v10's wording on one point, by design:** after D-1(ii), an
  omitted step timeout defaults to 90 and is *accepted*; a stored 120 is rejected.
- **Interpretation choices** (confirm): 50/200 KB = 51,200/204,800 bytes; "per day"
  = rolling 24 h; stale threshold 120 s; `create_run` requires an active
  entitlement, or owner sandbox; extra code `config_invalid_for_execution`;
  `create_run` reads the listing configuration itself instead of trusting a
  caller-supplied one.

## 15. Issues requiring your decision

1. **Approve** the `shared.js` D-1 edit (Phase 1 file).
2. **Approve applying the migrations to production.** Repo names use `20260920…`;
   Supabase assigns its own versions on apply (the Phase 1 files differ the same
   way: repo `20260915…`, live `20260916…`).
3. **Provide v6/v7 / tests 1–30**, and decide the open items in §14 (exposure of the
   other functions, approval semantics, active-time accounting).
4. **Confirm the interpretation choices** in §14.
5. **Pre-existing findings, not changed** (no unrelated changes): `anon` and
   `authenticated` hold table-level INSERT/UPDATE/DELETE/**TRUNCATE** on `runs` and
   `run_steps`, blocked only by RLS (TRUNCATE is not exposed by the Data API but
   is not subject to RLS); several existing `private` trigger functions have no
   ACL and rely solely on the missing schema `USAGE`; **`listings.configuration`
   is publicly readable for live listings** (policy "Live listings are publicly
   readable", anon + authenticated, all columns), so any prompt templates a seller
   puts in step `config` are world-readable today. A run's owner can likewise
   read its frozen `execution_config` (tested locally); for a live listing that is
   nothing new, but it is worth deciding whether seller prompt IP needs protection.
6. **Diff against your real repository HEAD** (not inspectable here).
