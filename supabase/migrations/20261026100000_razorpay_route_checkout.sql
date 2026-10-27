-- Razorpay Route checkout (TEST MODE first). ADDITIVE; the flag `phase5_route_transfers` is NOT touched here (it stays OFF until you flip it).
--
-- Buyers pay through the normal Razorpay Checkout; the ORDER carries a 100% transfer to the seller's linked account, so Razorpay splits at
-- capture time. chatmarket commission is 0: purchases are recorded with payment_method = 'route' and platform_fee = 0.
--
--   * payment_orders           + route_account_id   (set only for Route orders; the database, not the browser, decides 'route' + fee 0)
--   * seller_payout_accounts   + route_status, route_note, route_synced_at   (razorpay_account_id already exists; no bank/PAN data is stored)
--   * public.route_checkout_enabled(), public.my_route_status()                      (read-only helpers for the app)
--   * public.route_save_linked_account / route_update_account_status                 (service_role only: written by our server after Razorpay answers)
--   * public.route_checkout_target / record_route_payment_order                       (service_role only: used by create-order)
--   * public.fulfil_captured_payment REPLACED (same signature): Route orders -> payment_method 'route', platform_fee 0
--   * public.fulfil_route_transfer                                                    (service_role only: the transfer.processed path)
--   * private.require_seller_ready REPLACED: with the Route flag ON a seller needs an ACTIVATED linked account to list (CM079)
--   * private.settlement_eligible REPLACED: ignores payment_method = 'route' (the seller was already paid by Razorpay)
--
-- Direct-UPI tables, triggers and functions are all preserved; `direct_upi_checkout` is untouched (OFF). When the Route flag is ON it takes precedence.
-- Rollback (nothing is dropped): update private.feature_flags set enabled = false where name = 'phase5_route_transfers';

-- ---------------------------------------------------------------- columns
alter table public.payment_orders
  add column route_account_id text check (route_account_id is null or route_account_id ~ '^acc_[A-Za-z0-9]{6,40}$');
comment on column public.payment_orders.route_account_id is 'Linked account that receives 100% of this order via an order-level transfer. NULL = ordinary order.';

alter table public.seller_payout_accounts
  add column route_status    text check (route_status is null or route_status in ('created', 'under_review', 'needs_clarification', 'activated', 'suspended', 'rejected')),
  add column route_note      text check (route_note is null or length(route_note) <= 300),
  add column route_synced_at timestamptz;
grant select (route_status) on public.seller_payout_accounts to authenticated;

-- ---------------------------------------------------------------- helpers
create function public.route_checkout_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$ select private.is_route_transfers_enabled() $$;
revoke execute on function public.route_checkout_enabled() from public, anon;
grant execute on function public.route_checkout_enabled() to authenticated, anon;

create function private.route_account_ready(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.seller_payout_accounts a
                  where a.user_id = p_user and a.razorpay_account_id is not null
                    and a.route_status = 'activated' and a.status <> 'suspended');
$$;
revoke execute on function private.route_account_ready(uuid) from public, anon, authenticated, service_role;

create function public.my_route_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  a record;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'login_required'; end if;
  select acc.route_status, acc.route_note, (acc.razorpay_account_id is not null) as has_account into a
    from public.seller_payout_accounts acc where acc.user_id = v_uid;
  return jsonb_build_object('route_enabled', private.is_route_transfers_enabled(),
                            'has_account', coalesce(a.has_account, false),
                            'route_status', a.route_status, 'route_note', a.route_note,
                            'ready', private.route_account_ready(v_uid));
end;
$$;
revoke execute on function public.my_route_status() from public, anon;
grant execute on function public.my_route_status() to authenticated;

