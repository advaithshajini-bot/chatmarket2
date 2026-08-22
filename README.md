# chatmarket

A marketplace for buying and selling working AI chat threads (Claude, ChatGPT, Gemini) —
"continue where they left off," instead of starting from a blank prompt.

This build runs on a real Supabase project: Postgres tables with Row Level
Security, and Supabase Auth for signup/login/sessions. Every screen reads
from and writes to the real database now — browse, checkout, seller upload,
seller earnings, seller dashboard, admin moderation, buyer library, purchase
history, and reviews. Razorpay itself isn't real yet (see below), so no
actual money moves — but every number shown is computed from real rows.

## Stack
- Next.js 14 (App Router), plain JS (no TypeScript)
- Tailwind CSS for layout utilities, inline styles for the design-token colors/fonts
- lucide-react for icons
- Supabase — Postgres + Auth, via `@supabase/supabase-js` and `@supabase/ssr`

## Getting started
```bash
npm install
cp .env.local.example .env.local   # fill in your Supabase project URL + anon key
npm run dev
```
Then open http://localhost:3000

There's no seeded demo login — Supabase Auth manages real accounts. Sign up at
`/signup`. **By default, Supabase requires email confirmation before a new
account can log in.** For frictionless local testing, go to your Supabase
dashboard → Authentication → Providers → Email and toggle off "Confirm email";
otherwise check the inbox you signed up with for the confirmation link.

## Pages

Navigation follows the UX flow spec (`design/chatmarket-app-flow-Final.pdf`): a top
bar on tablet/desktop, and a fixed bottom tab bar (Home / Browse / Sell / Orders / You)
below the 640px breakpoint, rendered once globally from `app/layout.jsx` via
`components/MobileTabBar.jsx` rather than per-page. There's no dedicated account/settings
screen yet, so "You" opens a small sheet with Library/Purchases/Admin + log out instead of
linking to a profile page — see the PDF gap notes below.

**Buyer side**
| Route | What it is | Backed by |
|---|---|---|
| `/` | Animated marketing landing page. Stats (threads sold, ₹ paid out to sellers, average rating) and the per-category thread counts are real, fetched fresh from Supabase on every load — not hardcoded. Category pills link to `/browse?category=...`, which `BrowseClient` reads on load to preselect that filter. The hero's sample thread card stays illustrative (a real one would need a specific real listing to point at) | **Supabase** for stats/counts; hero card is illustrative |
| `/browse` | Category-filtered listing grid | **Supabase (`listings` table)** |
| `/listing/[id]` | Listing detail + real checkout (inserts a `purchases` row) | **Supabase** |
| `/library` | Buyer's unlocked threads, with search | **Supabase** (`purchases` joined with `listings`) |
| `/library/[id]` | Full unlocked thread + "continue this thread" panel (copy-to-clipboard + real .txt download) + star rating & review, gated to 48 hours after purchase per the UX flow PDF — before that, a live countdown replaces the review form | **Supabase** — including a real `reviews` table; a purchased listing stays visible even if later flagged/removed by moderation |
| `/purchases` | Order history & receipts, filterable by paid/refunded. Buyers can report an issue on a paid order, which opens a real dispute the admin resolves. | **Supabase** |

**Seller side**
| Route | What it is | Backed by |
|---|---|---|
| `/sell` | Upload wizard (3 steps: upload → details → price, per the UX flow PDF) → screening animation → dashboard showing your real listings, sales count, and revenue. Returning sellers get a shortcut past the wizard straight to the dashboard. Step 1 does real client-side parsing of a dropped `.json`/`.txt` export (`lib/parse-thread-export.js`) to auto-detect the source model and message count — Claude's `chat_messages` export shape and ChatGPT's `mapping` export shape are handled specifically, everything else falls back to a generic/plain-text parse. Detection is best-effort and always editable, not authoritative. Also uploads up to 4 output screenshots to a real Supabase Storage bucket (`listing-screenshots`), shown as a swipeable gallery on the listing page. | **Supabase** |
| `/sell/payout` | Razorpay linked-account KYC onboarding | UI-only simulation |
| `/sell/earnings` | Real gross/net/refunded totals, an 8-week earnings chart, and every sale transaction with the buyer's name. Payout history is honestly marked as not-yet-real — no batched settlement exists without real Razorpay. | **Supabase** |

**Platform side**
| Route | What it is | Backed by |
|---|---|---|
| `/admin` | Moderation queue for real `pending_review`/`flagged` listings — expand a row to see the description and preview messages before deciding, then approve & publish / send back to seller / remove. A user-management section: search signed-up users and grant/revoke admin access, with a confirm step before removing your own access. A disputes section: resolve buyer-filed disputes by refunding (flips the linked purchase to `refunded` atomically) or denying, with a note back to the buyer. Gated by `profiles.is_admin`, enforced by RLS — verified directly against Postgres, not just hidden in the UI. | **Supabase**, entirely |

