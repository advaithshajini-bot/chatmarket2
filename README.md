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
- JSZip, client-side, for reading a seller's uploaded zip in the browser

## Changelog — fixes and additions since initial build
Running log of what's changed since the app first went live on real data,
newest first.

- **Business model pivot: AI conversations → AI-generated outputs/artifacts**
  — a few connected changes:
  - **Message count and "% complete" removed everywhere they were
    displayed** — listing cards (Browse, home page mockup), the listing
    page, checkout, Library (both the grid and detail view), and the admin
    queue. The sell wizard's completion slider ("How far did you get?") is
    removed too; `listings.completion` is now always inserted as `100`
    (the column is still `not null` in the schema, so it needed some
    value — just nothing sellers set or anyone sees anymore).
    `listings.messages` is still computed and stored in the background
    (kept as metadata, e.g. useful for future search/sorting) but is no
    longer shown anywhere. The sell wizard's description field and
    placeholder text changed from progress-framed ("what's done, what's
    left") to output-framed ("what it is and what it includes").
  - **"Copy for Claude/ChatGPT/Gemini" removed from the Library** — this
    was for continuing a conversation live in a new AI chat, which doesn't
    fit an "outputs" model the way it fit a "conversations" model. The
    sidebar there is now just the zip download, retitled "Your files".
  - This is a scoped, requested change — not a full site-wide rename of
    "thread" terminology to "output"/"artifact". Copy on marketing pages
    (`/how-it-works`, `/for-sellers`, home page sections) still generally
    describes buying/selling "threads"/"conversations". Say so explicitly
    if you want that broader rename done too — it's a bigger, separate
    pass across most of the site's copy.
- **Social icons: color, size, and where they actually show** — three real
  bugs, not just polish:
  - They weren't showing on the home page at all. Root cause: the home
    page (`LandingClient.jsx`) has always used its own hand-built nav,
    entirely separate from the shared `TopNav` component `SocialBar` was
    added to last time — so it never rendered there. Added the same bar to
    `LandingClient.jsx` directly (non-sticky, sits above the home page's
    own sticky nav).
  - They weren't showing on mobile anywhere — the wrapping bar was
    `hidden` below the `sm` breakpoint on purpose, to avoid crowding the
    header. Removed that restriction; the row now wraps (`flex-wrap`)
    instead of hiding on narrow screens.
  - Recolored from muted gray to the site's primary ink color (`#14213D`)
    and sized up from 16px to 20px icons.

- **Google sign-in added to `/login`** — a "Continue with Google" button
  above the existing email/password form (`supabase.auth.signInWithOAuth`),
  plus a new `app/auth/callback/route.js` that exchanges Google's auth code
  for a real session (`exchangeCodeForSession`) and forwards to wherever
  `?next=` pointed. A first-time Google sign-in creates the account
  automatically — Supabase Auth's normal OAuth behavior, no separate
  signup step needed.
  **Action needed, outside what I can configure from here**: this requires
  (1) a Google Cloud OAuth client (Client ID + Secret), (2) the Google
  provider enabled in Supabase's dashboard (Authentication → Providers)
  with those credentials, and (3) `https://<your-domain>/auth/callback`
  (and `http://localhost:3000/auth/callback` for local dev) added under
  Authentication → URL Configuration → Redirect URLs. Without all three,
  clicking the button will fail or redirect back with an error.
- **Home page: "See all" button on Browse by category** — an oval button
  now sits at the end of the category strip, styled distinctly from the
  category cards, linking to `/browse`.
- **Social icons + WhatsApp added to the header** — `components/SocialBar.jsx`,
  shown in a slim bar above the main nav (desktop only, same breakpoint as
  the rest of the nav links) on every page via `TopNav.jsx`: LinkedIn,
  Facebook, Instagram, YouTube, then a WhatsApp icon with the number
  `+91 9150427083` next to it. lucide-react has no WhatsApp glyph, so
  that one's a hand-drawn `currentColor` SVG to match the others instead
  of using WhatsApp's brand green.
  **Action needed**: LinkedIn/Facebook/Instagram/YouTube are placeholder
  `#` links — swap in the real URLs in `SOCIAL_LINKS` in `SocialBar.jsx`
  once those pages exist. The WhatsApp link (`wa.me/919150427083`) is real
  and already works, since it needs only the number, not a page.

- **Sellers now upload a zip, not a bare .json/.txt file** — the core
  upload format changed from "a single conversation export file" to "a zip
  containing the conversation export plus whatever it produced" (code,
  documents, images). This touched a lot of places:
  - `app/sell/page.jsx`: the upload step now accepts `.zip` only (50MB
    limit), unzips it client-side with JSZip, and tries every `.json`/`.txt`
    entry inside — in the zip's own order — until one actually parses as a
    real conversation via the existing `parseThreadExport`, rather than
    just grabbing the first `.json`/`.txt` by name (a zip can easily
    contain other small json/txt files among the outputs that aren't the
    conversation). The zip is uploaded to a new private `listing-files`
    storage bucket immediately on selection (same pattern the screenshot
    uploader already used), and `listings.output_zip_path` records where.
    Other bundled filenames are shown to the seller for confirmation.
  - **Redaction scope, stated honestly**: automatic PII/secret scanning
    still only runs on the parsed conversation text — there's no reasonable
    way to scan arbitrary bundled files (code, images, PDFs) with the
    existing text-regex-based redaction. Added an explicit note on the
    upload screen itself, and corrected two marketing pages
    (`/how-it-works`, `/for-sellers`) that previously implied the *whole
    upload* was screened — they said so before this zip change existed,
    and it was worth catching now rather than leaving a safety claim that
    doesn't match what the system actually does.
  - **Buyer downloads**: `components/LibraryDetailClient.jsx`'s "Download
    as .txt" is now "Download files (.zip)" — a signed URL to the actual
    uploaded zip, not a generated text file. "Copy for Claude/ChatGPT/
    Gemini" is unchanged, since that's about continuing the conversation
    live, not about the file format.
  - **Admin**: `components/AdminQueueClient.jsx`'s generated .txt/.json
    download buttons are replaced with a "Download uploaded zip" button
    (also a signed URL) — the conversation preview/full-thread toggle for
    moderation is unchanged.
  - **Access control**: new RLS on `storage.objects` for the `listing-files`
    bucket — sellers can upload/read/delete their own files, admins can
    read any, and buyers can read a file only if they have a matching paid
    purchase for that listing (checked via the listing id encoded in the
    storage path, `{seller_id}/{listing_id}/{filename}`).
  - Added `jszip` to `package.json`.