-- ---------------------------------------------------------------- save / update linked account (service_role only)
create function public.route_save_linked_account(p_user_id uuid, p_account_id text, p_route_status text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_old record;
begin
  if p_user_id is null or p_account_id is null or p_account_id !~ '^acc_[A-Za-z0-9]{6,40}$'
     or p_route_status is null or p_route_status not in ('created', 'under_review', 'needs_clarification', 'activated', 'suspended', 'rejected') then
    raise exception using errcode = 'CM080', message = 'invalid_route_account';
  end if;
  if (select count(*) from public.audit_log a where a.actor_id = p_user_id and a.action = 'route_account_saved' and a.created_at > now() - interval '24 hours') >= 10 then
    raise exception using errcode = 'CM080', message = 'too_many_route_attempts';
  end if;
  select acc.razorpay_account_id, acc.route_status into v_old from public.seller_payout_accounts acc where acc.user_id = p_user_id;
  if found and v_old.razorpay_account_id is not null and v_old.razorpay_account_id <> p_account_id and v_old.route_status = 'activated' then
    raise exception using errcode = 'CM080', message = 'route_account_exists';     -- never replace an activated account with a second one
  end if;
  insert into public.seller_payout_accounts (user_id, razorpay_account_id, status, route_status, route_note, route_synced_at, set_by)
  values (p_user_id, p_account_id, case when p_route_status = 'activated' then 'active' else 'pending' end, p_route_status, left(p_note, 300), now(), p_user_id)
  on conflict (user_id) do update
     set razorpay_account_id = excluded.razorpay_account_id,
         route_status = excluded.route_status, route_note = excluded.route_note, route_synced_at = now(),
         status = case when public.seller_payout_accounts.status = 'pending' and excluded.route_status = 'activated' then 'active'
                       else public.seller_payout_accounts.status end,
         updated_at = now();
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_user_id, 'route_account_saved', 'seller', p_user_id, jsonb_build_object('account_id', p_account_id, 'route_status', p_route_status));
  return jsonb_build_object('outcome', 'saved', 'route_status', p_route_status, 'ready', private.route_account_ready(p_user_id));
end;
$$;

