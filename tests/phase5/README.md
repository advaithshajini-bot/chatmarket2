# Phase 5 tests (Milestone 5.1 -- payment fulfilment)

    DATABASE_URL=postgres://... node tests/phase5/run-all.mjs            # everything except the race tests
    PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/run-all.mjs   # + race tests (SCRATCH DB ONLY)

| file | needs | what it proves |
|---|---|---|
| `m51-db.test.mjs` | Postgres with ALL real migrations incl. 20261012100000 | grants (service_role only), idempotency, every refusal outcome, input validation (CM070), webhook-event state machine, RLS on the new tables, replay/ordering of webhook vs browser verify, and that `supabase/manual/phase5_close_purchase_insert_policy.sql` works. Every test is a rolled-back transaction. |
| `m51-concurrency.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | 8 connections racing the same payment / event: exactly one purchase, no leaked errors. **Commits then deletes rows.** |
| `m51-logic.test.mjs` | nothing | HMAC signature (raw body, constant time), webhook handler routing + status codes, no payload leakage, buyer-facing outcome mapping, db wrapper contract. |
| `m51-guardrails.test.mjs` | nothing | static: migration is additive + locked down, webhook route is glue + raw body, service-role client is server-only, verify-payment no longer inserts, create-order records the order first, no flags touched. |

Scratch DB: `tests/phase5/scratch/build-real.sh <db> <migrations-dir> [extra.sql]` builds a database from a minimal
Supabase stub (`min-stub.sql`: roles incl. service_role BYPASSRLS, default grants, auth/storage/vault/pg_net stand-ins)
plus your REAL migrations in order. `run-mutations.mjs` breaks the code on purpose (33 mutations); every one must be caught.

Not covered here (needs real Razorpay / Supabase / Vercel): an actual signed webhook from Razorpay, the Vercel env vars,
and the deployed route -- see `supabase/manual/phase5_review_golive.md`.
