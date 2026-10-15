# Milestone 5.2 (Route transfers: ledger, creation, sweep) -- go-live checklist

Nothing here runs automatically. **Everything ships dark:** the flag `phase5_route_transfers` is seeded OFF, and while it is OFF no transfer is ever
created and Razorpay's Route API is never called. Razorpay is in TEST mode; Route itself is not activated on the account yet.

## READ THIS FIRST -- two things that are deliberately not finished
1. **Disputes are not wired (that is 5.2c).** Transfers are created with a 48-hour hold and Razorpay releases them when it ends. If a buyer opens a
   dispute *after* the transfer exists, nothing re-holds or reverses it yet. **Keep `phase5_route_transfers` OFF until 5.2c is delivered**, or only turn it
   on in test mode with throwaway data. (`prepare_transfer_hold()` and `setTransferHold()` are already in place for 5.2c to use.)
2. **The Razorpay Route request/response shapes are unverified.** Route is not active, so I could not call it. From Razorpay's docs I confirmed the
   hold PATCH endpoint (`PATCH /v1/transfers/:id`, `on_hold`, `on_hold_until`) and the status values (`created|pending|processed|failed|reversed|partially_reversed`;
   settlement `pending|on_hold|settled`). **Not confirmed:** the create/list endpoints used here (`POST /v1/payments/:id/transfers` with
   `{transfers:[{account,amount,currency,notes,on_hold,on_hold_until}]}` and `GET /v1/payments/:id/transfers`) and the exact `transfer.*` webhook event names.
   Step 6 below checks them on the test account. All of it lives in ONE file, `lib/payments/razorpay-client.js`, so a correction is a small edit.

## Steps
1. **Branch / backup first.** Apply `supabase/migrations/20261013100000_add_route_transfers.sql` to a Supabase *branch* (or after a backup). Additive:
   2 tables (`seller_payout_accounts`, `transfers`), 1 flag row (OFF), 2 private helpers, 6 functions. No existing object is altered.
   Rollback SQL is in the file header. The migration must go in BEFORE the app code.
2. **New env var (Vercel -> Settings -> Environment Variables, Production + Preview, not `NEXT_PUBLIC_`):** `CRON_SECRET` -- a random string of at least 16
   characters. The sweep refuses to run without it. Already needed from 5.1: `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_WEBHOOK_SECRET`,
   `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
3. **Deploy the app code.** With the flag OFF it changes nothing visible: the webhook still fulfils purchases exactly as in 5.1 (the transfer hook is a no-op),
   and `/api/payments/transfers/sweep` answers 401 without the bearer token.
4. **The sweep (reconciliation).** `GET` or `POST /api/payments/transfers/sweep` with header `Authorization: Bearer <CRON_SECRET>`.
   - Manual: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/payments/transfers/sweep` -> `{ok:true, items, created, adopted, polled, ...}`.
   - Automatic (optional): add to `vercel.json` `{"crons":[{"path":"/api/payments/transfers/sweep","schedule":"0 3 * * *"}]}` -- Vercel Cron sends `GET` with
     the bearer token when `CRON_SECRET` is set. The Hobby plan allows once per day only; that is enough because the webhook creates transfers immediately and the
     sweep is the safety net. (It also covers payments that were captured while the flag was OFF, as long as they are < 90 days old.)
5. **Link sellers to Razorpay linked accounts (admin, MFA/aal2 session):** `select public.admin_set_seller_payout_account('<seller uuid>', 'acc_XXXXXXXXXXXXXX', 'active');`
   (statuses: pending / active / suspended; every change is written to `audit_log` as `payout_account_set`). Sellers without an `active` row are skipped
   (`no_account`), never paid. The table `seller_payout_accounts` is the ONLY eligibility source; `profiles.razorpay_linked_account_id` is deliberately not trusted
   (see the note at the end).
6. **After Razorpay approves Route, on the TEST account, with the flag still OFF:**
   a. Dashboard -> Webhooks: add the `transfer.*` events that exist (e.g. `transfer.processed`, `transfer.failed`, `transfer.reversed`; settlement events if offered).
      Any `transfer.<something>` is accepted; state is read from the transfer object, not the event name.
   b. With a throwaway seller + linked test account, make ONE manual call to confirm the create/list shapes (Razorpay's Route docs show the exact request).
      If a field name differs, fix `lib/payments/razorpay-client.js` and the fake in `tests/phase5/fake-razorpay.mjs`, then re-run the suites.
   c. Flip the flag (see 7) in test mode only, pay a test purchase, and check: `select status, on_hold, hold_until, settlement_status, error from transfers order by created_at desc limit 5;`
      and `select transfer_status from purchases where id = '<id>';` (`held` -> `released` after the hold ends and Razorpay settles).
7. **Flip the flag only deliberately, and only after 5.2c:** `update private.feature_flags set enabled = true where name = 'phase5_route_transfers';`
   Switch it off the same way. Off = no new transfers; events for existing transfers are still recorded.
8. **Watch list:** `select purchase_id, status, attempts, error, next_attempt_at from transfers where status in ('creating','failed');`
   and `select * from webhook_events where status in ('needs_review','failed');`. `failed` with `duplicate_transfers_at_razorpay`, `existing_transfer_mismatch`
   or `response_mismatch` means Razorpay holds something we did not expect for that payment: look in the Razorpay dashboard before doing anything else.
9. **Rollback:** turn the flag OFF, redeploy the previous app version, then (optional) drop the objects listed in the migration header. Transfers already created at
   Razorpay are not touched by any of this and can be reversed from the Razorpay dashboard.

## Things to know
- **Money is integer paise.** Seller share = `round(amount*100) - round(platform_fee*100)`; a purchase with no seller share gets no transfer.
- **Hold** = `purchased_at + 48h` (Razorpay `on_hold_until`). An open dispute at creation time holds indefinitely. A purchase whose dispute was resolved as refunded gets no
  transfer. If less than 5 minutes of hold remain, the transfer is created without a hold.
- **Never pays twice:** a purchase can have exactly one ledger row (unique); the row is claimed BEFORE Razorpay is called; after any attempt that may have reached Razorpay
  (timeout, crash, unreadable reply) the next attempt LISTS the payment's transfers and adopts the existing one instead of creating another. Retries back off 1, 2, 4... minutes and
  stop after 8 attempts (`failed`, visible in the watch list).
- **Known existing hole, outside 5.2:** `public.set_seller_payout_account` (from an earlier phase) can be called by any logged-in user to mark themselves "active" with any account
  id in `profiles`. 5.2 ignores those columns, so it cannot cause a payout, but it is worth revoking `execute` on it from `authenticated` in a later, separate step.
