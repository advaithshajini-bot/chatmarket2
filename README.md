# Pre-launch guard + waitlist page fixes

Files (copy over the repo, then deploy):
- app/waitlist/page.jsx   -> no TopNav, no page-level footer (layout.jsx already renders SiteFooter); logo-only header
- components/MobileTabBar.jsx -> returns null on /waitlist (otherwise the mobile bottom bar shows Browse/Sell/Orders)
- middleware.js           -> pre-launch redirect to /waitlist until 1 Jan 2027 00:00 IST

Guard rules
- Allowed: /waitlist, /api/waitlist, /brand/*, /_next/*, /videos/*, icons, robots/sitemap, plus /privacy, /terms, /refund (footer links; you collect emails, so the privacy page must stay reachable). Remove them from ALLOWED_EXACT if you disagree.
- API routes are already excluded by the existing matcher, so Razorpay webhooks etc. are unaffected.
- Admin bypass: open any URL with ?preview=admin_access once -> httpOnly cookie (30 days), you are redirected to the clean URL. ?preview=off clears it.
- Set env PREVIEW_KEY on Vercel to something unguessable (default is "admin_access", as requested, which is guessable). Optional LAUNCH_AT env (ISO date) overrides the launch moment.
- The dedicated ADMIN_HOST deployment is not redirected.
- After launch the guard switches itself off; delete it later at leisure.
