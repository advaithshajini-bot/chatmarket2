# Phase 3.1 tests

Zero-cost, self-contained. **Nothing here touches Supabase or any production data.**

| Suite | What it needs | What it covers |
| --- | --- | --- |
| `ceilings.test.mjs` | Node only | L1 (application) ceiling validation: v10 tests 34-39 (app half), 41 (constants), 42, and the D-1 default. 47 assertions. |
| `db/run_db_tests.py` | Local PostgreSQL 14+ and `psycopg2` | L2/L3, retry fencing, cancellation fencing, frozen configuration, lock ordering (concurrent), privilege catalog, denial matrix, `search_path` hijack, definition audit, drift guard: v10 tests 31-37, 38 (config half), 39-48, plus supplemental `S-*` invariant tests. |
| `db/run_dataapi_tests.py` | The above plus a PostgREST binary | The W1 worker path over real HTTP (Data API + service_role token -> wrapper -> private function) and denial for anon / authenticated. |

## Run

```bash
node tests/phase3/ceilings.test.mjs

# local throwaway database (never Supabase); superuser access on 127.0.0.1:54329 by default
PGHOST=127.0.0.1 PGPORT=54329 ./tests/phase3/db/setup_local_db.sh
python3 tests/phase3/db/run_db_tests.py
POSTGREST_BIN=/path/to/postgrest python3 tests/phase3/db/run_dataapi_tests.py
```

`setup_local_db.sh` rebuilds the database from scratch every time: role setup that
mirrors the attributes and default privileges measured on the live project
(`shim/`), then **every real migration in `supabase/migrations/` in order**.
`TESTS=31,40 python3 tests/phase3/db/run_db_tests.py` runs a subset.
`MIGRATIONS_DIR=/some/dir ./tests/phase3/db/setup_local_db.sh` builds from a
different migration set (used for mutation testing).

## Known scope limits (be honest about what a green run means)

- The shim is **not Supabase**. Privilege facts specific to Supabase (default
  privileges, role membership) were checked separately against the real project
  with a guaranteed-rollback dry run; see the Phase 3.1 Implementation Report.
- PostgREST here is not Supabase's gateway. A JWT whose role claim is
  `service_role` stands in for a secret key.
- v6/v7 tests 1-30 are **not** included: their specification was not in the
  handoff.
- Runtime enforcement of the 300 s active-processing budget (`timed_out`) is not
  implemented, so it is not tested.
