-- Manual bank payouts: sellers save PERMANENT bank account details; the admin pays them by hand (IMPS / NEFT) from the monthly settlement CSV.
-- Model: Standard Gateway Aggregation. Razorpay Route stays OFF (phase5_route_transfers = false), UPI IDs are no longer collected.
--
-- What this does (ADDITIVE; nothing is dropped, no feature flag is changed):
--   * seller_payout_accounts.bank_account_number (9-18 digits) + bank_changed_at. The full number is NOT granted to `authenticated`:
--     a seller cannot read it back through the API. It is readable only by service_role and through the admin + MFA functions below.
--   * seller_payout_destination_chk widened: a razorpay account, a UPI ID OR a bank account number is a valid destination.
--   * public.set_my_bank_payout(number, ifsc, beneficiary, account_type)  -> { outcome: 'saved' }   (seller, SECURITY DEFINER, upsert)
--   * public.my_bank_payout()   -> what the seller's own screen may show (configured, ****1234, IFSC, name, type). Never the full number.
--   * private.require_seller_ready REPLACED: Route flag ON -> activated linked account (unchanged); direct-UPI flag ON -> its old rule (dormant);
--     otherwise (the live model) the seller must have a bank account number + IFSC saved before listing (CM079 'bank_account_required').
--   * settlement_items: vpa_address becomes nullable and a bank snapshot is added (number, IFSC, beneficiary, type) so a batch pays exactly
--     the account that was saved at freeze time.
--   * admin_settlement_pending / admin_create_settlement_batch / admin_settlement_batch / seller_settlement_status REPLACED (same signatures)
--     so eligibility, snapshots and blocked reasons use the bank account ('no_bank_account', 'bank_in_cooldown') instead of the UPI ID.
--   * Account takeover safeguard kept: CHANGING an existing bank account starts the same cooldown (private.settlement_config.upi_cooldown_hours).
--
-- Preserved untouched: direct-UPI tables / triggers / functions, set_my_payout_vpa, Route functions, direct_upi_checkout (OFF).
-- Rollback: restore the four settlement functions + require_seller_ready from 20261021100000 / 20261026100000; drop function set_my_bank_payout, my_bank_payout;
--   drop the new columns once no batch refers to them.

-- ---------------------------------------------------------------- seller_payout_accounts
alter table public.seller_payout_accounts
  add column bank_account_number text,
  add column bank_changed_at     timestamptz;
alter table public.seller_payout_accounts
  add constraint seller_bank_number_chk check (bank_account_number is null or bank_account_number ~ '^[0-9]{9,18}$');
comment on column public.seller_payout_accounts.bank_account_number is
  'Full bank account number for MANUAL payouts. Not granted to authenticated; read only by service_role and admin+MFA functions.';
comment on column public.seller_payout_accounts.bank_changed_at is
  'When a saved bank account was last CHANGED to a different one (NULL = never). Drives the payout cooldown. Not readable by authenticated.';

alter table public.seller_payout_accounts drop constraint seller_payout_destination_chk;
alter table public.seller_payout_accounts
  add constraint seller_payout_destination_chk check (razorpay_account_id is not null or vpa_address is not null or bank_account_number is not null);

-- authenticated keeps its column-limited select (no bank_account_number); make the privilege for the server explicit
revoke select (bank_account_number, bank_changed_at) on public.seller_payout_accounts from anon, authenticated;
grant select (bank_account_number, bank_changed_at) on public.seller_payout_accounts to service_role;

-- ---------------------------------------------------------------- settlement_items: bank snapshot
alter table public.settlement_items alter column vpa_address drop not null;
alter table public.settlement_items
  add column bank_account_number    text check (bank_account_number is null or bank_account_number ~ '^[0-9]{9,18}$'),
  add column bank_ifsc              text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  add column bank_beneficiary_name  text check (bank_beneficiary_name is null or length(btrim(bank_beneficiary_name)) between 2 and 120),
  add column bank_account_type      text check (bank_account_type is null or bank_account_type in ('savings', 'current'));
