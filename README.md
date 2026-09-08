# chatmarket

A marketplace for buying and selling working AI chat threads (Claude, ChatGPT, Gemini) —
"continue where they left off," instead of starting from a blank prompt.

This build runs on a real Supabase project: Postgres tables with Row Level
Security, and Supabase Auth for signup/login/sessions. Every screen reads
from and writes to the real database now — browse, checkout, seller upload,
seller earnings, seller dashboard, admin moderation, buyer library, purchase
history, and reviews. Checkout runs on real Razorpay (Orders API + server-side
signature verification) as of Phase 1 — see below. Route (splitting payment
to sellers, real payouts) is still Phase 2, pending Route approval on the
Razorpay account.

## Stack
- Next.js 14 (App Router), plain JS (no TypeScript)
- Tailwind CSS for layout utilities, inline styles for the design-token colors/fonts
- lucide-react for icons
- Supabase — Postgres + Auth, via `@supabase/supabase-js` and `@supabase/ssr`

## Changelog — fixes and additions since initial build
Running log of what's changed since the app first went live on real data,
newest first.

- **Admin can download a seller's uploaded document** — the admin
  moderation queue (`components/AdminQueueClient.jsx`) already had a "Show
  full thread" toggle; added ".txt" and ".json" download buttons next to
  it, generated client-side from the same thread data (there's no separate
  original-file blob stored — the parsed messages are the source of truth
  once uploaded).
