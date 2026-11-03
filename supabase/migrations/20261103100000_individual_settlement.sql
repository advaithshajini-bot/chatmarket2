-- Individual settlement controls for the admin desk. Additive: two admin-only functions (admin AND MFA), nothing existing is changed.
--   admin_settle_single_item(item, reference, date) : mark ONE pending settlement line as paid, with the bank reference and the date it was paid.
--       The seller's /sell/earnings reads the same row through seller_settlement_status(): the line turns "Paid" with the date and reference.
--   admin_seller_bank_details(seller)               : the full bank details of one seller, for the single-seller transfer file (audited).

create or replace function public.admin_settle_single_item(p_item_id uuid, p_reference text, p_payment_date date default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_ref    text := btrim(p_reference);
  v_today  date := (now() at time zone 'Asia/Kolkata')::date;
  v_date   date := coalesce(p_payment_date, (now() at time zone 'Asia/Kolkata')::date);
  v_i      public.settlement_items%rowtype;
  v_b      public.settlement_batches%rowtype;
  v_paid   timestamptz;
  v_left   integer;
  v_done   boolean := false;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_item_id is null or v_ref is null or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._/ -]{0,79}$'
     or v_date > v_today or v_date < v_today - 90 then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select * into v_i from public.settlement_items i where i.id = p_item_id;
  if not found then
    raise exception using errcode = 'CM076', message = 'invalid_items';
  end if;
  select * into v_b from public.settlement_batches b where b.id = v_i.batch_id for update;
  select * into v_i from public.settlement_items i where i.id = p_item_id for update;
  if v_b.status <> 'open' or v_i.status <> 'pending' then
    raise exception using errcode = 'CM076', message = 'batch_not_open';
  end if;

  -- today: the real moment; an earlier day: noon IST on that day
  v_paid := case when v_date = v_today then now() else ((v_date + time '12:00') at time zone 'Asia/Kolkata') end;
  update public.settlement_items i set status = 'paid', utr = v_ref, paid_at = v_paid, updated_at = now() where i.id = p_item_id;

  select count(*) into v_left from public.settlement_items i where i.batch_id = v_b.id and i.status = 'pending';
  if v_left = 0 then
    update public.settlement_batches b set status = 'completed', completed_at = now() where b.id = v_b.id;
    v_done := true;
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'settlement_item_paid', 'settlement_item', p_item_id,
          jsonb_build_object('reference', v_ref, 'payment_date', v_date, 'amount_paise', v_i.amount_paise, 'seller_id', v_i.seller_id, 'batch_completed', v_done));
  return jsonb_build_object('settled_paise', v_i.amount_paise, 'paid_at', v_paid, 'batch_completed', v_done);
end;
$$;
revoke all on function public.admin_settle_single_item(uuid, text, date) from public, anon;
grant execute on function public.admin_settle_single_item(uuid, text, date) to authenticated;

create or replace function public.admin_seller_bank_details(p_seller_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_a public.seller_payout_accounts%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  select * into v_a from public.seller_payout_accounts a where a.user_id = p_seller_id;
  if not found or v_a.bank_account_number is null or v_a.bank_ifsc is null then
    return jsonb_build_object('found', false);
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'seller_bank_details_exported', 'profile', p_seller_id, '{}'::jsonb);
  return jsonb_build_object('found', true, 'bank_beneficiary_name', v_a.bank_beneficiary_name, 'bank_account_number', v_a.bank_account_number,
                            'bank_ifsc', v_a.bank_ifsc, 'bank_account_type', v_a.bank_account_type);
end;
$$;
revoke all on function public.admin_seller_bank_details(uuid) from public, anon;
grant execute on function public.admin_seller_bank_details(uuid) to authenticated;