alter table public.settlement_items
  add constraint settlement_items_destination_chk check (vpa_address is not null or (bank_account_number is not null and bank_ifsc is not null));

-- ---------------------------------------------------------------- seller: save the bank account
create or replace function public.set_my_bank_payout(p_account_number text, p_ifsc text, p_beneficiary text, p_account_type text default 'savings')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_num   text := regexp_replace(coalesce(p_account_number, ''), '[\s-]', '', 'g');
  v_ifsc  text := upper(btrim(coalesce(p_ifsc, '')));
  v_name  text := btrim(regexp_replace(coalesce(p_beneficiary, ''), '\s+', ' ', 'g'));
  v_type  text := lower(btrim(coalesce(p_account_type, 'savings')));
  v_old_n text;
  v_old_i text;
  v_cool  integer;
  v_at    timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if v_num !~ '^[0-9]{9,18}$' or v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' or length(v_name) < 2 or length(v_name) > 120 or v_type not in ('savings', 'current') then
    raise exception using errcode = 'CM080', message = 'invalid_bank_details';
  end if;
  if (select count(*) from public.audit_log a
       where a.actor_id = v_uid and a.action = 'payout_bank_set' and a.created_at > now() - interval '24 hours') >= 5 then
    raise exception using errcode = 'CM080', message = 'too_many_changes';
  end if;

  select a.bank_account_number, a.bank_ifsc into v_old_n, v_old_i from public.seller_payout_accounts a where a.user_id = v_uid;

  insert into public.seller_payout_accounts
    (user_id, bank_account_number, bank_account_last4, bank_ifsc, bank_beneficiary_name, bank_account_type, status, set_by, updated_at)
  values (v_uid, v_num, right(v_num, 4), v_ifsc, v_name, coalesce(v_type, 'savings'), 'active', v_uid, now())
  on conflict (user_id) do update
    set bank_account_number   = excluded.bank_account_number,
        bank_account_last4    = excluded.bank_account_last4,
        bank_ifsc             = excluded.bank_ifsc,
        bank_beneficiary_name = excluded.bank_beneficiary_name,
        bank_account_type     = excluded.bank_account_type,
        status                = case when public.seller_payout_accounts.status = 'suspended' then 'suspended' else 'active' end,   -- a suspension survives
        -- a CHANGE of an existing, different account starts the cooldown; the first save and a re-save of the same account do not
        bank_changed_at       = case when v_old_n is not null and (v_old_n <> excluded.bank_account_number or v_old_i is distinct from excluded.bank_ifsc)
                                     then now() else public.seller_payout_accounts.bank_changed_at end,
        set_by                = v_uid,
        updated_at            = now();

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'payout_bank_set', 'user', v_uid, jsonb_build_object('last4', right(v_num, 4), 'ifsc', v_ifsc));

  select c.upi_cooldown_hours into v_cool from private.settlement_config c where c.id;
  select case when v_cool > 0 and a.bank_changed_at is not null and a.bank_changed_at + make_interval(hours => v_cool) > now()
              then a.bank_changed_at + make_interval(hours => v_cool) end
    into v_at from public.seller_payout_accounts a where a.user_id = v_uid;
  return jsonb_build_object('outcome', 'saved', 'bank_cooldown_hours', v_cool, 'bank_unlocks_at', v_at);
