# Manual bank payouts (migration 20261029100000)

Model: Razorpay Route OFF, UPI not collected. Sellers save permanent bank details; the admin pays monthly by IMPS/NEFT from the settlement CSV.

## Apply (you run these; nothing was run on production)
1. Review `supabase/migrations/20261029100000_manual_bank_payouts.sql` (additive; widens one constraint; replaces 4 settlement functions + the listing-gate trigger function).
2. Apply it to Supabase, then deploy the app files.
3. Keep `phase5_route_transfers` = false and `direct_upi_checkout` = false.

## What changed
- `seller_payout_accounts.bank_account_number` (9-18 digits). NOT readable by `authenticated`/`anon`; readable by `service_role` and via admin+MFA functions only.
- `set_my_bank_payout(number, ifsc, beneficiary, type)` -> `{outcome:'saved'}`; `my_bank_payout()` gives the seller only ****1234 / IFSC / name / type.
- Listing gate: needs saved account number + IFSC (CM079 `bank_account_required`). Route ON still needs an activated linked account; direct-UPI flag ON keeps its old rule (dormant).
- Settlement: eligibility, batch snapshot and blocked reasons (`no_bank_account`, `bank_in_cooldown`) use the bank account. Changing an existing account starts the same 72h cooldown (`upi_cooldown_hours` setting).
- CSV columns: Beneficiary Name, Account Number, IFSC Code, Account Type, Net Payout (INR), Remarks. Open in a text editor or import the account column as Text so Excel keeps leading zeros.
- `/sell/payout` is bank-only (no UPI form). Posts to `/api/sell/payout-bank`.
- Old UPI-only batches already frozen stay payable in the desk but are skipped by the new CSV (no bank snapshot).

## Still to decide
- Legal pages (terms, about, help, for-sellers, how-it-works) still say "no commission / 100% settled / split at payment". With Route OFF the 18% platform fee applies and the platform collects, then pays out monthly. Privacy was corrected to say bank details are stored.
