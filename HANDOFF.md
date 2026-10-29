# chatmarket — session handoff (as of 2026-10-23)

Repo state = what you have applied, plus the files delivered with this handoff. Everything money-related was built and tested on a **scratch Postgres 16** (stubbed Supabase roles, real migrations) and a **fake Razorpay**. Nothing in this file was run against production by Claude; production changes are made by you.

## 1. How money moves now
1. **Buyers pay through the standard Razorpay Payment Gateway.** Funds settle to the platform's own Razorpay account. There is no Route, no RazorpayX, no outgoing payout API, no IP proxy and no scheduled sweep.
2. The webhook (`/api/razorpay/webhook`) fulfils the purchase (`fulfil_captured_payment`, idempotent) and tracks `refund.*` events. Nothing runs after fulfilment.
3. Each sale's seller share (`round(amount×100) − round(platform_fee×100)`, integer paise) accumulates as **unsettled**.
4. **Once a month, by hand** (`/admin/payments` → Monthly settlement, admin + MFA): preview → freeze a batch → download CSV → pay each seller by UPI from your bank/app → record the bank reference (UTR). Runbook: `supabase/manual/phase7_monthly_settlement_runbook.md`.
5. Sellers see "Unsettled earnings (Next payout: 1 Nov …)" and a ledger of past payouts at `/sell/earnings`. They add one thing, a UPI ID, at `/sell/payout`; the listing gate is "has a saved UPI ID".

## 2. Settled decisions (do not re-open without Advaith)
* **All sales final, non-recourse.** Nothing ever debits a seller, goes negative or claws back. A paid settlement item is final (no function releases or reverses it). Disputes are support tickets; refunds go to the buyer from the platform.
* **UPI ID only, no KYC.** Old `seller_kyc` rows and the `seller-kyc-documents` bucket still exist (retention decision pending).
* **Minimum payout (5.6):** `private.settlement_config.min_payout_paise` (default 0). A seller below it rolls over to the next month.
* **UPI-change cooldown (5.7):** `private.settlement_config.upi_cooldown_hours` (default 72, 0 = off). A *changed* UPI ID cannot be in a frozen batch until it matures; the seller's earnings roll over (blocked reason `upi_in_cooldown`). The first save of an ID starts no cooldown. A frozen batch pays the ID snapshotted at the freeze.
* **Old payout/transfer code is deleted, its database objects stay.** Tables, functions and flags from 5.2/5.2c/5.4 still exist, dormant (flags OFF, `private.vpa_payout_config.cutoff_at = 'infinity'`). Settlement skips any sale that has a Route transfer or UPI payout row. Dropping those objects would be a separate, explicitly approved migration.
* **Refunds and disputes are kept:** `refund-events.js`, `disputes.js` (refund action only; only acts while `phase5_auto_refunds` is ON, seeded OFF), the dispute sync route and the admin attention/disputes tabs.

## 3. Migrations (all additive; apply in order)
`20261012100000` (5.1 fulfilment) · `20261013100000` (5.2 transfers, dormant) · `20261014100000` (5.2c disputes/refunds) · `20261015100000` (5.3 payments desk) · `20261016100000` (5.3b seller payout status) · `20261017100000` (revoke self-service payout account) · `20261018100000` (5.4 UPI payouts, dormant) · `20261019100000` (**5.5 monthly settlement**) · `20261020100000` (**5.6 minimum payout**) · `20261021100000` (**5.7 UPI cooldown**) · `20261023100000` (**generation type** on listings: two nullable columns; apply it BEFORE deploying the matching code) · `20261024100000` (**direct UPI payments**, flag `direct_upi_checkout` seeded OFF) · `20261025100000` (**instant unlock**: the UTR unlocks at once; sellers report, admins decide) · `20261026100000` (**Razorpay Route, test mode**: linked accounts, 100% order-level split, `route` purchases with fee 0; flag `phase5_route_transfers` stays OFF). · `20261027100000` (report an issue allowed at any time) · `20261028100000` (**seller bank display facts**: last 4 / IFSC / type + generated onboarding_status). Apply all of them BEFORE deploying the matching code.

