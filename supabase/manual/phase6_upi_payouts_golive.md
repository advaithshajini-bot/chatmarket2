# Milestone 5.4 — instant UPI payouts (non-recourse): go-live runbook

**Status when this was written: built and tested in MOCK mode only.** Everything below that touches RazorpayX (contacts, fund accounts, payouts,
`payout.*` webhooks, IP allowlisting) follows Razorpay's documentation but has **never run against a real account**. Do the validation in
section 3 on a TEST-mode RazorpayX account before anything else. All flags are OFF. Nothing here was applied to production.

## 0. What changed, in one paragraph
Sellers add one thing, a UPI ID, on `/sell/payout` (no documents, no bank details). When a sale is paid, the seller's share
(price − platform fee, integer paise) is sent to that UPI ID through RazorpayX Payouts, with no hold and no dispute reaction. All sales are final:
nothing in the system ever debits a seller, creates a negative balance, or claws money back. A buyer chargeback is a platform expense handled
outside the seller's ledger. Disputes stay as customer-support tickets and move no money. The older Route / hold / dispute code and tables stay in
the repo and database, dormant (their flags are OFF).

## 1. Files
| what | where |
|---|---|
| migration (additive) | `supabase/migrations/20261018100000_add_vpa_payouts.sql` |
| payout orchestration / events / client | `lib/payments/vpa-payouts.js`, `payout-events.js`, `razorpay-client.js` (payout methods), `webhook-handler.js` (`payout.*` branch), `reconcile.js` |
| seller UI | `app/sell/payout/page.jsx` (single UPI input), `lib/domain/upi.js`, `components/SellerPayoutPanel.jsx`, `lib/domain/seller-payouts.js`, `components/SellerEarningsClient.jsx` |
| listing gate | `app/sell/page.jsx` (UpiGate), `app/api/listings/create-workflow-agent/route.js` |
| admin | `components/AdminPaymentsDesk.jsx` ("UPI payouts" tab, Retry, Pause/Resume), `lib/domain/admin-payments.js` |
| removed | `app/api/kyc/send-otp`, `app/api/kyc/verify-otp` (the KYC wizard they served is gone) |

## 2. Rules the design enforces (each has a test)
* One ledger row per purchase (`vpa_payouts.purchase_id` unique) claimed in the database **before** Razorpay is called; Razorpay's `X-Payout-Idempotency` = the purchase id (`<id>-v2` after an admin retry); a retry after a timeout **lists by `reference_id` first** and adopts an existing payout.
* `processed` is final: a late `failed` / `cancelled` event can never undo it; an admin cannot retry it.
* Fail closed: `cutoff_at` defaults to **infinity** (no purchase is eligible until you set it) and a **₹5,000 per-payout cap** parks bigger payouts for review.
* Route and UPI payouts are mutually exclusive: **if both flags are ON, neither runs.**
* A seller can read only their own UPI ID and status; Razorpay contact/fund-account ids are not granted. Seller UPI writes go only through `set_my_payout_vpa` (format-checked, max 5 changes/24h, audited with a masked ID). Changing the ID drops the old Razorpay fund account; a suspension survives the change.
* The seller screens and the admin desk contain no negative balance / debt / recovered-loss / clawback concept (static test over the files and SQL).

## 3. Validate against RazorpayX TEST mode first (nothing below is verified)
Create a RazorpayX account in test mode, then confirm each item and tell me what differs; `razorpay-client.js` and `payout-events.js` are the only files to change.
1. `POST /v1/contacts` with `{name, type: "vendor", reference_id}` returns `id` = `cont_…`.
2. `POST /v1/fund_accounts` with `{contact_id, account_type: "vpa", vpa: {address}}` returns `id` = `fa_…` and echoes `vpa.address`.
3. `POST /v1/payouts` with `account_number` (the **RazorpayX** account number, different in test and live), `fund_account_id`, `amount` (paise, ≥100), `currency`, `mode: "UPI"` (case-sensitive), `purpose: "payout"`, `queue_if_low_balance`, `reference_id` (≤40 chars), `narration`, `notes`, header `X-Payout-Idempotency`. Check: the same key returns the same payout (and for how long), `reference_id` is accepted at 39 chars (`<uuid>-v2`), and the response status values match `queued|pending|processing|processed|rejected|cancelled|reversed|failed`.
4. `GET /v1/payouts?account_number=…&reference_id=…` really filters by `reference_id` (the retry path depends on it). **If it does not, tell me; lookup-first must change.**
5. Webhooks (RazorpayX dashboard → Developer Controls): events `payout.initiated|processed|failed|reversed|updated` with `payload.payout.entity`. Our endpoint verifies the signature against `RAZORPAY_WEBHOOK_SECRET`; RazorpayX webhooks may use their **own** secret: if so, either set the same value or tell me (separate-secret support is not built).
6. A UPI payout to a wrong/nonexistent VPA: which status/`status_details.reason` comes back (we map `rejected`→failed, and `reversed`→returned by the bank).
7. **IP allowlisting**: payouts from live mode need your server IPs allowlisted. Vercel serverless functions have no fixed IPs on the plans I could see; options are Vercel's static-IP offering (paid), or a small fixed-IP proxy for the three payout calls. Decide this before live.
8. **Balance**: payouts spend your RazorpayX balance. It must be topped up (and kept topped up) before sales happen; with `queue_if_low_balance` the payout waits as `queued` and the desk shows "UPI payout queued (check RazorpayX balance)" after an hour.

