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
