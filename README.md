# ChatMarket: logo, waitlist, centred FAQ (additive update)

Tested on a copy of your Milestone 5.10 codebase: `next build` passes (37 pages), pages render at 1280px and 390px, and the API returns 400 for a bad email, ok for a honeypot hit, and 503 when the service key is missing (expected locally).
NOT tested against your real Supabase (it is unreachable from my environment): run the migration and submit one real email before sharing the link.

## Apply
1. Supabase SQL editor: run `supabase/migrations/20261109100000_waitlist_signups.sql` (new table `waitlist_signups`, RLS on, service_role only).
2. Copy every file in this zip over the repo at the same path, then deploy.
3. `SUPABASE_SERVICE_ROLE_KEY` must already be set on Vercel (the payments and rate limiter use it).
4. Privacy page: add one line: "Waitlist: if you join the waitlist we store your email address and whether you are a buyer, creator or both, only to tell you when ChatMarket launches."

## What changed
- Logo: `public/brand/logo.svg` (+ `logo.png`, 2x) is the brand-kit horizontal logo on a transparent background with the wordmark in ink for light pages; `logo-on-dark.svg` is the original on ink. Used in `TopNav.jsx`, the landing page's own nav (`LandingClient.jsx`) and `SiteFooter.jsx`. `app/icon.svg` is a favicon from the brand icon (delete it if you already have one you prefer).
- Waitlist: `components/WaitlistForm.jsx` (email validation, Buyer / Creator / Both, "Join the January 2027 Waitlist", success message), a section on the landing page under the hero, a stand-alone `/waitlist` page for your bio links, and `app/api/waitlist/route.js` (honeypot, 5 sign-ups per IP per hour via your existing `lib/security/rate-limit.js`, duplicate emails answer ok).
- FAQ: section header, new one-line subtext and accordion are centred; accordion is max 768px (max-w-3xl) and its text stays left-aligned.

Read sign-ups: `select email, role_interest, created_at from public.waitlist_signups order by created_at desc;`

Not changed: the site's navy palette and fonts, and the landing hero copy ("AI workers for real business work", "Playbooks · Workflows · Agents"), which no longer matches a Playbooks-only launch.
