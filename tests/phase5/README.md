# Phase 5 tests (payment fulfilment, dormant Route/UPI ledgers, refunds and disputes, payments desk, monthly settlement 5.5, minimum payout 5.6, UPI cooldown 5.7, clean-ups)

    DATABASE_URL=postgres://... node tests/phase5/run-all.mjs            # everything except the race tests
    PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=... node tests/phase5/run-all.mjs   # + race tests (SCRATCH DB ONLY)

| file | needs | what it proves |
|---|---|---|
| `m51-db.test.mjs` | Postgres with ALL real migrations | payment fulfilment: grants (service_role only), idempotency, every refusal outcome, input validation (CM070), webhook-event state machine, RLS, replay/ordering of webhook vs browser verify. Rolled-back transactions. |
| `m51-concurrency.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | 8 connections racing the same payment / event: exactly one purchase. **Commits then deletes rows.** |
| `m51-logic.test.mjs` | nothing | HMAC signature (raw body, constant time), webhook routing + status codes, no payload leakage, buyer-facing outcomes, db wrapper contract. |
| `m51-guardrails.test.mjs` | nothing | static: migration additive + locked down, webhook route is glue + raw body, service client server-only, no flags touched. |
| `m52-db.test.mjs` | same | the **dormant** Route transfers ledger + state machine in the database (the code that drove it was deleted in the Tier 2 clean-up; the tables stay). |
| `m52-guardrails.test.mjs` | nothing | static: the 5.2 migration is additive and locked down, flag seeded OFF, only the Razorpay client speaks to Razorpay, service client server-only, no logging/secrets. |
| `m52c-db.test.mjs` | same | the derived "what does this dispute need" rule, leases, backoff, the refunds ledger + state machine, RLS, grants (CM072). |
| `m52c-integration.test.mjs` | same, `PHASE5_CONCURRENCY_TESTS=1` | **refund-only** orchestration against the real DB and a fake Razorpay: refund created once, timeouts after the call, look-before-act (dashboard refunds adopted), flag OFF = no call, refund webhooks, the sweep, 8-way races. **Commits then deletes rows.** |
| `m52c-logic.test.mjs` | nothing | refund entity, client refund methods, db wrapper contract, the refund action with a scripted db, the browser-triggered dispute sync handler, `refund.*` webhook routing. |
| `m52c-guardrails.test.mjs` | nothing | static: 5.2c migration additive + locked down, flags OFF, only the Razorpay client speaks the refund API, the sync route trusts nothing but a purchase id. |
| `m53-*` | DB / nothing | admin payments desk reporting (read-only, admin + aal2), desk helpers, static guardrails. |
| `m53b-*` | DB / nothing | the seller-scoped payout status function (kept for legacy rows), its wording and loader. |
| `m54-*` | DB / nothing | the revoke of the self-service payout account function. |
| `m55-db.test.mjs` | Postgres with ALL real migrations | the **dormant** 5.4 UPI payout ledger: flags/grants, `set_my_payout_vpa` (format, rate limit, masked audit), claim/backoff/cutoff/cap, forward-only events, non-recourse (no negative amount anywhere). The payout code itself was deleted in Tier 1. |
| `m55-guardrails.test.mjs` | nothing | static: 5.4 migration additive, flag OFF, no seller-debt concept in code or SQL, one-input `/sell/payout`, UPI gate, wording, shared validator. |
| `m56-db.test.mjs` | Postgres with ALL real migrations | **monthly settlement (5.5):** admin-only RPCs, batches, one-open-batch, a sale settled once, paid is final, refunds excluded, seller view, audit, RLS. |
| `m56-logic.test.mjs` | nothing | settlement helpers: CSV formula-injection safety, IST month periods, wording, loaders. |
| `m56-guardrails.test.mjs` | nothing | static: the settlement code calls no payment-provider API, no negative amounts, additive migration, admin/MFA first statement. |
| `m57-db.test.mjs` | Postgres with ALL real migrations | **minimum payout (5.6):** below-minimum sellers roll over, preview and freeze agree, default 0 changes nothing. |
| `m58-tier1.test.mjs` | nothing | **Tier 1 clean-up:** the RazorpayX / UPI payout code is gone and nothing reaches it; payout webhooks are ignored; payment fulfilment unchanged. |
| `m59-tier2.test.mjs` | nothing | **Tier 2 clean-up:** Route transfers, the sweep route and reconcile are gone; refunds, disputes and settlement untouched; archive in place. |
| `m60-db.test.mjs` | Postgres with ALL real migrations | **UPI-change cooldown (5.7):** when the clock starts, preview/freeze/seller view agree, boundaries, rollover to the next batch, a frozen batch is unaffected, privileges. |
| `m60-logic.test.mjs` | nothing | cooldown wording, loaders, static guardrails on the 5.7 migration and screens. |
| `m61-docs.test.mjs` | nothing | the handoff and this README carry no stale payout/sweep instructions; the rehearsal seed script refuses a database with real purchases and creates only fake data. |
| `m62-db.test.mjs` | Postgres with ALL real migrations | **generation type:** the two nullable columns and their CHECK constraints (types, the Others text 1-60 chars, text only with Others), insert policy unchanged. |
| `m62-logic.test.mjs` | nothing | the Images/Text/Videos/Others helper, the dropdown + Others text box on the playbook Details step, the insert, and the additive migration. |
| `m63-db.test.mjs` | Postgres with ALL real migrations | **direct UPI payments** (flag `direct_upi_checkout`, OFF): identity details (validation, masking, last 4 only), step order, listing gate, checkout lookup, claims, seller confirm/reject, purchase creation, settlement isolation, privileges. |
| `m63-logic.test.mjs` | nothing | UTR and UPI-link helpers, identity validation, wording, loaders, the screens and the migration guardrails. |
| `m64-db.test.mjs` | Postgres with ALL real migrations | **instant unlock:** a UTR creates the purchase at once, one UTR one purchase, the seller report, the admin (MFA) decision (verified keeps access / not verified removes it), report window, privileges. |
| `m65-db.test.mjs` | Postgres with ALL real migrations | **Razorpay Route:** linked-account save/status (idempotent), checkout target, Route orders fulfil as `route` with fee 0 (payment.captured and transfer.processed, either order), mismatches refused, settlement exclusion, listing gate, direct-UPI objects intact. |
| `m65-logic.test.mjs` | nothing | order payload with the 100% transfer, linked-account payloads, onboarding steps and resume, status mapping, webhook signature/idempotency/unlock, screens, migration guardrails. |
| `m67-db.test.mjs` | Postgres with ALL real migrations | **bank display facts:** last 4 / IFSC / type saved by the server only, generated onboarding_status, no column for a full account number or PAN, privileges, row-level security, the migration runs twice. |
| `m67-logic.test.mjs` | nothing | the 2-step payout form (identity, then bank with confirm + IFSC lookup), no UPI step in the Route flow, and the seller-transparency text on the listing, checkout and receipt. |
| `m66-docs.test.mjs` | nothing | the legal and help pages (all sales final, reports allowed at any time, no payment-gateway name, report-any-time migration): merchant identity, refund/support SLAs, Route wording, consistency with the seller pages, no dead links, honest cookie panel. |
| `m64-logic.test.mjs` | nothing | the checkout step order (Buy now, blurred QR, Show QR, I've paid, UTR), seller report and admin screens, wording, migration guardrails. |

`fake-razorpay.mjs` is the mock Razorpay API for refunds and the (dormant) Route paths used by the m52c integration tests (a `fetch` replacement with fault injection; no network). The mutation runners for the deleted code were removed; `run-mutations-53.mjs` / `run-mutations-53b.mjs` / `run-mutations.mjs` remain. The 5.6 and 5.7 migrations were mutation-checked by hand (each broken variant fails at least one test); for 5.7 the six variants are listed in the milestone report.

Scratch DB: `tests/phase5/scratch/build-real.sh <db> <migrations-dir> [extra.sql]` builds a database from a minimal
Supabase stub (`min-stub.sql`: roles incl. service_role BYPASSRLS, default grants, auth/storage/vault/pg_net stand-ins)
plus your REAL migrations in order. `run-mutations.mjs` breaks the code on purpose; every mutation must be caught.

Total at the 5.7 milestone: 1,752 passed, 0 failed (with `PHASE5_CONCURRENCY_TESTS=1` on an empty scratch DB). The rehearsal data script is `supabase/manual/rehearsal_seed.sql` (scratch databases only).

Not covered here (needs real Razorpay / Supabase / Vercel): an actual signed webhook from Razorpay, the Vercel env vars,
and the deployed route -- see `supabase/manual/phase5_review_golive.md`.

`run-all.mjs` refuses to run against a database that already holds purchases/listings (`PHASE5_ALLOW_NONEMPTY=1` overrides). How to run the DB-backed suites: `supabase/manual/phase6_db_tests.md`.