**Auth**
| Route | What it is |
|---|---|
| `/login` | Real login via Supabase Auth (`signInWithPassword`) |
| `/signup` | Real account creation (`signUp`), auto-creates a `profiles` row via a DB trigger |

## RLS was verified, not just written
The admin policies were tested directly against Postgres — not just checked by
reading the SQL — using temporary users created and rolled back inside a
transaction (nothing persisted):
- A logged-in **non-admin** user attempting `update listings set status = 'live'`
  affects **0 rows** — RLS silently filters it out
- A logged-in **admin** user (`profiles.is_admin = true`) running the same
  update affects **1 row**, as expected
- An **anonymous** (logged-out) request affects **0 rows**
- Along the way this caught a real bug: the first version of the hardened
  `private.is_admin()` helper revoked `EXECUTE` from the `authenticated` role,
  which would have silently broken the admin path entirely (not a security
  hole — the opposite problem, nothing would have worked). Fixed by granting
  `EXECUTE` back to `authenticated` specifically.

The buyer-access and reviews policies got the same treatment:
- A purchased listing stays fully readable to its buyer even after being set
  to `status = 'removed'` by moderation — a stranger querying the same
  listing gets **0 rows**
- The exact join query `/library` runs (`purchases` × `listings`, filtered by
  `user_id`) returns the right row for the buyer and **nothing** for a
  stranger querying by someone else's `user_id`
- A buyer can insert a review for their own purchase; a stranger attempting
  to insert a review referencing someone else's real `purchase_id` — with
  hardcoded values, not just relying on them being unable to look the ID up —
  gets an explicit `new row violates row-level security policy` error, not a
  silent no-op

Adding the seller-earnings policy hit a real, more serious bug — worth
recording since it's a common trap with cross-referencing tables:
- The first version of "sellers can view purchases of their own listings"
  was a plain subquery against `public.listings`. Since `listings` already
  has its own policy that subqueries `public.purchases` (the buyer-access
  policy above), this created **infinite recursion** — `ERROR: 42P17:
  infinite recursion detected in policy for relation "purchases"` — the
  first time anyone actually queried purchases as a seller.
- Fixed with the same pattern as `private.is_admin()`: a `SECURITY DEFINER`
  helper (`private.owns_listing()`) that bypasses RLS for just that one
  internal ownership check, breaking the cross-reference.
- Re-tested after the fix: seller A querying purchases of their own listing
  gets the row back; seller B querying the same listing's purchases gets
  **0 rows**; and the earlier buyer-can-view-a-removed-listing test was
  re-run to confirm the fix didn't regress it.

Building the admin user-management UI surfaced a real privilege-escalation
hole in the original schema, and then a real bug in the fix:
- The existing "Users can update their own profile" policy had no column
  restriction, so any logged-in user could already call
  `update profiles set is_admin = true where id = auth.uid()` from the
  client and grant themselves admin — this was live before today's fix.
- Closed with a `BEFORE UPDATE` trigger (`private.protect_is_admin_column()`)
  rather than a `WITH CHECK`, since `WITH CHECK` only sees the new row and
  can't tell whether `is_admin` actually changed.
- The first version of that trigger blocked the change whenever
  `private.is_admin()` was false — which is also true for direct SQL-editor
  updates (no JWT, so `auth.uid()` is null), so it would have silently
  broken the documented "grant admin via SQL editor" workflow. Fixed to only
  intervene when there's an authenticated end-user session
  (`auth.uid() is not null`) that isn't itself an admin.
- Re-tested against Postgres directly (temp users, rolled back): a direct
  SQL-editor-style grant still works; a non-admin trying to self-promote is
  silently reset to their old value; an admin granting admin to someone else
  through the app's update path works; a non-admin trying to demote a real
  admin gets **0 rows affected** (RLS, not just the trigger); and a
  non-admin editing an unrelated field on a stranger's profile also gets
  **0 rows affected**.

Real disputes needed one thing purchases never had: a way to change two
tables — the dispute and its linked purchase — together or not at all.
- Resolution is a `SECURITY DEFINER` RPC (`resolve_dispute()`) rather than
  a plain client-side `UPDATE`, so a refund outcome flips
  `purchases.status` to `refunded` in the same transaction as the dispute
  row, and the function re-checks `private.is_admin()` itself instead of
  relying only on RLS.
