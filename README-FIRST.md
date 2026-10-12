# Milestone 5.1 -- webhook payment fulfilment

Copy every file here into the same path in your repo (they are all new except the four marked *changed*).

*changed*: app/api/razorpay/create-order/route.js, app/api/razorpay/verify-payment/route.js, tests/phase4/m44-db.test.mjs (2 tiny fixture fixes
so the M4.4 DB tests also run on the real schema), INTEGRATION.md (appended a 5.1 section).

Order: (1) read supabase/manual/phase5_review_golive.md  (2) apply the migration to a branch/backup  (3) set the two env vars
(4) deploy  (5) add the Razorpay webhook  (6) smoke test  (7) only then run the manual policy-closing script.
New package needed: none (@supabase/supabase-js is already a dependency).