create function public.route_update_account_status(p_account_id text, p_route_status text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid; v_old text;
begin
  if p_account_id is null or p_account_id !~ '^acc_[A-Za-z0-9]{6,40}$'
     or p_route_status is null or p_route_status not in ('created', 'under_review', 'needs_clarification', 'activated', 'suspended', 'rejected') then
    raise exception using errcode = 'CM080', message = 'invalid_route_account';
  end if;
  select a.user_id, a.route_status into v_user, v_old from public.seller_payout_accounts a where a.razorpay_account_id = p_account_id for update;
  if not found then return jsonb_build_object('outcome', 'unknown_account'); end if;
  if v_old is not distinct from p_route_status then
    update public.seller_payout_accounts set route_synced_at = now() where user_id = v_user;
    return jsonb_build_object('outcome', 'unchanged');
  end if;
  update public.seller_payout_accounts a
     set route_status = p_route_status, route_note = left(p_note, 300), route_synced_at = now(), updated_at = now(),
         status = case when a.status = 'pending' and p_route_status = 'activated' then 'active' else a.status end
   where a.user_id = v_user;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (null, 'route_account_status', 'seller', v_user, jsonb_build_object('account_id', p_account_id, 'from', v_old, 'to', p_route_status));
  return jsonb_build_object('outcome', 'updated', 'route_status', p_route_status);
end;
$$;

-- ---------------------------------------------------------------- order helpers (service_role only)
create function public.route_checkout_target(p_listing_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  l record; a record;
begin
  select x.seller_id, x.status into l from public.listings x where x.id = p_listing_id;
  if not found or l.status <> 'live' or l.seller_id is null then
    return jsonb_build_object('available', false, 'reason', 'listing_unavailable');
  end if;
  select acc.razorpay_account_id into a from public.seller_payout_accounts acc where acc.user_id = l.seller_id;
  if not found or a.razorpay_account_id is null or not private.route_account_ready(l.seller_id) then
    return jsonb_build_object('available', false, 'reason', 'seller_not_ready');
  end if;
  return jsonb_build_object('available', true, 'account_id', a.razorpay_account_id, 'seller_id', l.seller_id);
end;
$$;

create function public.record_route_payment_order(p_order_id text, p_user_id uuid, p_listing_id uuid, p_amount_paise integer, p_account_id text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_order_id is null or length(p_order_id) not between 1 and 100 or p_user_id is null or p_listing_id is null
     or p_amount_paise is null or p_amount_paise <= 0 or p_account_id is null or p_account_id !~ '^acc_[A-Za-z0-9]{6,40}$' then
    raise exception using errcode = 'CM070', message = 'invalid_payment_order';
  end if;
  insert into public.payment_orders (razorpay_order_id, user_id, listing_id, amount_paise, route_account_id)
  values (p_order_id, p_user_id, p_listing_id, p_amount_paise, p_account_id)
  on conflict (razorpay_order_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------- fulfilment: Route orders -> 'route', fee 0
create or replace function public.fulfil_captured_payment(
  p_order_id         text,
  p_payment_id       text,
  p_amount_paise     integer,
  p_currency         text,
  p_method           text,
  p_signature        text,
  p_fee_pct          numeric,
  p_expected_user_id uuid default null,
  p_event_id         text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order     public.payment_orders%rowtype;
  v_listing   public.listings%rowtype;
  v_purchase  uuid;
  v_outcome   text;
  v_amount    numeric;
  v_method    text := coalesce(nullif(left(trim(p_method), 40), ''), 'razorpay');
begin
  if p_order_id is null or length(p_order_id) not between 1 and 100
     or p_payment_id is null or length(p_payment_id) not between 1 and 100
     or (p_amount_paise is not null and p_amount_paise <= 0)
     or p_currency is distinct from 'INR'
     or p_fee_pct is null or p_fee_pct < 0 or p_fee_pct > 1 then
    raise exception using errcode = 'CM070', message = 'invalid_fulfilment_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment:' || p_payment_id, 0));

  -- 1. already fulfilled for this exact payment (webhook retry, verify after webhook, double click ...)
  select p.id into v_purchase from public.purchases p where p.razorpay_payment_id = p_payment_id;
  if found then
    v_outcome := 'already_fulfilled';
  else
    select * into v_order from public.payment_orders o where o.razorpay_order_id = p_order_id;
    if not found then
      v_outcome := 'order_unknown';
    elsif p_expected_user_id is not null and p_expected_user_id <> v_order.user_id then
      v_outcome := 'order_user_mismatch';
    elsif p_amount_paise is not null and p_amount_paise <> v_order.amount_paise then
      v_outcome := 'amount_mismatch';
    else
      select * into v_listing from public.listings l where l.id = v_order.listing_id;
      if not found or v_listing.status <> 'live' then
        v_outcome := 'listing_unavailable';
      else
        select p.id into v_purchase from public.purchases p
         where p.user_id = v_order.user_id and p.listing_id = v_order.listing_id;
        if found then
          v_outcome := 'duplicate_payment';   -- already owns it via a different payment
        else
          v_amount := v_order.amount_paise / 100.0;
          begin
            insert into public.purchases
              (user_id, listing_id, amount, payment_method, razorpay_order_id, razorpay_payment_id, razorpay_signature, platform_fee)
            values
              (v_order.user_id, v_order.listing_id, v_amount,
               case when v_order.route_account_id is not null then 'route' else v_method end,      -- Route: the database decides, never the client
               p_order_id, p_payment_id,
               nullif(left(p_signature, 200), ''),
               case when v_order.route_account_id is not null then 0 else round(v_amount * p_fee_pct, 2) end)   -- Route: 100% to the seller, platform fee 0
            returning id into v_purchase;
            v_outcome := 'fulfilled';
            insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
            values (null, 'payment_fulfilled', 'purchase', v_purchase,
                    jsonb_build_object('order_id', p_order_id, 'payment_id', p_payment_id,
                                       'amount_paise', v_order.amount_paise,
                                       'source', case when p_event_id is null then 'verify' else 'webhook' end,
                                       'route', v_order.route_account_id is not null));
          exception when unique_violation then
            -- lost a race the advisory lock should already prevent; resolve to whichever row won
            select p.id into v_purchase from public.purchases p
             where p.razorpay_payment_id = p_payment_id
                or (p.user_id = v_order.user_id and p.listing_id = v_order.listing_id)
             order by (p.razorpay_payment_id = p_payment_id) desc limit 1;
            v_outcome := 'already_fulfilled';
          end;
        end if;
      end if;
    end if;
  end if;

  if p_event_id is not null then
    update public.webhook_events e
       set status       = case when v_outcome in ('fulfilled', 'already_fulfilled') then 'processed' else 'needs_review' end,
           outcome      = v_outcome,
           purchase_id  = v_purchase,
           error        = null,
           processed_at = now()
     where e.provider = 'razorpay' and e.provider_event_id = p_event_id
       and e.status in ('received', 'failed');
  end if;

  return jsonb_build_object('outcome', v_outcome, 'purchase_id', v_purchase);
end;
$$;

-- transfer.processed path: the transfer must be to THIS order's linked account and carry 100% of the order amount.
create function public.fulfil_route_transfer(
  p_order_id text, p_payment_id text, p_account_id text, p_transfer_paise integer, p_amount_paise integer, p_currency text, p_event_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.payment_orders%rowtype;
  v_res   jsonb;
begin
  if p_order_id is null or p_payment_id is null or p_account_id is null or p_transfer_paise is null then
    raise exception using errcode = 'CM070', message = 'invalid_fulfilment_input';
  end if;
  select * into v_order from public.payment_orders o where o.razorpay_order_id = p_order_id;
  if found and (v_order.route_account_id is distinct from p_account_id or v_order.amount_paise <> p_transfer_paise) then
    if p_event_id is not null then
      update public.webhook_events e set status = 'needs_review', outcome = 'transfer_mismatch', error = null, processed_at = now()
       where e.provider = 'razorpay' and e.provider_event_id = p_event_id and e.status in ('received', 'failed');
    end if;
    return jsonb_build_object('outcome', 'transfer_mismatch', 'purchase_id', null);
  end if;
  v_res := public.fulfil_captured_payment(p_order_id, p_payment_id, p_amount_paise, p_currency, 'route', null, 0, null, p_event_id);
  return v_res;
end;
$$;

revoke all on function public.route_save_linked_account(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.route_update_account_status(text, text, text) from public, anon, authenticated;
revoke all on function public.route_checkout_target(uuid) from public, anon, authenticated;
revoke all on function public.record_route_payment_order(text, uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.fulfil_route_transfer(text, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.route_save_linked_account(uuid, text, text, text) to service_role;
grant execute on function public.route_update_account_status(text, text, text) to service_role;
grant execute on function public.route_checkout_target(uuid) to service_role;
grant execute on function public.record_route_payment_order(text, uuid, uuid, integer, text) to service_role;
grant execute on function public.fulfil_route_transfer(text, text, text, integer, integer, text, text) to service_role;

-- ---------------------------------------------------------------- listing gate (flag ON: an activated linked account is required)
create or replace function private.require_seller_ready()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  a record;
  v_h integer;
begin
  if (select auth.uid()) is null or new.seller_id is distinct from (select auth.uid()) then
    return new;
  end if;
  if private.is_route_transfers_enabled() then
    if not private.route_account_ready(new.seller_id) then
      raise exception using errcode = 'CM079', message = 'route_account_required';
    end if;
    return new;
  end if;
  if not private.direct_upi_enabled() then
    return new;
  end if;
  select acc.vpa_address, acc.status, acc.vpa_changed_at into a from public.seller_payout_accounts acc where acc.user_id = new.seller_id;
  if not private.seller_identity_complete(new.seller_id) or not found or a.vpa_address is null or a.status <> 'active' then
    raise exception using errcode = 'CM079', message = 'seller_setup_incomplete';
  end if;
  select c.upi_cooldown_hours into v_h from private.direct_upi_config c where c.id;
  if v_h > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_h) > now() then
    raise exception using errcode = 'CM079', message = 'upi_in_cooldown';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- Route sales never enter the monthly settlement
create or replace function private.settlement_eligible(p_period_end timestamptz)
returns table (purchase_id uuid, seller_id uuid, amount_paise integer, fee_paise integer)
language sql stable security definer set search_path = ''
as $$
  select p.id, l.seller_id,
         (round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100))::integer,
         round(coalesce(p.platform_fee, 0) * 100)::integer
    from public.purchases p
    join public.listings l on l.id = p.listing_id
    cross join private.settlement_config c
   where p.status = 'paid'
     and p.payment_method is distinct from 'direct_upi'      -- direct seller-to-buyer sales never enter the platform settlement
     and p.payment_method is distinct from 'route'           -- Route sales were split to the seller by Razorpay at capture
     and p.razorpay_payment_id is not null
     and l.seller_id is not null
     and p.purchased_at >= c.start_at
     and p.purchased_at < p_period_end
     and round(coalesce(p.platform_fee, 0) * 100) < round(p.amount * 100)
     and not exists (select 1 from public.purchase_settlements s where s.purchase_id = p.id)
     and not exists (select 1 from public.transfers t where t.purchase_id = p.id)
     and not exists (select 1 from public.vpa_payouts v where v.purchase_id = p.id);
$$;