end;
$$;
revoke all on function public.set_my_bank_payout(text, text, text, text) from public, anon, authenticated;
grant execute on function public.set_my_bank_payout(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- seller: what the screen may show (never the full number)
create or replace function public.my_bank_payout()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  a      record;
  v_cool integer;
  v_at   timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  select c.upi_cooldown_hours into v_cool from private.settlement_config c where c.id;
  select acc.bank_account_number, acc.bank_account_last4, acc.bank_ifsc, acc.bank_beneficiary_name, acc.bank_account_type, acc.status, acc.bank_changed_at
    into a from public.seller_payout_accounts acc where acc.user_id = v_uid;
  if not found or a.bank_account_number is null then
    return jsonb_build_object('configured', false, 'bank_cooldown_hours', v_cool);
  end if;
  if v_cool > 0 and a.bank_changed_at is not null and a.bank_changed_at + make_interval(hours => v_cool) > now() then
    v_at := a.bank_changed_at + make_interval(hours => v_cool);
  end if;
  return jsonb_build_object('configured', a.bank_ifsc is not null, 'last4', right(a.bank_account_number, 4), 'ifsc', a.bank_ifsc,
                            'beneficiary_name', a.bank_beneficiary_name, 'account_type', a.bank_account_type, 'account_status', a.status,
                            'bank_cooldown_hours', v_cool, 'bank_unlocks_at', v_at);
end;
$$;
revoke all on function public.my_bank_payout() from public, anon, authenticated;
grant execute on function public.my_bank_payout() to authenticated;

-- ---------------------------------------------------------------- listing gate
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
  -- the dormant direct-UPI model keeps its own rule if its flag is ever switched on (it is seeded OFF)
  if private.direct_upi_enabled() then
    select acc.vpa_address, acc.status, acc.vpa_changed_at into a from public.seller_payout_accounts acc where acc.user_id = new.seller_id;
    if not private.seller_identity_complete(new.seller_id) or not found or a.vpa_address is null or a.status <> 'active' then
      raise exception using errcode = 'CM079', message = 'seller_setup_incomplete';
    end if;
    select c.upi_cooldown_hours into v_h from private.direct_upi_config c where c.id;
    if v_h > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_h) > now() then
      raise exception using errcode = 'CM079', message = 'upi_in_cooldown';
    end if;
    return new;
  end if;
  -- manual bank payouts (the live model): a saved bank account number + IFSC, on an account that is not suspended
  select acc.bank_account_number, acc.bank_ifsc, acc.status into a from public.seller_payout_accounts acc where acc.user_id = new.seller_id;
  if not found or a.bank_account_number is null or a.bank_ifsc is null or a.status = 'suspended' then
    raise exception using errcode = 'CM079', message = 'bank_account_required';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- admin: preview of what a batch would pay
create or replace function public.admin_settlement_pending(p_period_end timestamptz default null, p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end     timestamptz := coalesce(p_period_end, now());
  v_start   timestamptz;
  v_min     integer;
  v_cool    integer;
  v_payable jsonb;
  v_blocked jsonb;
  v_totals  jsonb;
  v_open    uuid;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if v_end > now() + interval '1 hour' or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select c.start_at, c.min_payout_paise, c.upi_cooldown_hours into v_start, v_min, v_cool from private.settlement_config c where c.id;
  select b.id into v_open from public.settlement_batches b where b.status = 'open';

  with e as (
    select x.seller_id, sum(x.amount_paise)::bigint as amt, sum(x.fee_paise)::bigint as fee, count(*)::integer as cnt
      from private.settlement_eligible(v_end) x group by x.seller_id
  ),
  j as (
    select e.*, pr.display_name, a.bank_beneficiary_name, a.bank_account_last4, a.bank_ifsc, a.status as acct_status,
           case when v_cool > 0 and a.bank_changed_at is not null and a.bank_changed_at + make_interval(hours => v_cool) > now()
                then a.bank_changed_at + make_interval(hours => v_cool) end as unlocks_at,
           case when a.user_id is null or a.bank_account_number is null or a.bank_ifsc is null then 'no_bank_account'
                when a.status <> 'active' then 'account_' || a.status
                when (v_cool > 0 and a.bank_changed_at is not null and a.bank_changed_at + make_interval(hours => v_cool) > now()) then 'bank_in_cooldown'
                when e.amt < v_min then 'below_minimum' end as blocked_reason
      from e
      left join public.seller_payout_accounts a on a.user_id = e.seller_id
      left join public.profiles pr on pr.id = e.seller_id
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object('seller_id', j.seller_id, 'seller_name', j.display_name,
                                                  'bank_beneficiary_name', j.bank_beneficiary_name, 'bank_account_last4', j.bank_account_last4, 'bank_ifsc', j.bank_ifsc,
                                                  'account_status', j.acct_status, 'amount_paise', j.amt, 'platform_fee_paise', j.fee, 'purchase_count', j.cnt)
                               order by j.amt desc, j.seller_id)
                from (select * from j where j.blocked_reason is null order by j.amt desc, j.seller_id limit p_limit) j), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('seller_id', j.seller_id, 'seller_name', j.display_name, 'account_status', j.acct_status,
                                                  'reason', j.blocked_reason, 'bank_unlocks_at', j.unlocks_at, 'amount_paise', j.amt, 'purchase_count', j.cnt)
                               order by j.amt desc, j.seller_id)
                from (select * from j where j.blocked_reason is not null order by j.amt desc, j.seller_id limit p_limit) j), '[]'::jsonb),
    jsonb_build_object(
      'payable_paise',  coalesce((select sum(j.amt) from j where j.blocked_reason is null), 0),
      'payable_sellers', (select count(*) from j where j.blocked_reason is null),
      'payable_purchases', coalesce((select sum(j.cnt) from j where j.blocked_reason is null), 0),
      'blocked_paise',  coalesce((select sum(j.amt) from j where j.blocked_reason is not null), 0),
      'blocked_sellers', (select count(*) from j where j.blocked_reason is not null))
  into v_payable, v_blocked, v_totals;

  return jsonb_build_object(
    'period_end', v_end,
    'start_at', case when v_start = '-infinity'::timestamptz then null else v_start end,
    'min_payout_paise', v_min,
    'bank_cooldown_hours', v_cool,
    'open_batch_id', v_open,
    'totals', v_totals, 'payable', v_payable, 'blocked', v_blocked);