- **Home page: category counts removed, empty categories hidden** — the
  "Browse by category" pills no longer show a thread count, and a category
  with zero live listings no longer appears at all. (The separate hover
  dropdown in the nav still shows every fixed category with its count —
  this change was scoped to the "Browse by category" section specifically;
  say the word if you want the same treatment there too.)
- **Home page stats replaced with a seller-focused "How it works"** —
  removed the "threads sold / paid out to sellers / average buyer rating"
  counters (along with the now-unused `get_platform_stats` RPC call and
  its animated-counter code — the RPC function itself is still in the
  database, just unused, in case it's wanted elsewhere later) and replaced
  the section with a 3-step seller walkthrough covering what a first-time
  seller actually needs to know: how to produce the export/document in the
  first place (Claude/ChatGPT/Gemini's export option, or copy-pasting into
  a .txt file), the one-time identity verification required before
  listing anything (name, PAN, address — reviewed by an admin), and how
  and when payment actually arrives (48-hour hold after a sale, then
  released). Mirrors the buyer-facing section added earlier in style and
  length.

- **Custom source model ("Other") now has somewhere to go** — the sell
  wizard's model dropdown already included "Other" as an option, but
  selecting it saved the literal string `"Other"` as the listing's model
  with no way to say what it actually was. Added a text box that appears
  when "Other" is selected (mirroring how the category field already
  worked), required before continuing, and used in place of "Other" at
  submission.
- **Browse: "See all" for categories, including sellers' custom ones**
  — the category pill row now shows the fixed 6 categories plus a "See
  all →" pill, which expands to include any custom category value present
  in live listings (i.e. what a seller typed after selecting "Other" when
  listing a thread — e.g. "Data Science"). This needed no separate wiring
  for "show up once approved": `BrowseClient` only ever receives listings
  with `status = 'live'` in the first place, so a custom category simply
  appears in that expanded list the moment the listing goes live, the same
  way the listing itself does.

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
| `/library/[id]` | Full unlocked thread + "continue this thread" panel (copy-to-clipboard + real zip download of the seller's uploaded file, via a signed URL) + star rating & review — reviewable any time after purchase, no waiting period | **Supabase** — including a real `reviews` table; a purchased listing stays visible even if later flagged/removed by moderation |
| `/purchases` | Order history & receipts, filterable by paid/refunded. Buyers can report an issue on a paid order, which opens a real dispute the admin resolves. | **Supabase** |

**Seller side**
| Route | What it is | Backed by |
|---|---|---|
| `/sell` | Gated on login and, since KYC review was added, on payout verification being admin-approved — see the seller-flow changelog entry above for exactly how that gating works. Upload wizard (3 steps: upload → details → price) → real redaction scan → dashboard showing your real listings, sales count, revenue, review analysis, and reported issues. Step 1 takes a `.zip` (max 50MB) and unzips it client-side with JSZip, trying every `.json`/`.txt` entry inside — in the zip's own order — through the same real conversation parser (`lib/parse-thread-export.js`) until one actually parses, rather than assuming the first by name is the conversation. That parser handles Claude's `chat_messages` shape, ChatGPT's `mapping` shape, a generic `{role,content}` array (possibly nested inside a wrapper object, e.g. `{ conversation_export: { messages: [...] } }` — tested against a real seller-submitted file), and a plain-transcript fallback (labeled `User:`/`Assistant:` lines, or blank-line-separated paragraphs if no labels at all); also strips a leading UTF-8 BOM and normalizes `\r`-only line endings, both traced to real mobile share-sheet/notes-app exports. Model detection also checks JSON metadata fields, not just the filename. A zip with no parseable conversation inside is rejected outright — there's no manual-entry escape hatch, so Continue is blocked until a real parse succeeds. The submit step runs `lib/redact-pii.js` — a real pattern-matching scanner (emails, phone numbers, Luhn-validated card numbers, and common API-key/token shapes: AWS, Stripe, GitHub, Slack, OpenAI, JWT) — over title/description/the parsed conversation before any of it is saved; the unredacted text is never persisted. **This scan only covers the conversation text** — other files bundled into the zip (code, documents, images) aren't scanned, which is stated on the upload screen itself, not just in this doc. Anything the scanner catches routes the listing into `flagged` instead of `pending_review`, and the findings (type + count, never the raw sensitive value) show on both the seller's confirmation screen and the admin queue. The whole zip is uploaded to a real private Supabase Storage bucket (`listing-files`), which is what a buyer actually downloads later — not a regenerated file. Also uploads up to 4 output screenshots to a real Supabase Storage bucket (`listing-screenshots`), shown as a swipeable gallery on the listing page. | **Supabase** |
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
