# Milestone 4.4 go-live checklist (nothing here runs automatically)

1. **Back up / branch first.** Apply `20260930100800_add_seller_admin_review.sql` to a Supabase *branch* (or a copy) before production.
   It is additive: new columns on `listing_demos`, two new tables, two new triggers, two re-created storage policies, nine new functions,
   and `create or replace` of `set_listing_demo_approval` / `listing_demo_info` (grants preserved). No feature flag is touched; all stay OFF.
2. **Verify the two assumptions the migration makes about Phases 1-3:** `private.is_admin_mfa()` exists (4.2 already calls it) and
   `private.is_admin()` / `public.profiles.is_admin` exist. Then run `tests/phase4/run-all.mjs` against the branch (it needs the real Phase 3 schema).
3. **Behaviour changes to be aware of** (both intentional, both covered by tests):
   - buyers can now read only the listing's *current* blueprint object (previously: any object under the listing's folder);
   - sellers can no longer delete the live blueprint object or one that is pending review.
4. **Existing live data:** demos approved under 4.2 are backfilled as `approved` (their `approved_at` is untouched). Existing listings
   with a blueprint keep it; from now on `listings.blueprint_*` can only change through an admin approval.
5. **MFA:** the admin RPCs need an `aal2` JWT. The Moderation Desk page tells an admin without a verified second factor to complete it.
6. **Smoke test on the branch** (as a seller, then an admin with MFA): upload a harmless n8n export -> it appears in the queue -> Approve ->
   the listing shows the blueprint to a paying buyer; author a demo -> Approve -> `listing_demo_info` returns `available:true` with the sample (needs
   `phase3_execution` and `phase4_demo` ON, which is a separate, deliberate step); edit the demo -> it disappears until re-approved.
7. **Rollback:** the migration has no destructive steps; to roll back, restore the two storage policies and drop the new objects (see the
   bottom of the migration for the policy names), or simply restore the branch.
