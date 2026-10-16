# Milestone 5.3 (part 2) — Seller payout status: go-live notes

**What ships:** one additive, read-only migration (`20261016100000_add_seller_payout_status.sql`, function `public.seller_payout_status`)
and the **Payout status** tab on `/sell/earnings` (replaces the old "No real payouts yet" placeholder). No flag is touched; nothing moves money.

## Apply
1. Test on a scratch/branch database first (creates one function only).
2. Apply to production **only when you confirm**, then deploy the app.

## What a seller sees (and never sees)
| Seller sees | Meaning |
|---|---|
| Held until <date> | inside the 48-hour dispute window |
| On hold: dispute raised | a buyer's dispute is open |
| On its way | hold ended, payout being released |
| Paid | settled |
| Refunded | refunded / reversed, no payout due |
| Action needed: link your payout account | no payout account on file (links to /sell/payout) |
| Payout account being set up | account pending |
| Payout not started | account active; payouts not switched on yet (this is what every sale shows while Route is off) |
| Processing | creating / transient failure |
| Being reviewed by our team | parked for review, or account suspended — no reason shown |

The function takes no seller id (it uses the logged-in user), returns status codes, dates and integer paise only, and never returns
Razorpay ids, error text, review reasons, dispute text or buyer details. The page loader never passes error text to the browser.

## Check
- Log in as a seller with sales: the tab lists their sales only; with Route off, expect "Payout not started" (account active) or "Action needed" (no account).
- Log in as a seller with no sales: "No sales to pay out yet."
- View page source / network response for the RPC: only the keys purchase_id, listing_title, purchased_at, status, share_paise, reversed_paise, release_date.

## Notes
- Status follows local webhook/poll updates, so it can trail the bank. The page says so.
- The "Sale transactions" tab and the 8-week chart are unchanged (they still use the display-only 18% fee).

## Rollback
`drop function public.seller_payout_status(integer);` and revert the app deploy.
