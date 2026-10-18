# Phase 6 · Running the full database-backed test suite (1,133 tests)

`node tests/phase5/run-all.mjs` with **no** `DATABASE_URL` only runs the offline suites (static, logic, fake-Razorpay) and **skips** the database ones. Those skipped suites hold
the security checks (admin + MFA refusals, seller isolation, no leaks to sellers, one-transfer-per-purchase, concurrency). To get full coverage point `DATABASE_URL` at an **empty
scratch Postgres** or an **empty Supabase branch** — **never production** (the integration/concurrency suites commit rows, then delete them).

**Safety net:** `run-all.mjs` now refuses to start if the database already has any `public.purchases` or `public.listings` rows ("REFUSING TO RUN", exit 2). Override with
`PHASE5_ALLOW_NONEMPTY=1` only for a database you are certain is throwaway.

Expected result: `TOTAL: 1133 passed, 0 failed` (the exact number grows as tests are added; what matters is **0 failed and no SKIPPED**).
Not included: the Phase 4 worker-contract suite (`node tests/phase4/run-all.mjs`) needs `deno` on PATH; run it separately where Deno is installed.

## Option 1 (recommended): local scratch Postgres 16 — the setup the 1,133 were run on
Needs Postgres 16 client + server tools (`psql`, `createdb`, `dropdb`) and Node 20+.
```bash
# 1. a throwaway server (any Postgres 16; Docker shown)
docker run -d --name cm-scratch -e POSTGRES_PASSWORD=scratch -p 54329:5432 postgres:16
export PGHOST=localhost PGPORT=54329 PGUSER=postgres PGPASSWORD=scratch

# 2. build the scratch database: a minimal Supabase stand-in (roles, auth, storage, pg_net) + ALL your real migrations, in order
bash tests/phase5/scratch/build-real.sh cm_test supabase/migrations
#    -> "scratch db cm_test ready"   (any error prints "FAILED: <migration file>")

# 3. run everything, including the concurrency suites
npm ci                      # installs pg
export DATABASE_URL="postgresql://postgres:scratch@localhost:54329/cm_test"
PHASE5_CONCURRENCY_TESTS=1 node tests/phase5/run-all.mjs
```
Notes
- The stub (`tests/phase5/scratch/min-stub.sql`) imitates Supabase (roles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`, `storage`, a fake `pg_net`/vault). It is NOT Supabase itself.
- If you use a Postgres you did not create with `docker run`, make sure the connecting user can `CREATE ROLE` and `CREATE DATABASE` (the stub creates the three API roles).
- To re-run from a clean state: repeat step 2 (it drops and recreates the database).
- Clean up: `docker rm -f cm-scratch`.

## Option 2: a Supabase branch (real Supabase auth/roles; not yet exercised by me)
The suites were developed against the stub above and have **not** been run on a real Supabase project. They should work (they only use `public`/`private` objects, `auth.users`
inserts and `SET LOCAL ROLE`), but if a suite fails on setup (for example `insert into auth.users` rejecting a missing column), that is a test-setup difference, not necessarily a code bug —
use Option 1 as the reference and tell me the first failing test name.
1. Create a branch (Dashboard → Branches, or `supabase branches create phase6-tests`). A branch applies your `supabase/migrations/` to a **new empty database** (no production data).
   Confirm it is empty: `select count(*) from public.purchases;` → 0.
2. Get the branch's **direct** Postgres connection string (Dashboard → branch → Database → Connection string → **Direct** or **Session pooler**; not the *transaction* pooler on port 6543 — it breaks
   `SET LOCAL` / session state the tests rely on). Use the `postgres` user's password for the branch.
3. Run:
```bash
npm ci
export DATABASE_URL='postgresql://postgres:<branch-db-password>@<branch-direct-host>:5432/postgres'   # keep the password out of shell history if you can
PHASE5_CONCURRENCY_TESTS=1 node tests/phase5/run-all.mjs
```
4. Delete the branch when done (`supabase branches delete phase6-tests`).

## Running one suite
```bash
DATABASE_URL=… node tests/phase5/m53b-db.test.mjs                       # rolled-back-transaction suites
PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=… node tests/phase5/m52c-integration.test.mjs   # commit-then-delete suites
node tests/phase5/m53b-guardrails.test.mjs                               # static, no database
```
Suite map: `tests/phase5/README.md`.

## Reading the result
- `SKIPPED (counts as NOT passed)` → `DATABASE_URL` (or `PHASE5_CONCURRENCY_TESTS=1`) missing for that suite. `run-all` exits non-zero.
- `REFUSING TO RUN` → the database is not empty (see Safety net).
- A `FAIL:` line prints the test id and its values; send me that line and the migration list (`ls supabase/migrations`).
- After any change to `lib/payments/*` or a migration, re-run the whole gate; the mutation runners in `tests/phase5/scratch/run-mutations-*.mjs` (they need template databases, see the README) show whether the tests would notice a broken rule.