- **Home page "How it works" rewritten for buyers** — it previously
  described the *seller's* flow (list → we screen it → buyer unlocks it),
  which doesn't explain anything to someone landing on the site with no
  idea what a "thread" even is. Rewritten around what a buyer is actually
  getting and what to do with it: find a thread already like your problem
  → unlock the full conversation → paste it into a new Claude/ChatGPT/
  Gemini chat to keep going, or pull the code/draft straight from the
  downloaded file into your own project. (Kept to 3 steps, matching the
  section's existing 3-column layout.)
- **Home page hero: search bar instead of a tagline** — replaced "For
  builders tired of the blank prompt" with a real search input, visually
  identical to Browse's. Since the home page doesn't load the full listings
  dataset the way Browse does (it only ever fetched category counts and
  aggregate stats — no data to filter client-side), it submits to
  `/browse?q=<query>` rather than filtering in place. Added `?q=` support
  to `BrowseClient.jsx` (it already read `?category=`) so landing there
  pre-fills the search box and runs the exact same live ranking Browse's
  own search bar does — at that point it's the same input, not an
  imitation of it.

- **Selling flow reordered: KYC first, then uploads, then the real
  dashboard** — previously a seller could upload and list threads with no
  identity verification at all; KYC was a separate, optional step reachable
  from a dashboard banner, unconnected to upload access. `/sell` now gates
  on `seller_kyc.status`:
  - Not yet `approved` (no record, `draft`, `submitted`, `needs_changes`,
    or `rejected`) → a new `KycGate` screen with status-specific messaging
    and a link into the payout/KYC wizard. No upload wizard, no dashboard.
  - `approved`, but no listing has gone `live` yet → the upload wizard is
    available, and a lightweight `AwaitingApprovalStep` view shows
    submitted listings and their status, rather than the full dashboard.
  - `approved` with at least one `live` listing → the full dashboard.
  Existing sellers landing on `/sell` now default straight to their
  dashboard/status view instead of the upload wizard if they already have
  any listings (previously always defaulted to the upload wizard with a
  manual link to the dashboard). Added "+ List another thread" to both the
  full dashboard and the awaiting-approval view, since there was
  previously no way back into the wizard once past the first listing;
  fixed a latent bug this exposed where reopening the wizard would have
  reused the previous listing's stale form data and id.
  **One-time note**: the only existing seller account in the database had
  2 live listings but KYC still at `submitted` — approved it directly so
  this change doesn't retroactively lock them out of their own dashboard.
- **Full seller dashboard now includes real analytics** — added a
  "Purchases" stat (total units sold across every listing), a "Review
  analysis" section (average rating, star breakdown, most recent reviews
  with comments), and a "Reported issues" section (disputes filed against
  the seller's listings, with status and any resolution note). All three
  read data the seller already had RLS permission to see
  (`private.owns_listing()` already covered purchases and disputes; live
  listings' reviews are publicly readable) — no new database policies
  needed.

- **Content trims** — removed "Still stuck? Reach out from the contact
  address in your account settings." from `/help`, and removed the "10.
  Contact" section from `/terms`.
- **Home page hero text updated.**
- **Manage cookies modal: mobile back button fixed** — on mobile, the
  modal didn't push any history state of its own, so pressing the phone's
  back button just ran the browser's normal back navigation and landed on
  whatever page happened to be before it in history — different every
  time, and looked like the modal was randomly sending people elsewhere.
  `CookiePreferencesModal.jsx` now pushes a history entry while open
  (mobile viewports only, matching the app's existing `sm` breakpoint) and
  listens for the back button to close the modal instead of navigating
  away; closing it any other way (X, backdrop, Save, Reset) cleans that
  entry back up so a later back-press behaves normally. Desktop is
  untouched — no history manipulation happens above that breakpoint.

- **Loading / 404 / offline / permission-denied screens** — added
  `app/loading.jsx` (Next.js's automatic loading UI during route/data
  loading), `app/not-found.jsx` (shown for any unmatched URL or a manual
  `notFound()` call), `components/OfflineScreen.jsx` (mounted globally in
  the root layout; watches the browser's online/offline events and shows a
  full-screen takeover with a "Try again" button when the connection
  drops), and `components/PermissionDenied.jsx` (a reusable "you don't have
  permission" screen — `/admin`'s existing "your account doesn't have
  admin access" case now uses this instead of its own one-off markup).
- **Copyright line moved into the site-wide footer** — "© 2026 chatmarket.
  Not affiliated with Anthropic, OpenAI, or Google." only ever appeared at
  the bottom of the home page. Removed the "Not affiliated..." sentence
  entirely, and moved "© 2026 chatmarket" into `SiteFooter.jsx` (next to
  About us), so it now shows on every page the same way the footer links do.

- **AAL2 enforcement extended to every login-gated page** — the same gap
  fixed on `/admin` existed on `/purchases`, `/library`, `/library/[id]`,
  and `/sell/earnings`: each only checked "is there a session", so an
  MFA-enrolled account with an unverified (aal1) session could reach real
  purchase history, library, or earnings data before ever completing the
  challenge. Added `lib/supabase/get-verified-user.js`, a server-side
  counterpart to the client's `use-auth-user.js` hook, and switched all of
  these pages (including `/admin`, refactored to use it too instead of its
  own inline copy of the same check) to use it in place of a raw
  `supabase.auth.getUser()`. `/admin/security` (MFA enrollment itself)
  intentionally still doesn't require aal2, for the same reason as before.
  One small behavior change on `/admin`: it now shows the same "you need to
  log in" prompt as these other pages instead of an automatic redirect —
  same protection, just consistent with the rest of the site.
- **Seller payout KYC now has a real admin approval step** — submitting
  payout KYC used to be treated as "payout setup complete" on its own, with
  no admin sign-off actually happening (there wasn't even a database policy
  letting an admin update a KYC record). Added `approved` / `rejected` /
  `needs_changes` statuses alongside the existing `draft`/`submitted`, plus
  `admin_note` and `reviewed_at` columns. A new admin panel section
  (`components/AdminKycReviewClient.jsx`) shows a seller's full submitted
  identity details -- name, father's name, DOB, PAN + document, Aadhaar
  (last 4) + document, verified mobile/email, both addresses -- with
  Approve / Modify / Reject actions (Modify and Reject require a note the
  seller then sees on their own dashboard and in the payout wizard).
  **Bank account details still aren't collected or stored anywhere in the
  app** (see "What's not here yet" below), so there's nothing to review
  there yet -- the review UI says so explicitly rather than pretending
  otherwise. The seller dashboard and payout wizard now distinguish
  "submitted, awaiting review" from "approved" -- only `approved` shows
  "Payout setup completed". A database trigger
  (`protect_kyc_review_fields`) stops a seller from setting their own
  record to `approved` (or touching `admin_note`/`reviewed_at`) via a raw
  update call -- they can only ever move their own record to `submitted`.
- **Admins can remove an already-live listing, with a reason** — previously
  once a listing was approved there was no way to take it back down; the
  admin queue only ever showed `pending_review`/`flagged` listings. Added
  `removal_reason` and `removed_at` columns to `listings`, a new admin
  panel section listing every live listing with a "Remove" action that
  requires a reason, and the seller's dashboard now shows that reason under
  the listing (`"Removed by admin: <reason>"`) instead of just a status pill.

- **"Back to" links removed from content pages** — `/about`, `/help`,
  `/privacy`, `/terms`, and `/refund-policy` no longer end with a "← Back
  to Browse" / "← Back to create an account" link.
- **Home page nav: real pages instead of anchor scrolls** — "How it works"
  and "For sellers" used to scroll to short teaser sections on the landing
  page itself (and "For sellers" actually scrolled to a *checkout methods*
  section, not anything about selling). They now link to two new, detailed
  pages written for someone who's never heard of buying/selling AI chat
  threads before: `app/how-it-works/page.jsx` (buyer's point of view) and
  `app/for-sellers/page.jsx` (seller's point of view). "Categories" is now
  a hover dropdown (desktop only, matching how the rest of that nav row
  already hides on mobile) listing every category with its live listing
  count, each linking straight to `/browse?category=<name>`.

- **Site footer moved to every page, centered** — `SiteFooter` was only
  rendered on `/browse`. Moved it into the root layout (`app/layout.jsx`)
  instead, so it now appears on every page of the site with a single
  change rather than needing to be added to each page individually. The
  links are now center-aligned within their own max-width container
  (previously left-aligned).

- **Browse page footer** — added `components/SiteFooter.jsx` to `/browse`
  with About us, Help center, Privacy policy, Terms, Refund Policy, and
  Manage cookies. Created the four new pages this needed
  (`app/about`, `app/help`, `app/privacy`, `app/refund-policy`) — all
  placeholder copy consistent with how the app actually behaves (48-hour
  dispute window, Razorpay handling payments, etc.), not reviewed legal
  text. "Terms" reuses the existing `/terms` page. "Manage cookies" opens
  `components/CookiePreferencesModal.jsx`, a real (if simple) preference
  center — Required/Analytics/Social Media/Advertising categories, saved to
  `localStorage`; nothing in the app currently reads these preferences to
  actually gate any tracking, since there's no analytics/ads integration to
  gate yet.
- **Admin MFA bypass via direct navigation, closed** — `/admin` only ever
  checked the raw `profiles.is_admin` flag before rendering the *entire*
  dashboard, including the user list (which, being publicly readable via
  RLS, wasn't blocked by the earlier `is_admin()` aal2 fix at all). Tapping
  "Admin" in the nav before completing the MFA challenge rendered the full
  page instead of being turned away. `/admin` now checks the session's AAL
  the same way `private.is_admin()` does, and redirects to
  `/login?next=/admin` (signing out the incomplete session first) if an
  MFA-enrolled admin hasn't reached aal2 yet. (`/admin/security`, the MFA
  *enrollment* page itself, intentionally still doesn't require aal2 --
  otherwise a first-time admin could never enroll.)

- **Admin MFA is now actually enforced, at the database level** — the
  login page always presented a "enter your 6-digit code" screen for admin
  accounts with TOTP enrolled, but nothing ever checked that it was
  completed: `private.is_admin()` only checked `profiles.is_admin`, so a
  password-only (aal1) session was fully trusted by every admin-gated RLS
  policy. Navigating away from the MFA screen (e.g. clicking Browse/Sell/
  Library/Purchases before entering the code) worked because the session
  itself was already genuinely valid — the "mandatory" step wasn't wired to
  anything. Fixed `private.is_admin()` so that, for an account with a
  *verified* TOTP factor, it now also requires the session to be `aal2` —
  admin accounts with no MFA enrolled are unaffected. This blocks admin
  reads/writes at the database itself, not just in the UI.
- **App-wide "logged in" state is now AAL-aware** — added a shared
  `lib/supabase/use-auth-user.js` hook (used by both `TopNav` and
  `MobileTabBar`, replacing their separate copies of the same logic). If a
  session only satisfies aal1 for an account that has MFA enrolled, the
  hook signs it out and treats the visitor as logged out everywhere except
  the pages that are themselves mid-flow (`/login`, `/signup`,
  `/forgot-password` — where this check is skipped so it doesn't kill the
  very session those pages need to finish their own verification step).
- **Forgot password switched from a code to a link** — the previous version
  asked for a 6-digit code, which requires customizing Supabase's password
  recovery email template to include `{{ .Token }}`; that setting isn't
  available on this project's (free-tier) Supabase plan. Rebuilt
  `/forgot-password` around Supabase's default recovery **link** instead:
  request it, check your email, click it. The "set new password" screen
  can now *only* be reached by Supabase's `PASSWORD_RECOVERY` auth event
  firing (i.e. actually clicking the emailed link) — there's no button that
  skips to it, closing the gap where a password could effectively be
  "reset" without ever verifying the email.

- **Terms and Conditions on signup** — `/signup` now has a required checkbox
  ("I agree to the Terms and Conditions") gating the Create account button;
  it links to a new `/terms` page. Update the copy in `app/terms/page.jsx`
  with your actual legal terms before launch — what's there is placeholder text.
- **Forgot password link added to `/login`** — a "Forgot password" link now
  sits under the password field, leading to `/forgot-password` (see the link-
  based rewrite of that flow further up this changelog).
- **Razorpay: EMI, Wallet, and Pay Later disabled** — checkout now explicitly
  passes `method: { wallet: false, emi: false, paylater: false }` to the
  Razorpay checkout config, regardless of which payment option the buyer
  picks in our own UI, so those three never appear inside the Razorpay modal.
- **Listing page auto-detects an existing purchase** — previously a buyer who
  already owned a thread would still see the payment form until they clicked
  Pay (which then 409'd and revealed "Unlocked"). It now checks Supabase for
  an existing paid purchase on page load and shows "Unlocked — check your
  library" immediately, with no click required.
- **Admin queue shows the full uploaded thread** — previously capped at the
  2-message buyer preview. Price and description (as set by the seller) are
  now clearly labeled, and a "Show full thread" toggle reveals every message
  the seller uploaded, for real moderation instead of a 2-message glimpse.
- **`listings.rating` / `listings.reviews` now reflect real reviews** — these
  were denormalized columns that had drifted from the actual `reviews` table
  (some listings showed a rating/count with zero real reviews behind them).
  Added a Postgres trigger (`sync_listing_rating`, in `docs/supabase-schema.sql`)
  that recalculates both from `reviews` on every insert/update/delete, and
  backfilled existing rows. This fixes Browse, the listing page, and anywhere
  else these columns are read, with no per-page code changes.
- **Dispute filing bug fixed at the database level** — `disputes.status`'s
  column default had been corrupted into the literal string `'open'::text`
  instead of evaluating to `open`, so every dispute submission failed
  `disputes_status_check`, regardless of timing. Fixed the default directly;
  the app now also sets `status: "open"` explicitly on insert rather than
  relying on the column default at all.
- **Real 48-hour dispute filing window** — previously there was no time limit
  on filing a dispute at all (despite checkout promising "funds held for 48
  hrs"). Added a database-level policy restricting dispute inserts to within
  48 hours of `purchases.purchased_at`, plus a matching friendly message in
  the UI ("48 hours have lapsed from purchase...") once that window closes.
- **"Paid via" now reflects the real Razorpay payment method** — previously
  stored whichever button the buyer clicked in our own UI before the Razorpay
  modal opened, which didn't always match what they used inside the modal.
  The server now fetches the payment record from Razorpay's Payments API
  after verification and stores the actual `method` field.
- **48-hour rating hold removed** — buyers can now rate a purchase
  immediately from their Library instead of waiting 48 hours.
- **Library thread display capped** — the full purchased thread now shows at
  most 6 messages on screen, each clamped to 2 lines with a trailing ellipsis,
  for readability. Copy for Claude/ChatGPT/Gemini and Download as .txt are
  unaffected — they always operate on the complete thread.
- **Browse and listing page message previews clamped** — the 2 real preview
  messages shown in a locked box are now visually capped to 2 lines each
  (`line-clamp-2`) instead of rendering arbitrarily long text.
- **Listing page layout fix** — the payment sidebar no longer forces extra
  blank space under the title on desktop (it previously occupied a single
  grid row shared with the short title block, forcing that row to match the
  tall payment card's height). It now spans the same set of rows as the rest
  of the page content, which also lets its `sticky` positioning follow the
  page properly.
- **Admin approve/reject made robust** — "Approve & publish" and "Send back
  to seller" now verify the database update actually applied (Supabase
  doesn't error on an update matching 0 rows, e.g. if blocked by RLS), and
  the seller's own dashboard now labels these outcomes "Approved" / "Rejected"
  instead of "Live" / "Flagged".
- **Sell dashboard payout status fixed** — previously always showed "Payout
  setup isn't complete" regardless of actual status, and completing payout
  setup was never persisted (re-visiting `/sell/payout` always restarted the
  wizard). Both are now backed by `seller_kyc.status`, and the dashboard
  shows plain text "Payout setup completed" once done.
- Removed the "(penny-drop)" wording from the payout verification screen
  (not being used as a verification mechanism).

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
| `/` | Animated marketing landing page. Stats (threads sold, ₹ paid out to sellers, average rating) come from a `SECURITY DEFINER` RPC (`get_platform_stats()`) rather than querying `purchases`/`reviews` directly — those tables have no public or platform-wide SELECT policy, only "your own", so a direct query showed 0 to a logged-out visitor and an incomplete, personal-only number to a logged-in non-admin buyer. The RPC returns only aggregate totals (never row-level buyer/amount data) so the numbers are identical for every visitor, logged in or not. Per-category thread counts are real, fetched fresh from Supabase on every load. Category pills link to `/browse?category=...`, which `BrowseClient` reads on load to preselect that filter. Nav is auth-aware: logged out shows Log in / Sign up; logged in shows Log out only (was a static, always-shown Log in/Sign up pair regardless of session, unlike the rest of the app's `TopNav`, which already handled this correctly). The hero's sample thread card stays illustrative (a real one would need a specific real listing to point at) | **Supabase** for stats/counts; hero card is illustrative |
| `/browse` | Category-filtered listing grid, with real relevance-ranked search (`lib/search-relevance.js`) across model, title, category, and description — matches sort to the top by field weight (model > title > category > description), and non-matches stay visible below a divider rather than being hidden, by design (searching "claude" surfaces every Claude thread first without hiding the rest of the catalog) | **Supabase (`listings` table)** |
| `/listing/[id]` | Listing detail + real checkout — Razorpay Orders API + Checkout.js, server-side signature verification before a `purchases` row is ever written (`app/api/razorpay/create-order`, `app/api/razorpay/verify-payment`). Also shows every real review on the listing — reviewer name, star rating, date, comment, with a "Verified buyer" badge when the review is genuinely linked to a real purchase — publicly, to any visitor, below the locked-message preview; the rating/review-count line links to `#reviews`. Any logged-in user can write a review here, purchase or not (`ListingReviewForm.jsx`) — by design, not an oversight; see the schema notes on the trust trade-off this makes. Description renders as a titled "Thread details" box. Section order is mobile-specific below the 640px breakpoint (title → gallery → locked preview → payment → description → reviews, via CSS `order`/grid placement, not duplicated markup) — untouched there; above that, desktop/tablet order is title → locked preview → description → gallery → reviews, with the locked-message preview moved up to close a real layout gap (the payment sidebar's height was forcing empty space under the title in the row they shared) | **Supabase + real Razorpay (test mode)** |
| `/library` | Buyer's unlocked threads, with search | **Supabase** (`purchases` joined with `listings`) |
| `/library/[id]` | Full unlocked thread + "continue this thread" panel (copy-to-clipboard + real .txt download) + star rating & review — reviewable any time after purchase, no waiting period | **Supabase** — including a real `reviews` table; a purchased listing stays visible even if later flagged/removed by moderation |
| `/purchases` | Order history & receipts, filterable by paid/refunded. Buyers can report an issue on a paid order, which opens a real dispute the admin resolves. | **Supabase** |

**Seller side**
| Route | What it is | Backed by |
|---|---|---|
| `/sell` | Gated on login — visiting or clicking "Sell" while logged out redirects straight to `/login?next=/sell` before the wizard ever renders, not just at final submit. Upload wizard (3 steps: upload → details → price, per the UX flow PDF) → real redaction scan → dashboard showing your real listings, sales count, and revenue. Returning sellers get a shortcut past the wizard straight to the dashboard. Step 1 does real client-side parsing of a dropped `.json`/`.txt` export (`lib/parse-thread-export.js`) — Claude's `chat_messages` shape, ChatGPT's `mapping` shape, a generic `{role,content}` array (possibly nested inside a wrapper object, e.g. `{ conversation_export: { messages: [...] } }` — tested against a real seller-submitted file), and a plain-transcript fallback (labeled `User:`/`Assistant:` lines, or blank-line-separated paragraphs if no labels at all). Also strips a leading UTF-8 BOM and normalizes `\r`-only line endings before parsing — both silently broke parsing and were traced to real mobile share-sheet/notes-app exports, not guessed. Model detection also checks JSON metadata fields (e.g. a `"platform"` field), not just the filename. Wrong file types and files with no detectable messages are rejected outright with a specific error — there's no manual-entry escape hatch, so Continue is blocked until a real parse succeeds. The submit step runs `lib/redact-pii.js` — a real pattern-matching scanner (emails, phone numbers, Luhn-validated card numbers, and common API-key/token shapes: AWS, Stripe, GitHub, Slack, OpenAI, JWT) — over title/description/thread before any of it is saved; the unredacted text is never persisted. Anything caught routes the listing into `flagged` instead of `pending_review`, and the findings (type + count, never the raw sensitive value) show on both the seller's confirmation screen and the admin queue. Also uploads up to 4 output screenshots to a real Supabase Storage bucket (`listing-screenshots`), shown as a swipeable gallery on the listing page. | **Supabase** |
| `/sell/payout` | Real KYC data collection (personal details, PAN, Aadhaar, address, mobile/email OTP verification) — genuinely saved to Supabase, with real document uploads to a private storage bucket. Bank account + linked-account creation stay UI-only simulation, Phase 2, pending Route approval — see below for exactly which parts are real vs. not | **Supabase for KYC data + documents**; bank/linked-account creation still simulated |
| `/sell/earnings` | Real gross/net/refunded totals, an 8-week earnings chart, and every sale transaction with the buyer's name. Payout history is honestly marked as not-yet-real — no batched settlement exists without real Razorpay. | **Supabase** |

**Platform side**
| Route | What it is | Backed by |
|---|---|---|
| `/admin` | Moderation queue for real `pending_review`/`flagged` listings — expand a row to see the description and preview messages before deciding, then approve & publish / send back to seller / remove. A user-management section: search signed-up users and grant/revoke admin access, with a confirm step before removing your own access. A disputes section: resolve buyer-filed disputes by refunding (flips the linked purchase to `refunded` atomically) or denying, with a note back to the buyer. Gated by `profiles.is_admin`, enforced by RLS — verified directly against Postgres, not just hidden in the UI. | **Supabase**, entirely |

**Auth**
| Route | What it is |
|---|---|
| `/login` | Real login via Supabase Auth (`signInWithPassword`). `TopNav`'s Log in / Sell a thread links are hidden here (`hideAuthLinks`) since they're redundant on the login page itself |
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

## Admin panel isolation & MFA (2FA)

Every admin query/mutation was already gated by RLS's `private.is_admin()`
check — the real security boundary. This adds two more real layers on top,
addressing "what if someone finds the URL" and "what if someone steals an
admin password" separately, since those are different problems:

**Host-based isolation (`middleware.js`).** `/admin` is hidden entirely
from the main site's domain — a request for it there gets a flat 404
before any auth check even runs, rather than a redirect (which would
still confirm the route exists). It only responds once `ADMIN_HOST` is
set as an env var, pointing at a second deployment of this same repo:

1. In Vercel, import this same GitHub repo again as a **new project**
   (e.g. `chatmarket-admin`) — same repo, same build, no code changes.
2. Give that new project the same environment variables as the main one
   (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, Razorpay
   keys aren't needed there but don't hurt), **plus** `ADMIN_HOST` set to
   whatever domain that new project ends up with (its auto-assigned
   `*.vercel.app` domain, or a custom domain like `admin.yourdomain.com`
   if you have one).
3. Set `ADMIN_HOST` to that **same** value on the **main** project too
   (`chatmarket2` / whichever one is live) — both deployments need to
   agree on what counts as "the admin host" for the 404/redirect logic to
   work correctly on both sides.
4. Once both are set, `/admin` 404s on the main site and only works on the
   admin deployment; the admin deployment redirects everything except
   `/admin` and `/login` back to `/admin`.

Leaving `ADMIN_HOST` unset (the default) disables this entirely — safe to
deploy before you've set up the second project.

**MFA (`/admin/security`, real TOTP via Supabase Auth).** Sensitive admin
writes — approving/rejecting listings, granting admin access, resolving
disputes — now require the session to be MFA-verified (`aal2`), not just
logged in as an admin (`aal1`). Viewing the panel doesn't require it, so
nobody's locked out of the ability to go enroll. **Enroll immediately
after deploying this** — until you do, every admin write will fail with
"not authorized", which is the intended behavior but will be confusing if
you hit it before setting up MFA. Once enrolled, `/login` prompts for the
6-digit code automatically on future sign-ins for that account — regular
buyer/seller accounts are unaffected since they never enroll.

## Seller KYC (`/sell/payout`) — what's real and what isn't

The account-type step (proprietorship/partnership/private limited/individual)
was removed — "Set up payout" now goes straight to a detailed personal-KYC
form (`seller_kyc` table), matching a real government KYC form layout.

**Real:**
- Every field is genuinely saved to Supabase (`seller_kyc`, one row per
  seller, RLS-scoped to the seller themselves + admins)
- PAN document and Aadhaar document uploads go to a real, **private**
  Supabase Storage bucket (`seller-kyc-documents`) — unlike
  `listing-screenshots`, this bucket is not public; only the uploading
  seller and admins can ever read these files (verified with the same
  path-ownership RLS tests as the other buckets)
- PAN format validation is real (`ABCDE1234F` pattern)
- Mobile/email OTP is a real, working mechanism end to end: a 6-digit code
  is generated, hashed (SHA-256) and stored with a 5-minute expiry and a
  5-attempt limit, and verification genuinely checks against it
  (`app/api/kyc/send-otp`, `app/api/kyc/verify-otp`)

**Not real, by explicit choice, clearly labeled in the UI itself:**
- **OTP delivery.** No SMS provider (Twilio, MSG91, etc.) or transactional
  email service is connected, so instead of pretending to send the code,
  the send-otp response returns it directly with `devMode: true`, and the
  UI shows it in a clearly-labeled banner ("No SMS/email provider is
  connected yet..."). The verification logic itself is real; only delivery
  is stubbed. Swapping in a real provider means replacing the `devOtp`
  return with an actual send call — the rest of the flow doesn't change.
- **PAN/Aadhaar verification against the actual government database.**
  This needs a licensed KYC provider (or Razorpay Route's own stakeholder
  KYC once Route is approved on the account — the more likely long-term
  path, since a second separate verification vendor would be redundant
  with what Route already does). "Verify income tax PAN" only confirms the
  *format* is valid and says so explicitly, rather than showing a green
  "Verified ✓" that would misrepresent what actually happened.
- Aadhaar: only the **last 4 digits** are stored, never the full number —
  UIDAI has real restrictions on storing full Aadhaar numbers, and the
  uploaded document image is what a human reviewer would need anyway.
- Bank account entry and the "linked account created" step (step 2/3 of
  the wizard) remain the same UI-only simulation as before.

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
- **Any logged-in user can review any live listing — a purchase is not
  required.** This is a deliberate trust trade-off, not an oversight: the
  landing page's pitch ("trust that what you're buying actually works")
  implicitly leans on reviews being from real buyers, and opening reviews to
  anyone weakens that signal — a seller's friend, or a competitor, can post
  a review with nothing behind it. To preserve at least some of the signal,
  a review is still linked to a real purchase when the reviewer genuinely
  has one (shown as a "Verified buyer" badge); RLS enforces that this link
  can't be spoofed with someone else's purchase id. One review per user per
  listing either way (`reviews_listing_user_unique`)

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
- Razorpay Route (splitting payment to sellers, real payouts) — checkout
  itself is real (Phase 1: Orders API + verified signatures), but funds land
  in the platform account only. Route needs Razorpay to review and approve
  the account for marketplace use before seller payout code can be built
  against real requirements instead of guessed ones. Payout *setup status*
  (`seller_kyc.status`) is now real and persisted — the seller dashboard
  correctly reflects whether it's complete — but no real money movement to
  sellers happens until Route is approved; the "18% platform fee" shown on
  the earnings page (`lib/constants.js`) is still applied for display only —
  no real transfer happens yet. This also blocks the PDF's payout-approvals
  admin screen (`a4`), which needs real settlement data to mean anything
- No webhook handler yet (`payment.captured`, `refund.processed`, etc.) —
  the synchronous verify-payment flow covers the happy path, but a webhook
  is the standard safety net for payments that succeed on Razorpay's side
  after the buyer's browser disconnects before the verify call completes
- Real OCR-based screenshot scanning — the redaction scanner covers text
  (title/description/thread), not uploaded screenshot images; that would
  need an OCR pass, which isn't part of this scanner
- Payout history (`/sell/earnings`) is honestly empty/placeholder — there's no
  real bank settlement without real Razorpay Route transfers
- Server-side search indexing — relevance ranking (`lib/search-relevance.js`)
  runs client-side over whatever `/browse` already fetched, which is fine at
  today's catalog size but wouldn't scale to a large listings table the way
  a real search index (e.g. Postgres full-text search) would
- The PDF's admin flow (`a3`) treats a valid buyer report as "refund + delist"
  — pulling the listing down, not just refunding the order. Kept as refund-only
  for now (current behavior), by choice — a listing staying up after one
  resolved dispute isn't necessarily wrong, and delisting is easy to add to
  `resolve_dispute()` later if that's wanted
