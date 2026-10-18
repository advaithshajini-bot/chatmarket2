# Phase 6 · Razorpay Route live validation runbook (TEST mode)

**Goal:** replace "my reading of the docs" with observed facts. Everything money-related in Phase 5 talks to Razorpay through ONE file
(`lib/payments/razorpay-client.js`) and is rehearsed against a fake (`tests/phase5/fake-razorpay.mjs`). Until this runbook is done, the fake is a guess.
**Test mode only. Throwaway data only. Every flag stays OFF until Part B says otherwise.**

Secrets are referenced by env var name only (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CRON_SECRET`,
`SUPABASE_SERVICE_ROLE_KEY`). Never paste a value into a chat, a ticket or a commit. When you send me response bodies, they contain ids (`pay_…`,
`trf_…`, `acc_…`) but no secrets; that is fine.

## 0. Prerequisites
- [ ] Razorpay **test** account with **Route enabled** (Razorpay must approve this; until then nothing below is possible).
- [ ] One **test linked account** (`acc_…`) created in the dashboard (Route → Linked Accounts) or via Razorpay's API. Note its id.
- [ ] The Phase 5 migrations applied to the database the app points at (use a Supabase **branch** or a Vercel **Preview** deployment with test keys; do not use production data).
- [ ] Env vars set on that deployment: `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` (**test** keys, `rzp_test_…`), `RAZORPAY_WEBHOOK_SECRET`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] Webhook: Razorpay → Settings → Webhooks → URL `https://<preview-or-domain>/api/razorpay/webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`. Subscribe to
      `payment.captured`, `order.paid`, every `transfer.*` event offered (`transfer.processed`, `transfer.failed`, `transfer.reversed`, settlement events if listed) and every `refund.*` event
      (`refund.created`, `refund.processed`, `refund.failed`). Any `transfer.<x>` / `refund.<x>` is accepted; state is read from the entity, not the event name.
- [ ] Flags all OFF: `select name, enabled from private.feature_flags order by name;` → every row `f`.
- [ ] A throwaway seller (linked in the app via the admin desk: `/admin/payments` → Seller balances → "Set a seller's Razorpay payout account", status `active`) and a throwaway buyer.
- [ ] A way to run the raw calls: a terminal with `curl` and the test keys exported as `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (set them in your shell; do not echo them).

## Part A · Raw API shape checks (no app, no flags)
Make ONE normal test purchase per scenario through the app (webhook fulfils it; flags OFF so no transfer is created by us). Get each payment id:
`select id, razorpay_payment_id, amount, platform_fee from purchases order by purchased_at desc limit 5;` (seller share in paise = `round(amount*100) - round(platform_fee*100)`).
Use `-u "$RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET"` on every call. **One transfer per payment**, so use a fresh payment for each of A2, A5, A6.

| # | Call (payment/transfer ids are yours) | Our assumption (client code) | What to confirm / record |
|---|---|---|---|
| A1 | `GET /v1/payments/<pay>/transfers` before any transfer exists | reply has `items: []` | exact reply for "none yet" (array under `items`? bare array? 404?) |
| A2 | `POST /v1/payments/<pay>/transfers` body `{"transfers":[{"account":"<acc>","amount":<seller share paise>,"currency":"INR","notes":{"purchase_id":"<uuid>"},"on_hold":true,"on_hold_until":<unix, now+48h>}]}` | reply `items[0]` (or the bare object) is a transfer: `id` `trf_…`, `amount`, `currency`, `recipient`, `source`, `notes`, `on_hold`, `transfer_status` or `status`, `settlement_status`, `amount_reversed` | field names for the status (`status` vs `transfer_status`); does `notes` come back; is `on_hold_until` echoed; what `settlement_status` says while held (`on_hold`?) |
| A3 | `GET /v1/payments/<pay>/transfers` (same payment, after A2) | `items` contains the transfer | same field names as A2; one item |
| A4 | `GET /v1/transfers/<trf>` | the bare transfer entity | same entity shape as A2 |
| A5 | `PATCH /v1/transfers/<trf>` `{"on_hold":true}` (indefinite) then `{"on_hold":true,"on_hold_until":<unix>}` then `{"on_hold":false}` | each returns the updated entity; settlement/ on_hold change | the three replies; that an indefinite hold has no end date; that release is accepted |
| A6 | `POST /v1/transfers/<trf>/reversals` `{"amount":<full transfer amount>}` then `GET /v1/transfers/<trf>` | any 2xx; the transfer then shows `amount_reversed` = amount and status `reversed` | the reversal reply; status/`amount_reversed` after; try a PARTIAL reversal on another payment to see `partially_reversed` |
| A7 | `POST /v1/payments/<pay>/refund` `{"amount":<full amount paise>,"notes":{"purchase_id":"<uuid>"}}` on the payment from A6 (transfer already reversed) | accepted; reply is a refund: `id` `rfnd_…`, `payment_id`, `amount`, `status` pending/processed/failed, `notes` | **does Razorpay allow a refund AFTER the transfer was reversed?** (our order). If it refuses or asks for a parameter such as reversing all transfers, record the exact error |
| A8 | `GET /v1/payments/<pay>/refunds` | `items` array of refunds | shape; that a dashboard-made refund also appears |
| A9 | Refund a payment whose transfer is **not** reversed (new payment, transfer created) | (unknown) | whether Razorpay refuses, auto-reverses, or refunds from the platform balance; this decides whether reversal-first is right |
| A10 | Error shapes: repeat A2 for the same payment (duplicate); use a bad `acc_`; use an amount above the payment | 4xx with `error.code`/`error.description` | the codes, so retry vs park classification (`retryable` is only network/429/5xx) is right |

**Record each reply body (redact nothing but secrets; ids are fine).** Save them in a note called `route-shapes-<date>.md`.

### What to do with differences
1. A field name differs → edit `normalizeTransferEntity` / `normalizeRefundEntity` (`lib/payments/transfer-events.js`, `lib/payments/refund-events.js`) and the request bodies in `lib/payments/razorpay-client.js`.
2. A response shape differs → make `tests/phase5/fake-razorpay.mjs` return what Razorpay really returns, then `DATABASE_URL=… PHASE5_CONCURRENCY_TESTS=1 node tests/phase5/run-all.mjs` (see `phase6_db_tests.md`) must be green again.
3. **A7/A9 decide the dispute order.** If a refund after reversal is refused, or Razorpay needs a "reverse all" parameter on the refund, the order and calls in `lib/payments/disputes.js` change. Stop and bring me the A6–A9 replies; do not flip `phase5_auto_refunds`.
4. Anything surprising: stop, send me the redacted bodies.

## Part B · End-to-end through the app (test mode, one flag at a time)
Use `/admin/payments` to watch each step (Needs attention, Transfers, Refunds/Disputes, Seller balances) and the SQL below to confirm.

**B0 – flags OFF baseline.** Pay → purchase appears; `select count(*) from transfers;` → 0; seller sees "Payout not started" on `/sell/earnings`.

**B1 – `phase5_route_transfers` ON** (`update private.feature_flags set enabled = true, updated_at = now() where name = 'phase5_route_transfers';`)
- Pay as the buyer. Within seconds: `select status, on_hold, hold_until, settlement_status, razorpay_transfer_id, error from transfers order by created_at desc limit 3;` → `created`/`pending`, `on_hold` true, `hold_until` ≈ purchase + 48h. The Razorpay dashboard shows the transfer with a hold.
- `select transfer_status from purchases order by purchased_at desc limit 1;` → `held`. Seller view: "Held until <date>". Admin Transfers tab: `held`.
- Replay the webhook from Razorpay's dashboard ("Resend"): response 200, nothing changes.
- Run the sweep once by hand: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/payments/transfers/sweep` → `{"ok":true,…}`.

**B2 – dispute opened, then denied (release path).**
- Backdate so the 48h window is over: `update purchases set purchased_at = now() - interval '3 days' where id = '<purchase>';`
- As the buyer, open a dispute. Expect indefinite hold: `select on_hold, hold_until, review_reason from transfers where purchase_id = '<purchase>';` → `true | null | null`. Seller: "On hold: dispute raised".
- Admin resolves **denied**. Expect release: `on_hold` false; seller: "On its way"; after Razorpay settles (`transfer.processed` / settlement webhook): `settlement_status = settled`, seller: "Paid".

**B3 – dispute opened inside the window, denied.** New purchase (not backdated): after "denied" the transfer returns to its ORIGINAL timed hold (`hold_until` = purchase + 48h), not an earlier release.

**B4 – dispute refunded, `phase5_auto_refunds` still OFF.** New purchase + dispute, admin resolves **refunded**. Expect the transfer reversed (`status = reversed`, `amount_reversed_paise = amount_paise`), NO refund row; refund the buyer by hand in the Razorpay dashboard. Admin Refunds/Disputes shows the dispute with transfer `reversed`, no refund.

**B5 – dispute refunded, `phase5_auto_refunds` ON** (`update private.feature_flags set enabled = true, updated_at = now() where name = 'phase5_auto_refunds';`). New purchase + dispute + refunded. Expect: reversal, then `select status, razorpay_refund_id, error from refunds order by created_at desc limit 3;` → `pending` then `processed` after the `refund.processed` webhook. This only passes if A7 passed.

**B6 – failure rehearsals (each must show up on Needs attention and never double-pay).**
- Break the account: `update seller_payout_accounts set status = 'suspended' where user_id = '<seller>';` then pay → transfer is not created (`no_account`), seller sees "Being reviewed by our team"; restore to `active`; the next sweep creates exactly one transfer.
- Settled-before-dispute: backdate `purchased_at`, wait for/force `settlement_status = settled` (or `update transfers set settlement_status='settled' …` on a throwaway row), then open a dispute → the transfer is **parked** (`review_reason` set); admin desk shows "Transfer parked for review"; after you recover the money in Razorpay, **Clear review**.
- Replay and out-of-order webhooks from the Razorpay dashboard: no duplicate transfer/refund (`select count(*) from transfers where purchase_id = '<id>';` is always ≤ 1; same for `refunds`).
- Kill a request mid-flight (stop the deployment during a sweep): the next attempt must LIST first and adopt, not create a second transfer.

**B7 – cleanup.** Flags back OFF; delete throwaway sellers/accounts; keep the saved reply bodies.

## Exit criteria (all must be ticked before Phase 6 moves to live keys)
- [ ] A1–A10 recorded, and `fake-razorpay.mjs` / the client match them; full gate green (1,133+ tests).
- [ ] A7 and A9 answered, and the dispute order in the code is confirmed correct (or changed and re-tested).
- [ ] B1–B6 passed with the SQL results above; nothing left on Needs attention except what you caused on purpose.
- [ ] `transfer.*` and `refund.*` webhook event names you saw are all handled (check `select event_type, status, outcome from webhook_events order by received_at desc limit 50;` for `needs_review`/`ignored` surprises).
- [ ] Flags returned to OFF after the rehearsal.

## Rollback (any step)
`update private.feature_flags set enabled = false, updated_at = now() where name in ('phase5_route_transfers','phase5_auto_refunds');` takes effect on the next call.
Holds, reversals and refunds already made at Razorpay stay; undo them only in the Razorpay dashboard.
