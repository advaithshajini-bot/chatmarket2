# Legal copy, settlement desk and listing rules (migration 20261030100000)

Apply (you run it; nothing was run on production): `supabase/migrations/20261030100000_listing_rules.sql`, then deploy the app files.

- Copy: terms, about, help, for-sellers now state the 18% platform fee, platform-collected payments and a monthly bank transfer (IMPS/NEFT) around the 1st; "no commission / 100% settled / split" removed; "All sales are final" and Grievance Officer retained.
- Settlement desk: "Download Settlement CSV" (6 columns, Remarks = `Chatmarket payout <label> - Ref <UTR>`); Pause shown for active accounts, Resume for paused ones, in the preview, blocked list and batch items.
- Listing rules: title >= 10, description >= 500, zip note >= 250 (playbooks), price 50-999 rupees. Form counters + disabled submit; enforced for playbooks by a DB trigger (CM081) and for workflow/agent by the API route too. Only a seller's own new listings are checked; existing listings and later edits are unaffected.
- Note: the old tests that inserted tiny listings as a seller were updated to use valid text.
