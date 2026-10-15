# Milestone 5.2c (disputes -> transfers and refunds) go-live checklist

Nothing here runs automatically. Razorpay is in TEST mode and Route is not activated yet, so **everything ships dark**: `phase5_route_transfers`
and the new `phase5_auto_refunds` are both OFF. With both OFF the only thing that can happen is a protective **hold** or **reversal** on a transfer that
already exists (there are none until Route is on).

## What it does
| Dispute becomes | The system does | Needs flag |
|---|---|---|
| `open` (buyer files within 48h) | PATCHes the Razorpay transfer to an **indefinite hold** (`on_hold: true`, no end date) | none (protective) |
| `resolved_denied` (seller wins) | puts the hold back to its **original 48h end** if that is still in the future, otherwise **releases** | `phase5_route_transfers` |
| `resolved_refunded` (buyer wins) | **reverses the transfer** in full, THEN **refunds the buyer** the full amount | reversal: none; refund: `phase5_auto_refunds` |
| `open`, but the money already **settled** to the seller | cannot be held: the transfer is **parked for review** | none |

Anything unsafe is **parked** in `transfers.review_reason` (a Razorpay refusal, 8 failed attempts, a settled transfer) and is NOT retried until an admin clears it.
No refund is made while a reversal is parked or still pending.

## How it is triggered
- **Immediately:** the browser calls `POST /api/payments/disputes/sync` (just the purchase id) right after a buyer files a dispute and right after an admin resolves one.
  The route checks the caller can see that dispute (RLS), then does whatever the database says is due. It cannot be told what to do.
- **Safety net:** the same reconciliation sweep as 5.2 (`/api/payments/transfers/sweep`) now runs disputes FIRST, then transfers.
- **Strongly recommended (minute-level latency without Vercel Pro):** a dispute opened at hour 47 must be held before hour 48. If the browser call fails (tab closed) and
  the sweep only runs daily, there is a gap. Use `supabase/manual/phase5_2c_schedule_sweep.sql` (pg_cron + pg_net, every minute) -- untested here, read it first.

## Steps
1. **Branch / backup first.** Apply `supabase/migrations/20261014100000_add_dispute_actions.sql` to a branch or after a backup. Additive: 1 table (`refunds`), 4 columns on `transfers`,
   1 flag row (OFF), 9 functions; the one existing function it touches is `plan_transfer` (same signature and grants; it now also returns `adopt_only`). Rollback is in the file header.
   The migration goes in BEFORE the app code.
2. **Deploy the app code.** No new env vars. With both flags OFF nothing visible changes.
3. **Razorpay dashboard (after Route/refunds are available in test mode):** add the `refund.*` webhook events (`refund.processed`, `refund.failed`, `refund.created`). Any `refund.<name>`
   is accepted; state is read from the refund object.
4. **Confirm the unverified API shapes on the test account (see below), with both flags OFF.**
5. **Test-mode rehearsal** with throwaway data, flags flipped deliberately:
   a. `phase5_route_transfers` ON: pay, then file a dispute as the buyer. Within seconds: `select on_hold, hold_until, review_reason from transfers order by created_at desc limit 3;` -> `on_hold` true, `hold_until` null.
      Check the Razorpay dashboard shows the transfer on hold.
   b. Resolve it in the admin desk as **denied**: the transfer returns to its original timed hold (or releases if the 48h are over).
   c. New purchase, dispute, resolve as **refunded**, with `phase5_auto_refunds` still OFF: the transfer is reversed, no refund is made (do it by hand in the dashboard).
   d. Repeat with `phase5_auto_refunds` ON: reversal, then a refund row (`select status, razorpay_refund_id from refunds`), then `refund.processed` arrives and it becomes `processed`.
6. **Watch list:**
   - `select purchase_id, review_reason, action_attempts from transfers where review_reason is not null;` -- parked items. After fixing the cause in the Razorpay dashboard, an admin (MFA/aal2) runs
     `select public.admin_clear_transfer_review('<purchase uuid>');` and the system re-evaluates (and audits it as `transfer_review_cleared`).
   - `select purchase_id, status, attempts, error from refunds where status in ('creating','failed');`
   - `select * from webhook_events where status in ('needs_review','failed');` -- a `refund_unknown_refund` means a refund was made outside this flow (e.g. by hand in the dashboard): informational.
7. **Rollback:** turn both flags OFF, redeploy the previous app version, then (optional) drop the objects in the migration header. Holds, reversals and refunds already made at Razorpay stay (they can be undone only in the Razorpay dashboard).

## READ THIS: what is unverified
Route is not active, so these shapes come from my reading of Razorpay's docs and could not be exercised. They live in ONE file, `lib/payments/razorpay-client.js`, and the mock in `tests/phase5/fake-razorpay.mjs`:
- `POST /v1/transfers/:id/reversals` with `{amount}` (reversal) -- success is any 2xx; the code then re-reads the transfer to learn the real state, so it does not depend on the reply shape.
- `POST /v1/payments/:id/refund` with `{amount, notes}` and `GET /v1/payments/:id/refunds` (refund create / list) and the refund object fields (`id` `rfnd_...`, `payment_id`, `amount`, `status` pending|processed|failed, `notes`).
- the `refund.*` webhook event names and payload (`payload.refund.entity`).
- Whether Razorpay lets a payment be refunded after its transfer is reversed (the order used here), or wants a `reverse_all` style parameter instead. If it differs, the change is in the client plus the order in `lib/payments/disputes.js`.
- Previously unverified (5.2): create/list transfer shapes and the `transfer.*` events; the hold PATCH and the status values WERE confirmed.

## Things to know
- **Refund amount = the full purchase amount** (integer paise). Partial refunds are not automated.
- **Never refunds twice:** one `refunds` row per purchase (unique), claimed before Razorpay is called; every attempt first LISTS the payment's refunds (a refund made by hand in the dashboard is adopted if it matches the full amount; a partial or duplicate one parks it as `failed` for a human).
- **Never reverses twice:** the reversal amount is computed from Razorpay's own numbers each time (`amount - amount_reversed`), so a retry after a timeout reverses only what is left.
- **A refunded dispute can never create a new transfer:** if the dispute is resolved in the buyer's favour while a transfer creation is still pending, the retry may only ADOPT one that already exists at Razorpay (then it is reversed).
- **Known limitation:** if the transfer has already settled to the seller when a refund is decided, Razorpay may refuse the reversal (insufficient balance in the linked account). It is parked for review and the buyer is NOT auto-refunded -- you decide how to recover the money.
- **Still open from earlier steps:** `public.set_seller_payout_account` lets any logged-in user mark themselves "active" in `profiles`; 5.2/5.2c ignore those columns so it cannot cause a payout, but revoke it in a separate step.
