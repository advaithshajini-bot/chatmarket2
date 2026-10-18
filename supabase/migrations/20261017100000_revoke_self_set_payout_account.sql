-- Phase 6 hardening: close the self-service payout-account route.
--
-- public.set_seller_payout_account(text, text) (baseline) lets ANY logged-in user write their own profiles.razorpay_linked_account_id /
-- razorpay_account_status, including marking themselves 'active' with any account id. Milestones 5.2-5.3 deliberately do NOT trust those
-- columns (eligibility comes only from public.seller_payout_accounts, written by the admin + MFA function admin_set_seller_payout_account),
-- so this could not cause a payout -- but nothing in the app calls it, so the privilege has no use and is removed.
--
-- NOT purely additive: this REMOVES a privilege (by explicit request). It changes no table, column, flag or function body, and it is
-- IDEMPOTENT (REVOKE of a privilege that is already gone is a no-op), so it is safe on a database where it was already run by hand.
-- service_role keeps whatever it had; the function itself is not dropped (rollback = the GRANT below).
--
-- Rollback: grant execute on function public.set_seller_payout_account(text, text) to authenticated;

revoke all on function public.set_seller_payout_account(text, text) from public, anon, authenticated;
