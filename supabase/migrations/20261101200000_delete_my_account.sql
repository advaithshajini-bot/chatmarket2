-- Self-service account deletion = ANONYMISE, not a hard delete. Purchases, settlements and payouts reference auth.users with ON DELETE CASCADE,
-- so removing the auth row would erase buyers' purchase records and sellers' payout history. Instead this function removes the personal data and
-- delists the seller's products; the route then locks the login (random email, permanent ban). Additive: one function.
--   refused (returns ok=false, reason): admin_account | unsettled_earnings | open_dispute
create or replace function public.delete_my_account()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'not_authenticated';
  end if;
  if exists (select 1 from public.profiles where id = v_uid and is_admin) then
    return jsonb_build_object('ok', false, 'reason', 'admin_account');
  end if;
  -- money still owed to this seller: paid sales not yet in a settlement, or a settlement line not yet paid out
  if exists (select 1 from public.purchases pu join public.listings l on l.id = pu.listing_id
              where l.seller_id = v_uid and pu.status = 'paid'
                and not exists (select 1 from public.purchase_settlements ps where ps.purchase_id = pu.id))
     or exists (select 1 from public.settlement_items si where si.seller_id = v_uid and si.status = 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'unsettled_earnings');
  end if;
  if exists (select 1 from public.disputes d where d.status = 'open' and (d.buyer_id = v_uid or d.seller_id = v_uid)) then
    return jsonb_build_object('ok', false, 'reason', 'open_dispute');
  end if;

  update public.listings set status = 'removed' where seller_id = v_uid and status <> 'removed';
  delete from public.seller_identity_details where user_id = v_uid;
  delete from public.seller_kyc where user_id = v_uid;
  -- settlement lines keep their own snapshot of the bank details they were paid to; the live payout account (bank / UPI / Route ids) is removed
  delete from public.seller_payout_accounts where user_id = v_uid;
  update public.profiles set display_name = 'Deleted user', legal_name = null, bio = null where id = v_uid;
  perform private.write_audit_log(v_uid, 'account_deleted', 'profile', v_uid, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
