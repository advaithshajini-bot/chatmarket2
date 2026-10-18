# Phase 5 tests (Milestone 5.1 payment fulfilment, 5.2 Route transfers, 5.2c disputes, 5.3 payments desk, 5.4 instant UPI payouts)

    DATABASE_URL=postgres://... node tests/phase5/run-all.mjs            # everything except the race tests
    PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/run-all.mjs   # + race tests (SCRATCH DB ONLY)

| file | needs | what it proves |
|---|---|---|
| `m51-db.test.mjs` | Postgres with ALL real migrations incl. 20261012100000 | grants (service_role only), idempotency, every refusal outcome, input validation (CM070), webhook-event state machine, RLS on the new tables, replay/ordering of webhook vs browser verify, and that `supabase/manual/phase5_close_purchase_insert_policy.sql` works. Every test is a rolled-back transaction. |
| `m51-concurrency.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | 8 connections racing the same payment / event: exactly one purchase, no leaked errors. **Commits then deletes rows.** |
| `m51-logic.test.mjs` | nothing | HMAC signature (raw body, constant time), webhook handler routing + status codes, no payload leakage, buyer-facing outcome mapping, db wrapper contract. |
| `m51-guardrails.test.mjs` | nothing | static: migration is additive + locked down, webhook route is glue + raw body, service-role client is server-only, verify-payment no longer inserts, create-order records the order first, no flags touched. |
| `m52-db.test.mjs` | Postgres with ALL real migrations incl. 20261013100000 | transfers ledger + state machine: grants, flag OFF, eligibility, claim/amounts/hold, disputes, backoff, forward-only/idempotent/out-of-order events, purchases.transfer_status mapping, admin RPC (admin + aal2) and RLS. Rolled-back transactions. |
| `m52-integration.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | the REAL orchestration + Razorpay client + webhook handler against the real DB and a FAKE Razorpay with fault injection (timeouts before/after create, 429/500/400, garbage, mismatches, pre-existing duplicates), webhook replay/out-of-order/adoption, the sweep, `payment.captured` -> purchase -> transfer, plus 8-way races (exactly one transfer). **Commits then deletes rows.** |
| `m52-logic.test.mjs` | nothing | transfer entity normalisation, Razorpay client (error classes, timeout, secrets never echoed), orchestration (claim-then-call, lookup-first), sweep bounds/isolation, sweep auth, webhook transfer routing + the best-effort hook. |
| `m52-guardrails.test.mjs` | nothing | static: 5.2 migration additive and locked down, flag seeded OFF, one transfer per purchase, only the Razorpay client speaks the Route API, sweep route is glue + `CRON_SECRET`, service client server-only, no logging/secrets. |
| `m52c-db.test.mjs` | Postgres with ALL real migrations incl. 20261014100000 | the derived "what does this dispute need" rule (hold / flag / release / reverse / refund), leases, backoff, parking for review, the admin clear RPC, the refunds ledger + state machine, RLS, grants, validation (CM072). Rolled-back transactions. |
| `m52c-integration.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | the REAL dispute orchestration + client + db against the real DB and the fake Razorpay: hold on open, restore/release on denied, reverse-then-refund on refunded, timeouts after the call, look-before-act (reversal sized from Razorpay's numbers, refunds listed first, dashboard refunds adopted), refund webhooks, the sweep, 8-way races. **Commits then deletes rows.** |
| `m52c-logic.test.mjs` | nothing | refund entity, client reversal/refund methods, db wrapper contract, each action with a scripted db, the browser-triggered sync handler, `refund.*` webhook routing. |
| `m52c-guardrails.test.mjs` | nothing | static: 5.2c migration additive + locked down, both flags OFF, only the Razorpay client speaks the refund/reversal API, every action goes through a database claim first, the sync route trusts nothing but a purchase id. |
| `m53-db.test.mjs` | Postgres with ALL real migrations incl. 20261015100000 | admin payout reporting: every function refuses anon / service_role / non-admin / admin without aal2, the attention rules (parked, failed, stuck, refunds, disputes, webhook events), ledger buckets + filters + paging, disputes/refunds list, purchase timeline, seller balances in integer paise, and that nothing is written. Rolled-back transactions. |
| `m53-logic.test.mjs` | nothing | the desk helpers: paise/age formatting, RPC argument mapping, fail-soft loaders, the badge count, the two admin action wrappers. |
| `m53-guardrails.test.mjs` | nothing | static: 5.3 migration additive + read-only + admin/MFA first statement + grants, the page gates on admin and aal2 before loading, no service client, no Razorpay call or reconcile button, only known RPCs. |
| `m53b-db.test.mjs` | Postgres with ALL real migrations incl. 20261016100000 | seller payout status: anon/service_role refused, a seller sees only their own sales, every status mapping (needs_account … paid, reversed, dispute, under_review), amounts in integer paise, and that NO id, error, review reason, dispute text or buyer detail ever appears in the response. Rolled-back transactions. |
| `m53b-logic.test.mjs` | nothing | the plain-English wording (no internal terms) and the fail-soft loader. |
| `m53b-guardrails.test.mjs` | nothing | static: read-only, no seller-id parameter, auth.uid() only, allow-list response, seller UI uses no admin code / ledger tables / service client. |
| `m54-db.test.mjs` | Postgres with ALL real migrations incl. 20261017100000 | the self-service `set_seller_payout_account` is no longer callable by authenticated/anon/PUBLIC, the admin path still works, the revoke migration is idempotent. Rolled-back. |
| `m54-guardrails.test.mjs` | nothing | static: the revoke migration is one REVOKE statement and the newest file, nothing in the app calls the function, `run-all` has its non-empty-database preflight. |
| `m55-db.test.mjs` | Postgres with ALL real migrations incl. 20261018100000 | 5.4 instant UPI payouts: flags/grants, `set_my_payout_vpa` (format, rate limit, masked audit, no Razorpay ids readable), plan/claim/backoff/parking/cutoff/cap, forward-only events (a late failed never undoes processed), failures, work listing, admin retry/suspend/ledger, seller wording, **non-recourse** (dispute or refund never changes a paid payout; no negative amount anywhere), admin attention + balances. |
| `m55-integration.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | the REAL payout orchestration + client + webhook handler against the real DB and the fake RazorpayX: 10 racing workers = one payout, timeout-after-create recovered by lookup-first, sweep create + poll, retry key `-v2`, both flags on = nothing, suspended seller unpaid. **Commits then deletes rows.** |
| `m55-logic.test.mjs` | nothing | payout entity normalisation, RazorpayX client (idempotency header, UPI mode, account number), orchestration with a scripted db, sweep bounds, `payout.*` webhook routing, reconcile. |
| `m55-guardrails.test.mjs` | nothing | static: migration additive, flag OFF, cutoff/cap, mutual exclusion, grants, **no seller-debt concept in code or SQL**, one-input `/sell/payout`, UPI gate, wording, shared validator. |