end;
$$;

-- ---------------------------------------------------------------- admin: freeze a batch (snapshots the bank account of every paid seller)
create or replace function public.admin_create_settlement_batch(p_label text, p_period_end timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := btrim(p_label);
  v_end   timestamptz := coalesce(p_period_end, now());
  v_batch uuid;
  v_n     integer;
  v_total bigint;
  v_cnt   integer;
  v_min   integer;
  v_cool  integer;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if v_label is null or length(v_label) < 1 or length(v_label) > 60 or v_end > now() + interval '1 hour' then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('settlement_batch', 0));
  select c.min_payout_paise, c.upi_cooldown_hours into v_min, v_cool from private.settlement_config c where c.id;
  if exists (select 1 from public.settlement_batches b where b.status = 'open') then
    raise exception using errcode = 'CM076', message = 'open_batch_exists';
  end if;
  if exists (select 1 from public.settlement_batches b where b.label = v_label) then
    raise exception using errcode = 'CM076', message = 'label_taken';
  end if;

  insert into public.settlement_batches (label, period_end, created_by) values (v_label, v_end, (select auth.uid()))
  returning id into v_batch;

  with e as materialized (select * from private.settlement_eligible(v_end)),
  a as (
    select e.seller_id, acct.bank_account_number, acct.bank_ifsc, acct.bank_beneficiary_name, acct.bank_account_type,
           sum(e.amount_paise)::bigint as amt, sum(e.fee_paise)::bigint as fee, count(*)::integer as cnt
      from e
      join public.seller_payout_accounts acct on acct.user_id = e.seller_id and acct.status = 'active'
                                             and acct.bank_account_number is not null and acct.bank_ifsc is not null
     where not (v_cool > 0 and acct.bank_changed_at is not null and acct.bank_changed_at + make_interval(hours => v_cool) > now())
     group by e.seller_id, acct.bank_account_number, acct.bank_ifsc, acct.bank_beneficiary_name, acct.bank_account_type
    having sum(e.amount_paise) >= v_min
  ),
  ins as (
    insert into public.settlement_items (batch_id, seller_id, bank_account_number, bank_ifsc, bank_beneficiary_name, bank_account_type,
                                         amount_paise, platform_fee_paise, purchase_count)
    select v_batch, a.seller_id, a.bank_account_number, a.bank_ifsc, coalesce(a.bank_beneficiary_name, 'Account holder'), coalesce(a.bank_account_type, 'savings'),
           a.amt, a.fee, a.cnt from a
    returning id, seller_id
  )
  insert into public.purchase_settlements (purchase_id, item_id, seller_id, amount_paise, platform_fee_paise)
  select e.purchase_id, ins.id, e.seller_id, e.amount_paise, e.fee_paise
    from e join ins on ins.seller_id = e.seller_id;

  select count(*)::integer, coalesce(sum(i.amount_paise), 0)::bigint into v_n, v_total from public.settlement_items i where i.batch_id = v_batch;
  if v_n = 0 then
    raise exception using errcode = 'CM076', message = 'nothing_to_settle';
  end if;
  update public.settlement_batches b set total_paise = v_total, seller_count = v_n where b.id = v_batch;
  select count(*)::integer into v_cnt from public.purchase_settlements s join public.settlement_items i on i.id = s.item_id where i.batch_id = v_batch;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'settlement_batch_created', 'settlement_batch', v_batch,
          jsonb_build_object('label', v_label, 'period_end', v_end, 'sellers', v_n, 'purchases', v_cnt, 'total_paise', v_total));
  return jsonb_build_object('batch_id', v_batch, 'seller_count', v_n, 'purchase_count', v_cnt, 'total_paise', v_total);