- Tested directly against Postgres (temp users, rolled back): a buyer can
  file a dispute on their own paid purchase; a different logged-in user
  can't insert a dispute claiming to be that buyer (RLS `WITH CHECK`
  rejects it); the buyer themself calling `resolve_dispute()` on their own
  dispute is rejected (not an admin); the seller of the listing can view
  the dispute but has no `UPDATE` policy on it at all; an admin resolving
  with a refund flips both the dispute to `resolved_refunded` **and** the
  purchase to `refunded`; and calling `resolve_dispute()` a second time on
  an already-resolved dispute is rejected rather than silently overwriting
  the first resolution.

## The Supabase schema
`docs/supabase-schema.sql` is the schema actually applied to the project:

- **`profiles`** — one row per user, auto-created by a trigger on `auth.users` insert
  (`display_name` comes from the signup form via `user_metadata`)
- **`listings`** — the catalog. `status` defaults to `pending_review`; only
  `status = 'live'` rows are publicly readable
- **`purchases`** — one row per unlock, unique per `(user_id, listing_id)` so a
  buyer can't be charged twice for the same thread
- **`disputes`** — one row per buyer-filed issue report, unique per
  `purchase_id` (a buyer can't file twice on the same order). Resolution
  goes through the `resolve_dispute()` RPC, not a direct client-side
  `UPDATE` — it re-checks admin status server-side and, on a refund
  outcome, flips the linked `purchases.status` to `refunded` in the same
  transaction so the two rows can't drift out of sync
- **`listings.screenshots`** — a `jsonb` array of public URLs pointing into
  the `listing-screenshots` Storage bucket (see below), populated at
  listing-submit time from what got uploaded in the sell wizard's step 1

**Storage:** `listing-screenshots` is a public bucket for the output-screenshot
gallery on a listing page. Upload/delete are scoped by path (`<seller_id>/<listing_id>/<file>`),
checked directly against `auth.uid()` from the path itself — not the
`listings` table — since screenshots get uploaded during step 1 of the sell
wizard, before the listing row exists (the wizard generates the listing's id
client-side up front for exactly this reason). Reads are public, matching a
live listing's own visibility. Admins can delete any screenshot; sellers can
delete their own.

All tables have Row Level Security enabled:
- Anyone can read live listings and all profiles
- A seller can read their own listings regardless of status (so a
  `pending_review` listing is visible to the person who submitted it)
- A user can only insert listings/purchases where they are the owner
  (`auth.uid() = seller_id` / `auth.uid() = user_id`) — enforced by Postgres,
  not just app code
- A buyer can only file a dispute on their own `paid` purchase; the
  seller of that listing and admins can view it; only admins can resolve it

To point this app at a different Supabase project, run `docs/supabase-schema.sql`
against it via the SQL editor, then update `.env.local`.

## Where mock data still lives
- `lib/categories.js` — category and source-model options used in filters/forms

That's it — `lib/admin-data.js` has also been deleted now that disputes are
real. `lib/purchases.js`, `lib/purchase-history.js`, `lib/listings.js`,
and `lib/earnings.js` have all been deleted as their pages moved to Supabase —
if you're looking for the shape of the old mock data, check git history or
`docs/data-model.md`.

## Planning docs
`/docs` also carries over the earlier design work:
- `docs/data-model.md` — the original category taxonomy + intended schema sketch
  (superseded in practice by `docs/supabase-schema.sql`, kept for the reasoning)
- `docs/razorpay-integration.md` — checkout, the 48-hr escrow hold, Route
  transfers, and webhooks for when payments go live

## What's not here yet
- Real Razorpay integration — checkout and payout screens are UI-only simulations;
  purchases record instantly with no real payment, and the "18% platform fee"
  shown on the earnings page (`lib/constants.js`) is applied for display only.
  This also blocks the PDF's payout-approvals admin screen (`a4`) — it needs
  real settlement data to mean anything, and Razorpay Route needs a live
  website URL to register, so it's deliberately deferred rather than built
  as another UI-only shell
- The actual redaction scanner — the screening step is a timed animation, not a real scan
- Payout history (`/sell/earnings`) is honestly empty/placeholder — there's no
  real bank settlement without real Razorpay Route transfers
- Search relevance/indexing — the browse search box does simple client-side filtering
- No aggregate rating/review-count rollup on `listings` — reviews are stored
  per purchase in the `reviews` table, but `listings.rating`/`reviews` aren't
  recomputed from them (would need a trigger)
- The PDF's admin flow (`a3`) treats a valid buyer report as "refund + delist"
  — pulling the listing down, not just refunding the order. Kept as refund-only
  for now (current behavior), by choice — a listing staying up after one
  resolved dispute isn't necessarily wrong, and delisting is easy to add to
  `resolve_dispute()` later if that's wanted
