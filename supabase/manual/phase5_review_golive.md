# Milestone 5.1 go-live checklist (nothing here runs automatically)

Razorpay is in TEST mode. Do all of this in test mode first.

1. **Branch / backup first.** Apply `20261012100000_add_payment_fulfilment.sql` to a Supabase *branch* (or after a backup). It is additive
   (2 tables, 4 functions, no change to any existing object, no feature flag touched). Rollback is at the top of the file.
2. **Server env vars (Vercel -> Project -> Settings -> Environment Variables, Production + Preview, NOT `NEXT_PUBLIC_`):**
   - `SUPABASE_SERVICE_ROLE_KEY` -- new for the Next.js app (the Edge Function already has its own). Sensitive; never in client code.
   - `RAZORPAY_WEBHOOK_SECRET` -- a long random string you choose; paste the SAME value in step 4.
   - already present: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. **Deploy** the app code (webhook route + refactored create-order / verify-payment). Order matters: the migration FIRST, then the code.
   Checkouts that were started before the deploy have no `payment_orders` row; if one of those is paid after the deploy it shows up as
   `order_unknown` in `webhook_events` (status needs_review) and the buyer sees a "contact support" message. Deploy in a quiet moment.
4. **Razorpay dashboard (Test mode) -> Settings -> Webhooks -> Add:** URL `https://<your-domain>/api/razorpay/webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`,
   active events: `payment.captured` and `order.paid` (others are harmlessly ignored). Use the "Send test webhook" button.
5. **Smoke test (test mode, a throwaway listing and buyer):**
   a. Pay normally with the test card/UPI. Expect: purchase appears, library unlocked. `select status, outcome from webhook_events order by received_at desc limit 5;`
      -> `processed / fulfilled` (or `already_fulfilled` if the browser got there first -- both fine).
   b. THE POINT OF 5.1: start a checkout, pay, and close the tab right after the Razorpay success screen (before the redirect).
      Within a minute the purchase must exist anyway (webhook). If it does not, check Razorpay -> Webhooks -> delivery log and Vercel function logs.
   c. In Razorpay's webhook log click "Resend" on that delivery: the answer is 200 and nothing changes (`duplicate`).
   d. `select * from webhook_events where status in ('needs_review','failed');` -- must be empty after a normal run.
6. **Close the free-purchase hole (separate, deliberate):** after step 5 passes in production, run `supabase/manual/phase5_close_purchase_insert_policy.sql`.
   Today any logged-in user can insert themselves a `paid` purchase straight through the API (policy "Users can create their own purchases").
   Verify afterwards that a normal checkout still works and a direct insert from the browser console is refused.
7. **Watch list (until 5.3 adds an admin screen):** `needs_review` rows mean money moved but access was NOT granted automatically
   (`order_unknown`, `amount_mismatch`, `listing_unavailable`, `duplicate_payment`). Look at them daily; refund in the Razorpay dashboard if needed.
8. **Rollback:** disable the webhook in Razorpay, redeploy the previous app version, then (optional) drop the new objects per the migration header.
   If you already ran step 6, re-create the policy first (rollback text is in that file) or the old verify-payment will fail.
