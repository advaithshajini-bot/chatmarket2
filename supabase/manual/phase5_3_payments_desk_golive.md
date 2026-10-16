# Milestone 5.3 (part 1) — Payments desk: go-live notes

**What ships:** one additive, read-only migration (`20261015100000_add_payout_reporting.sql`), the `/admin/payments` page, and a
"Payments" link with a count badge on `/admin`. No flag is touched; nothing here moves money.

## Apply
1. Test on a scratch/branch database first (the migration only creates functions; no table, column or flag changes).
2. Apply `20261015100000_add_payout_reporting.sql` to production **only when you confirm**.
3. Deploy the app. Sign in as an admin with a verified MFA session and open `/admin/payments`.

## Check
- A non-admin, or an admin without MFA, sees no data (the page says so; the functions refuse with 42501).
- `/admin` shows **Payments**; the red number is the count of items on the Needs attention tab (hidden when 0 or when the session is not MFA-verified).
- With Route still off, expect: empty Transfers, balances showing each seller's earnings under **Awaiting transfer**, and no attention items.

## What "Needs attention" means
| Item | Shown when |
|---|---|
| Transfer parked for review | a dispute action could not be done safely; **Clear review** re-queues it (audited) |
| Transfer failed / stuck creating | status failed, or creating for over 15 minutes |
| Refund failed / not confirmed | failed, creating over 15 minutes, or pending over a day |
| Dispute open, hold not applied | open over 10 minutes, a transfer exists, no indefinite hold yet |
| Payment event needs review / failed | webhook `needs_review` in the last 30 days; `failed` for over an hour |

## Limits to know
- Figures come from the **local ledger** (webhook and poll updates). They are not reconciled against Razorpay or the bank.
- Needs-review webhook events have no "dismiss" action; they leave the list after 30 days.
- Alerts are pull-only (the tab and the badge). No email/WhatsApp.
- The Seller balances form wraps the existing `admin_set_seller_payout_account` (admin + MFA). The older self-service
  `set_seller_payout_account` function (granted to every signed-in user) is still the known hole from 5.2; Route eligibility does not use it.

## Rollback
Drop the functions listed at the top of the migration, and revert the app deploy. No data is affected.