## 4. Feature flags (verify in `private.feature_flags`)
`direct_upi_checkout` (buyers pay the seller's UPI ID directly; seller confirms with the UTR), `phase3_execution`, `phase4_approvals`, `phase4_demo`, `phase5_route_transfers`, `phase5_auto_refunds`, `phase6_vpa_payouts`: all OFF unless you flipped one deliberately. `phase6_vpa_payouts` and (for now) `phase5_auto_refunds` must stay OFF. `phase5_route_transfers` is the Route switch: flip it ONLY in test mode with test keys (`update private.feature_flags set enabled = true where name = 'phase5_route_transfers';`), and flip it back to false to return to the previous checkout. With it ON, Route wins over `direct_upi_checkout`. App code reads it only through the `route_checkout_enabled()` / `my_route_status()` functions.

## 5. Environment variables actually read by the code
Vercel (app): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `ADMIN_HOST` (second admin deployment).
Supabase secrets (execution-worker Edge Function, demo only): `ANTHROPIC_API_KEY`, `WORKER_SHARED_SECRET`, plus the built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
No other variable is needed. Secrets are referenced by NAME only; never paste a value into code, chat or docs.
Removed and no longer used: the RazorpayX account-number variable, any payout-proxy URL, and the cron secret. Nothing is scheduled for payments (no `pg_cron` job, no `vercel.json` cron).

## 6. Tests
`PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=<EMPTY scratch DB> node tests/phase5/run-all.mjs` → **1,752 passed, 0 failed** at the 5.7 milestone (it refuses a database that holds purchases or listings). With `node tests/phase5/run-all.mjs --allow-skip` and no database only the no-DB suites run (a skip is not a pass). Scratch DB builder: `tests/phase5/scratch/build-real.sh <db> <migrations-dir>`. A guide to every suite: `tests/phase5/README.md`. `next build` passes (run with dummy `NEXT_PUBLIC_SUPABASE_*`). Not run anywhere: the Phase 4 worker suite (needs Deno).

## 7. Rehearse before the first real payout
1. Build a **scratch database** (local Supabase or a throwaway branch), apply every migration, then run `supabase/manual/rehearsal_seed.sql`. It refuses to run if any real purchase exists, so it cannot touch production.
2. Expected preview with the seed: payable Rs 1,144.72 (2 sellers, 4 sales); not included: one below the minimum, one in cooldown, one with no UPI ID; the refunded sale appears nowhere.
3. Walk the monthly routine in the runbook: freeze, CSV (try it in your bank's bulk-upload format), mark paid with a reference, release a "bounced" item, cancel a batch. Then check the seller view of each seller.

## 8. Pending / open items (yours)
1. **Tax and compliance** (s.194-O TDS, GST TCS, whether a PAN/GSTIN field is needed): with your CA. Not handled in code.
2. **Settlement rehearsal** on the scratch database (section 7), then one real Rs 1–10 checkout end to end on the live Razorpay account.
3. **Milestone 4.4 interactive demo smoke test** under `phase4_demo`, waiting on topping up Anthropic credits; see `supabase/manual/phase4_demo_ui_golive.md`. Flags stay OFF until you flip them deliberately and are switched back afterwards.
4. **KYC data retention** (old `seller_kyc` rows and bucket).
5. Not built: email confirmation or re-authentication before a changed UPI ID is paid; a retry schedule for failed refunds (only relevant if you turn on `phase5_auto_refunds`).

## 9. Standing rules
Additive migrations only; test locally first; no production execution without explicit confirmation. Feature flags stay OFF unless you flip them. Secrets by env var name only.

## 10. Archive
Retired runbooks (Route, RazorpayX payouts, the old sweep, flag rollout for them) are in `supabase/manual/archive/` with a README. They are a record, not instructions.


## Razorpay Route (test mode) -- how to try it
1. Apply `20261026100000_razorpay_route_checkout.sql`. Deploy. Use TEST keys in `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`; Route must be enabled on the test account.
2. Razorpay dashboard (test) webhook, same `RAZORPAY_WEBHOOK_SECRET`: `payment.captured`, `order.paid`, `transfer.processed`, `account.*` status events, `refund.*`.
3. Flip the flag (SQL above). Sellers open `/sell/payout`, fill the linked-account form; the page and `/sell` unlock listing only when Razorpay reports the account activated (use "Check status" if the webhook is slow).
4. A buyer pays with the normal Razorpay modal. The order carries one transfer for 100% to the seller; the purchase is recorded as `payment_method = 'route'`, `platform_fee = 0`, and unlocks at once. Route sales never enter the monthly settlement.
5. PAN and bank details go to Razorpay only; chatmarket stores the account id and status. Gateway/Route fees are borne by the platform account (commission is 0).
