-- MANUAL, DELIBERATE STEP -- not a migration, nothing runs this automatically. Review, then run it yourself.
--
-- WHY: the baseline schema has this policy on public.purchases:
--     "Users can create their own purchases"  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id)
-- and Supabase grants INSERT on public tables to `authenticated` by default. So any logged-in user can call the
-- API directly (supabase-js from the browser console) and insert themselves a `status = 'paid'` purchase for any
-- listing with amount 0 -- an unpaid unlock of every download / blueprint / library item. The checkout code never
-- needed that: after Milestone 5.1 ALL purchases are created by public.fulfil_captured_payment (SECURITY DEFINER,
-- service_role only), so the policy and the grant can go.
--
-- ORDER OF OPERATIONS (important):
--   1. Deploy the 5.1 app code (verify-payment now creates purchases through the service client).
--   2. Set SUPABASE_SERVICE_ROLE_KEY on the server, make one test purchase, confirm it works.
--   3. THEN run this. Running it first would make the OLD verify-payment fail (it inserts as the buyer).
--
-- WHAT IT DOES NOT TOUCH: reading. Buyers still read their own purchases; sellers still read purchases of their
-- listings; every existing SELECT policy is unchanged.
--
-- ROLLBACK (restores the old behaviour exactly):
--   create policy "Users can create their own purchases" on public.purchases
--     for insert to authenticated with check ((select auth.uid()) = user_id);
--   grant insert on public.purchases to authenticated;
begin;
drop policy if exists "Users can create their own purchases" on public.purchases;
revoke insert on public.purchases from anon, authenticated;
commit;