## 4. Env vars (names only)
`RAZORPAYX_ACCOUNT_NUMBER` (new, Vercel), plus the existing `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`. Without `RAZORPAYX_ACCOUNT_NUMBER` no payout request is ever sent (code `payouts_not_configured`).

## 5. Apply and switch on (only when you decide to; each step is yours)
1. Test locally / on a scratch DB first: `PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL=… node tests/phase5/run-all.mjs` (empty scratch DB only).
2. Apply `20261018100000_add_vpa_payouts.sql` to production (additive; flag OFF; nothing changes for buyers). Deploy the app code.
3. Smoke test with the flag still OFF: `/sell/payout` saves a UPI ID; `/sell/earnings` shows the new wording; `/admin/payments` has the "UPI payouts" tab.
4. When section 3 is done and the RazorpayX balance is funded, enable for **new sales only**:
```sql
update private.vpa_payout_config set cutoff_at = now() where id;                       -- old sales are never paid retroactively
-- optional: raise/lower the per-payout cap (paise)  update private.vpa_payout_config set max_payout_paise = 500000 where id;
update private.feature_flags set enabled = true where name = 'phase6_vpa_payouts';     -- Route flags must stay false
```
5. Make one small real sale, watch it: ledger row `creating` → `queued/processing` → `processed` (UTR recorded), `/sell/earnings` shows "Instant payout: Paid".
6. The minute-level sweep (`/api/payments/transfers/sweep`, `CRON_SECRET`) retries failed attempts and polls payouts whose webhook never arrived. It is **still unscheduled and untested** against a real deployment (see `phase5_2c_schedule_sweep.sql`).

## 6. Rollback / kill switches
* Stop all new payouts: `update private.feature_flags set enabled = false where name = 'phase6_vpa_payouts';` (in-flight payouts keep being polled and recorded).
* Stop one seller: Pause in `/admin/payments` → Seller balances (or `admin_set_seller_payout_status(uuid,'suspended')`).
* Money already sent cannot be recalled by us. A payout shown as `failed` / `returned` is retried by an admin (`Retry payout`) **only after** you confirm in the RazorpayX dashboard that the money did not leave; the retry uses a new idempotency key.
* Full rollback of the schema: see the header of the migration file.

## 7. Known gaps and things to decide (honest list)
* **Chargebacks and negative balances are deliberately not modelled**, per your decision: a chargeback is a platform cost, handled manually and never on a seller's ledger.
* The dispute form is still a form; an admin "resolve as refunded" in the old `/admin` flow still marks a purchase `refunded` (and, with Route off, does nothing to money). Relabelling that admin action is a follow-up.
* Sellers with approved KYC but no UPI ID can no longer create listings until they add one. Their old KYC records and uploaded documents remain stored (`seller_kyc`, bucket `seller-kyc-documents`): decide on a retention/deletion policy.
* A wrong UPI ID, or an account takeover that changes the UPI ID, sends money to the wrong place and it is irreversible. Mitigations built: 5 changes/24h, masked audit log, ₹5,000 cap, admin Pause. Not built: re-authentication, email confirmation or a cool-down before a changed ID is paid.
* Tax and compliance are not handled in code and this is not legal advice: paying sellers without collecting PAN/bank KYC may have implications for TDS on e-commerce payouts (section 194-O), GST TCS, and Razorpay's own payout conditions. Check current rules and rates with your CA and with Razorpay before going live.
* "All sales are final" is shown to sellers. Buyer-facing checkout / refund-policy copy was not requested and not changed.
* The shapes in section 3 are unverified. UPI per-transaction limits and RazorpayX plan limits were not checked.
