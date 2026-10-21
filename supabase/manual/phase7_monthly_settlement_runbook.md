# Milestone 5.5 — manual monthly settlement: runbook

**Status: built and tested on a scratch Postgres only.** Nothing here was applied to production. Standing rules apply: additive migration, test locally first, no production execution without your confirmation.

## 0. The decision, in one paragraph
RazorpayX, outgoing payout APIs, IP allowlisting/proxy and the minute-level sweep are **not used**. Buyers pay through the normal Razorpay Payment Gateway and the money settles to your account. Each sale's seller share (`round(amount×100) − round(platform_fee×100)`, integer paise) accumulates as *unsettled*. Once a month you freeze a batch, pay each seller by hand to their saved UPI ID, and record the bank reference. All sales are final: nothing ever debits a seller or goes negative, and a payment you have recorded as paid cannot be undone.

## 1. What changed
| | |
|---|---|
| migration | `supabase/migrations/20261019100000_add_monthly_settlement.sql` (additive; touches no flag, no existing function) |
| tables | `settlement_batches`, `settlement_items` (one per seller per batch), `purchase_settlements` (PK `purchase_id`: a sale can be settled once), `private.settlement_config` |
| admin RPCs (admin + MFA) | `admin_settlement_pending` (preview), `admin_create_settlement_batch`, `admin_settlement_batches`, `admin_settlement_batch`, `admin_settle_items`, `admin_release_settlement_item`, `admin_cancel_settlement_batch` |
| seller RPC | `seller_settlement_status` |
| app | `lib/domain/{admin,seller}-settlement.js`, `components/AdminSettlementTab.jsx`, `components/SellerPayoutPanel.jsx` (rewritten), `SellerEarningsClient.jsx`, `AdminPaymentsDesk.jsx`, `app/admin/payments/page.jsx`, `app/sell/earnings/page.jsx`, copy on `/sell/payout` and `/sell`'s UPI gate |
| kept | `/sell/payout` (single UPI ID), the listing gate "has a saved UPI ID", `set_my_payout_vpa` |
| tests | `tests/phase5/m56-{db,logic,guardrails}.test.mjs` (added to `run-all.mjs`) |

## 2. The outgoing payout code is bypassed, not deleted
It cannot run: `phase6_vpa_payouts` and `phase5_route_transfers` are OFF, `private.vpa_payout_config.cutoff_at` is `'infinity'` (so even a mistaken flag flip pays nobody), and `RAZORPAYX_ACCOUNT_NUMBER` / `PAYOUT_PROXY_URL` do not need to be set. **Do not schedule the sweep** (no `pg_cron` job, no `vercel.json` cron) and do not create RazorpayX keys. Settlement eligibility also skips any sale that has a Route transfer or a UPI payout row, so the two systems can never pay the same sale.
Optional later clean-up (separate change, because suites m52/m55 test this code): delete the payout methods in `razorpay-client.js`, `lib/payments/{vpa-payouts,payout-events}.js`, the payout branch of `webhook-handler.js`, `runPayoutSweep` in `reconcile.js`, `app/api/payments/transfers/sweep`, and the m55 suites.

## 3. Apply (only when you decide to)
1. Scratch/branch DB first: `PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=… node tests/phase5/run-all.mjs` (empty DB only).
2. Apply `20261019100000_add_monthly_settlement.sql`, deploy the app.
3. Optional: exclude test or old sales so they are never settled:
   ```sql
   update private.settlement_config set start_at = '2026-10-01 00:00+05:30' where id;   -- default '-infinity' = every paid sale
   ```
4. Smoke test: `/sell/earnings` shows "Unsettled earnings … Next payout: 1 Nov"; `/admin/payments` opens on **Monthly settlement**.

## 4. The monthly routine (admin, MFA session)
1. **Preview.** Open `/admin/payments` → Monthly settlement. The default cut-off is *the 1st of this month (IST)* and the label is last month (`2026-10`). The preview lists each payable seller (UPI ID, sales, fee, amount) and, separately, sellers who cannot be paid yet (no UPI ID, setup unfinished, or paused). Their earnings stay unsettled and roll to the next month.
2. **Freeze.** "Freeze batch" locks each seller's amount and UPI ID. Only one batch can be open at a time. Wrong date or label and nothing paid yet → "Cancel batch".
3. **Export.** "Download CSV (to pay)" → columns `seller_name, upi_id, amount_inr, purchases, note, item_id, status, bank_reference`. Bank bulk-upload templates differ; map the columns in a spreadsheet. Seller names are neutralised against spreadsheet formula injection.
4. **Check the flags** on each row before sending money: *UPI ID changed recently* (changed within 7 days of the batch: confirm it is really the seller), *UPI ID changed since batch* (you pay the **frozen** ID; the seller may need to tell you), *N sale(s) refunded since* (a sale refunded after the freeze; release the item and re-run so you do not pay for a refunded sale).
5. **Pay** each seller by UPI. Money sent to a wrong UPI ID cannot be recalled.
6. **Record.** Enter the bank / bulk-transfer reference (letters, digits, space . _ / -, ≤ 80) and "Mark all pending as paid", or tick some rows and "Mark selected as paid". The reference is stored on every item you mark and shown to those sellers. When no item is pending the batch completes.
7. **If a transfer bounces:** "Release" the item with a reason. Its sales become unsettled and join the next batch. A *paid* item can never be released.

## 5. What sellers see
`/sell/earnings` → Payouts: *Unsettled earnings* with "Next payout: 1 Nov 2026", *Being paid* (in an open batch), *Paid out*, a **Past payouts** history (month label, amount, sales count, reference, masked UPI ID) and a per-sale status (Unsettled / Being paid / Paid / Action needed: add your UPI ID / Being reviewed / Refunded). A refund after a sale was paid out changes nothing the seller sees.

## 6. Rules the design enforces (each has a test)
* A sale is in at most one settlement item (`purchase_settlements` primary key); two batches can never include it.
* One open batch at a time; labels are unique.
* A paid item is final: no function releases, cancels or reverses it; cancel works only when nothing in the batch is paid.
* Refunded-before-freeze sales are not eligible; refunded-after-payment sales are never reclaimed.
* All amounts integer paise; the seller view never contains item, batch or admin ids and never a negative amount.
* Admin functions require admin **and** aal2 as their first statement; no table is readable or writable directly by `authenticated` or `anon`.
* Every write is audited (`settlement_batch_created`, `settlement_items_paid`, `settlement_item_released`, `settlement_batch_cancelled`).

## 7. Rollback
Header of the migration. Nothing outside the new objects depends on them. The seller screens fall back to "couldn't load" if the functions are absent, so roll back the app first.

## 8. Decisions still yours
* **Tax and compliance**: paying sellers without PAN/bank KYC may have implications for TDS on e-commerce payouts (s.194-O) and GST TCS; collecting money on sellers' behalf may also matter. Confirm with your CA before the first real run. Not handled in code and not legal advice.
* **Holding buyer money for up to a month** while sellers wait: decide the minimum payout (tiny balances can roll over; not built) and tell sellers the payout date (done in the UI).
* **UPI limits per transaction / per day** apply to your own bank or app when you send the payments.
* **Account-takeover risk**: a changed UPI ID is paid at the next run. The desk flags recent changes; re-authentication or email confirmation before a changed ID is paid is not built.
* **KYC retention** of old `seller_kyc` data (unchanged open item).
