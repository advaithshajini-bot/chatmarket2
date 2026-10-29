-- Seller bank settlement details for Razorpay Route onboarding (2-step form). ADDITIVE and idempotent.
--
-- What we keep: ONLY display facts about the settlement account -- last 4 digits, IFSC, bank name, beneficiary name, account type.
-- The FULL account number and the PAN are sent to the payment partner and are never stored here (nothing to encrypt, nothing to leak).
--   * seller_payout_accounts + bank_account_last4, bank_ifsc, bank_name, bank_beneficiary_name, bank_account_type
--   * seller_payout_accounts + onboarding_status (generated from route_status): draft | submitted | activated | action_required
--   * public.route_save_bank_display (service_role only), public.my_route_status REPLACED (adds the display fields)
-- The standalone UPI ID step is not part of the Route flow (the app shows only the Route form when the Route flag is ON); the legacy UPI
-- columns and functions are untouched and keep working while the flag is OFF.
-- Rollback (nothing is dropped): the new columns can stay unused.

alter table public.seller_payout_accounts
  add column if not exists bank_account_last4     text,
  add column if not exists bank_ifsc              text,
  add column if not exists bank_name              text,
  add column if not exists bank_beneficiary_name  text,
  add column if not exists bank_account_type      text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'seller_bank_last4_chk') then
    alter table public.seller_payout_accounts add constraint seller_bank_last4_chk check (bank_account_last4 is null or bank_account_last4 ~ '^[0-9]{4}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seller_bank_ifsc_chk') then
    alter table public.seller_payout_accounts add constraint seller_bank_ifsc_chk check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seller_bank_type_chk') then
    alter table public.seller_payout_accounts add constraint seller_bank_type_chk check (bank_account_type is null or bank_account_type in ('savings', 'current'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'seller_bank_text_chk') then
    alter table public.seller_payout_accounts add constraint seller_bank_text_chk check (
      (bank_name is null or length(bank_name) <= 120) and (bank_beneficiary_name is null or length(bank_beneficiary_name) <= 120));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'seller_payout_accounts' and column_name = 'onboarding_status') then
    alter table public.seller_payout_accounts add column onboarding_status text generated always as (
      case route_status
        when 'activated' then 'activated'
        when 'under_review' then 'submitted'
        when 'needs_clarification' then 'action_required'
        when 'rejected' then 'action_required'
        when 'suspended' then 'action_required'
        when 'created' then 'draft'
        else null
      end) stored;
  end if;
end $$;

-- sellers (RLS: own row) may read the harmless display columns; the account id and full number stay server-side
grant select (bank_account_last4, bank_ifsc, bank_name, bank_beneficiary_name, bank_account_type, onboarding_status) on public.seller_payout_accounts to authenticated;

create or replace function public.route_save_bank_display(
  p_user_id uuid, p_last4 text, p_ifsc text, p_beneficiary text, p_account_type text, p_bank_name text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_user_id is null or p_last4 is null or p_last4 !~ '^[0-9]{4}$' or p_ifsc is null or p_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
     or p_account_type is null or p_account_type not in ('savings', 'current')
     or p_beneficiary is null or length(btrim(p_beneficiary)) not between 2 and 120 then
    raise exception using errcode = 'CM080', message = 'invalid_bank_display';
  end if;
  update public.seller_payout_accounts a
     set bank_account_last4 = p_last4, bank_ifsc = p_ifsc, bank_beneficiary_name = btrim(p_beneficiary),
         bank_account_type = p_account_type, bank_name = nullif(left(btrim(coalesce(p_bank_name, '')), 120), ''), updated_at = now()
   where a.user_id = p_user_id and a.razorpay_account_id is not null;
  if not found then return jsonb_build_object('outcome', 'no_account'); end if;
  return jsonb_build_object('outcome', 'saved');
end;
$$;
revoke all on function public.route_save_bank_display(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.route_save_bank_display(uuid, text, text, text, text, text) to service_role;

create or replace function public.my_route_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  a record;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'login_required'; end if;
  select acc.route_status, acc.route_note, (acc.razorpay_account_id is not null) as has_account, acc.onboarding_status,
         acc.bank_account_last4, acc.bank_ifsc, acc.bank_name, acc.bank_account_type
    into a from public.seller_payout_accounts acc where acc.user_id = v_uid;
  return jsonb_build_object('route_enabled', private.is_route_transfers_enabled(),
                            'has_account', coalesce(a.has_account, false),
                            'route_status', a.route_status, 'route_note', a.route_note,
                            'onboarding_status', a.onboarding_status,
                            'bank_account_last4', a.bank_account_last4, 'bank_ifsc', a.bank_ifsc,
                            'bank_name', a.bank_name, 'bank_account_type', a.bank_account_type,
                            'ready', private.route_account_ready(v_uid));
end;
$$;
