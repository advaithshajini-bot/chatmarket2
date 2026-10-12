# Milestone 4.4 -- integration points in files that were NOT in the handoff zip

The handoff contained migrations, the worker, and the M4.2/M4.3 deliverables, but not the existing pages. These two
edits are one-liners in files I could not see; everything else in this delivery is new files or overlays on M4.3 files.

1. `app/sell/page.jsx` -- for each of the seller's workflow/agent listings add a link:
       <Link href={`/sell/studio/${listing.id}`}>Demo & blueprint</Link>
2. `app/admin/page.jsx` -- add a link to the desk:
       <Link href="/admin/reviews">Moderation desk</Link>
Both pages already work when visited directly: /sell/studio/<listing id> and /admin/reviews.

Assumptions to confirm against the real project (see README "Known gaps"):
  * `profiles.is_admin` exists (the page gate reads it; the RPCs use private.is_admin_mfa(), which must already exist).
  * `/login?next=` is your login route.

---

## Milestone 5.1 -- payment fulfilment (webhook)

Files: `supabase/migrations/20261012100000_add_payment_fulfilment.sql`, `lib/payments/*`, `app/api/razorpay/webhook/route.js`,
modified `app/api/razorpay/create-order/route.js` and `verify-payment/route.js`, `tests/phase5/*`,
`supabase/manual/phase5_review_golive.md`, `supabase/manual/phase5_close_purchase_insert_policy.sql`.
New server env vars: `SUPABASE_SERVICE_ROLE_KEY`, `RAZORPAY_WEBHOOK_SECRET`. No client-side change; no feature flag involved.