`fake-razorpay.mjs` is the mock Razorpay Route API (and, since 5.4, RazorpayX contacts / fund accounts / payouts with idempotency and fault injection) (a `fetch` replacement; no network). `run-mutations-52.mjs` / `run-mutations-52c.mjs` break 5.2 / 5.2c on
purpose (64 mutations; one equivalent mutant -- the unreachable 6h backoff cap -- is deliberately not mutated); needs a template
DB `m52tpl` = stub + every migration except the 5.2 one.
`run-mutations-55.mjs` does the same for 5.4 (90 mutations, all killed; template DB `m55tpl` = stub + every migration except 20261018100000).
`run-mutations-53.mjs` / `run-mutations-53b.mjs` do the same for 5.3 part 1 / 2 (58 + 41 mutations, all killed); template DBs `m53tpl` / `m53btpl` = stub + every migration except the 5.3 part 1 / part 2 one.

Scratch DB: `tests/phase5/scratch/build-real.sh <db> <migrations-dir> [extra.sql]` builds a database from a minimal
Supabase stub (`min-stub.sql`: roles incl. service_role BYPASSRLS, default grants, auth/storage/vault/pg_net stand-ins)
plus your REAL migrations in order. `run-mutations.mjs` breaks the code on purpose (33 mutations); every one must be caught.

Not covered here (needs real Razorpay / Supabase / Vercel): an actual signed webhook from Razorpay, the Vercel env vars,
and the deployed route -- see `supabase/manual/phase5_review_golive.md`.

`run-all.mjs` refuses to run against a database that already holds purchases/listings (`PHASE5_ALLOW_NONEMPTY=1` overrides). How to run the DB-backed suites: `supabase/manual/phase6_db_tests.md`.