end;
$$;

-- ---------------------------------------------------------------- admin: one batch with its items (the CSV is built from this; full account numbers, admin + MFA only)
create or replace function public.admin_settlement_batch(p_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_b     public.settlement_batches%rowtype;
  v_items jsonb;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_batch_id is null then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select * into v_b from public.settlement_batches b where b.id = p_batch_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select coalesce(jsonb_agg(x.j order by x.amount_paise desc, x.id), '[]'::jsonb) into v_items
    from (
      select i.id, i.amount_paise,
             jsonb_build_object(
               'item_id', i.id, 'seller_id', i.seller_id, 'seller_name', pr.display_name,
               'vpa_address', i.vpa_address,
               'bank_account_number', i.bank_account_number, 'bank_ifsc', i.bank_ifsc,
               'bank_beneficiary_name', i.bank_beneficiary_name, 'bank_account_type', i.bank_account_type,
               'amount_paise', i.amount_paise, 'platform_fee_paise', i.platform_fee_paise, 'purchase_count', i.purchase_count,
               'status', i.status, 'utr', i.utr, 'paid_at', i.paid_at, 'released_reason', i.released_reason,
               'account_status', a.status,
               'refunded_purchase_count', (select count(*) from public.purchase_settlements s join public.purchases p on p.id = s.purchase_id
                                            where s.item_id = i.id and p.status <> 'paid'),
               'bank_changed_since_snapshot', (i.bank_account_number is not null
                                               and (a.bank_account_number is distinct from i.bank_account_number or a.bank_ifsc is distinct from i.bank_ifsc)),
               'bank_changed_recently', exists (select 1 from public.audit_log al
                                                where al.action = 'payout_bank_set' and al.target_id = i.seller_id
                                                  and al.created_at > v_b.created_at - interval '7 days')) as j
        from public.settlement_items i
        left join public.profiles pr on pr.id = i.seller_id
        left join public.seller_payout_accounts a on a.user_id = i.seller_id
       where i.batch_id = p_batch_id
    ) x;
  return jsonb_build_object(
    'found', true,
    'batch', jsonb_build_object('batch_id', v_b.id, 'label', v_b.label, 'status', v_b.status, 'period_end', v_b.period_end,
                                'total_paise', v_b.total_paise, 'seller_count', v_b.seller_count, 'created_at', v_b.created_at, 'completed_at', v_b.completed_at),
    'items', v_items);
end;
$$;

-- ---------------------------------------------------------------- seller: own earnings and payout status
create or replace function public.seller_settlement_status(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_account text;
  v_last4   text;
  v_start   timestamptz;
  v_min     integer;
  v_cool    integer;
  v_changed timestamptz;
  v_unlocks timestamptz;
  v_items   jsonb;
  v_summary jsonb;
  v_pay     jsonb;
  v_next    date := (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month')::date;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'CM074', message = 'invalid_payout_status_input';
  end if;
  select c.start_at, c.min_payout_paise, c.upi_cooldown_hours into v_start, v_min, v_cool from private.settlement_config c where c.id;
  select a.status, case when a.bank_account_number is not null and a.bank_ifsc is not null then right(a.bank_account_number, 4) end, a.bank_changed_at
    into v_account, v_last4, v_changed from public.seller_payout_accounts a where a.user_id = v_uid;
  if v_last4 is null then v_account := null; end if;
  if v_cool > 0 and v_changed is not null and v_changed + make_interval(hours => v_cool) > now() then
    v_unlocks := v_changed + make_interval(hours => v_cool);
  end if;

  with s as (
    select p.id as purchase_id, p.purchased_at, l.title as listing_title, p.status as pstatus,
           (round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100))::bigint as share,
           si.status as istatus
      from public.purchases p
      join public.listings l on l.id = p.listing_id
      left join public.purchase_settlements ps on ps.purchase_id = p.id
      left join public.settlement_items si on si.id = ps.item_id
     where l.seller_id = v_uid
       and p.razorpay_payment_id is not null
       and p.purchased_at >= v_start
       and round(coalesce(p.platform_fee, 0) * 100) < round(p.amount * 100)
  ),
  c as (
    select s.*,
      case
        when s.istatus = 'paid'                                  then 'settled'
        when s.istatus = 'pending'                               then 'in_batch'
        when s.pstatus = 'refunded'                              then 'refunded'
        when v_account is null                                   then 'needs_bank'
        when v_account <> 'active'                               then 'under_review'
        when v_unlocks is not null                               then 'bank_cooldown'
        else 'unsettled'
      end as code
    from s
  )
  select
    coalesce((select jsonb_agg(x.j order by x.purchased_at desc, x.purchase_id)
                from (
                  select c.purchased_at, c.purchase_id,
                         jsonb_build_object('purchase_id', c.purchase_id, 'listing_title', c.listing_title, 'purchased_at', c.purchased_at,
                                            'status', c.code, 'share_paise', c.share) as j
                    from c order by c.purchased_at desc, c.purchase_id limit p_limit
                ) x), '[]'::jsonb),
    (select jsonb_build_object(
        'unsettled_paise',     coalesce(sum(c.share) filter (where c.code in ('unsettled', 'needs_bank', 'under_review', 'bank_cooldown')), 0),
        'in_batch_paise',      coalesce(sum(c.share) filter (where c.code = 'in_batch'), 0),
        'settled_paise',       coalesce(sum(c.share) filter (where c.code = 'settled'), 0),
        'refunded_paise',      coalesce(sum(c.share) filter (where c.code = 'refunded'), 0),
        'action_needed_paise', coalesce(sum(c.share) filter (where c.code = 'needs_bank'), 0))
       from c)
    into v_items, v_summary;

  select coalesce(jsonb_agg(jsonb_build_object('batch_label', b.label, 'amount_paise', i.amount_paise, 'purchase_count', i.purchase_count,
                                               'reference', i.utr, 'paid_at', i.paid_at,
                                               'bank_masked', case when i.bank_account_number is not null then '****' || right(i.bank_account_number, 4) end,
                                               'upi_masked', case when i.vpa_address is not null then private.mask_vpa(i.vpa_address) end)
                           order by i.paid_at desc, b.label), '[]'::jsonb)
    into v_pay
    from (select * from public.settlement_items x where x.seller_id = v_uid and x.status = 'paid' order by x.paid_at desc limit p_limit) i
    join public.settlement_batches b on b.id = i.batch_id;

  return jsonb_build_object('account_status', coalesce(v_account, 'none'), 'bank_masked', case when v_last4 is not null then '****' || v_last4 end,
                            'next_payout_date', v_next, 'min_payout_paise', v_min,
                            'bank_cooldown_hours', v_cool, 'bank_unlocks_at', v_unlocks, 'summary', v_summary, 'items', v_items, 'payouts', v_pay);
end;
$$;
