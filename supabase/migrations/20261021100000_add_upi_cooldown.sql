-- Milestone 5.7: COOLDOWN after a seller CHANGES their UPI ID (account-takeover safeguard for the manual monthly payout).
--
-- Why: payouts are sent by hand to the saved UPI ID. Someone who briefly gets into a seller's account could swap the ID and be paid at the next run.
-- What this does: when a seller changes an existing UPI ID, the new ID is not payable for private.settlement_config.upi_cooldown_hours (default 72).
--   * A batch freeze (admin_create_settlement_batch) leaves such a seller out: their earnings stay 'unsettled' and roll to the next batch. Nothing is lost.
--   * The preview (admin_settlement_pending) lists them under the blocked reason 'upi_in_cooldown' with the time the ID matures ('upi_unlocks_at').
--   * The seller screens get 'upi_unlocks_at' (seller_settlement_status, seller_upi_cooldown, and the answer of set_my_payout_vpa).
--   * The FIRST save of a UPI ID does not start a cooldown (there is no earlier, trusted ID to protect), and re-saving the same ID changes nothing.
--   * Changing the ID again restarts the clock. 0 hours turns the safeguard off:  update private.settlement_config set upi_cooldown_hours = 0 where id;
--   * Existing sellers are unaffected at apply time (vpa_changed_at is NULL for them); only changes made after this migration are covered.
--   * A batch that is already frozen is not affected: it pays the ID that was snapshotted at freeze (the desk already flags later changes).
--
-- Additive: two new columns, one new read function, CREATE OR REPLACE of four functions (same signatures, grants preserved).
-- Rollback: restore set_my_payout_vpa from 20261018100000 and the three settlement functions from 20261020100000, drop function public.seller_upi_cooldown(),
--   then drop column public.seller_payout_accounts.vpa_changed_at and private.settlement_config.upi_cooldown_hours.

alter table public.seller_payout_accounts add column vpa_changed_at timestamptz;
comment on column public.seller_payout_accounts.vpa_changed_at is
  'When the saved UPI ID was last CHANGED from a previous one (NULL = never changed). Drives the payout cooldown. Not readable by authenticated (column grants do not include it).';

alter table private.settlement_config
  add column upi_cooldown_hours integer not null default 72 check (upi_cooldown_hours >= 0 and upi_cooldown_hours <= 720);
comment on column private.settlement_config.upi_cooldown_hours is
  'Hours a CHANGED UPI ID must wait before it can be included in a settlement batch. 0 = no cooldown.';


create or replace function public.set_my_payout_vpa(p_vpa text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_vpa  text := lower(btrim(p_vpa));
  v_old  text;
  v_cool integer;
  v_at   timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if v_vpa is null or length(v_vpa) > 100 or v_vpa !~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$' then
    raise exception using errcode = 'CM075', message = 'invalid_vpa';
  end if;
  if (select count(*) from public.audit_log a
       where a.actor_id = v_uid and a.action = 'payout_vpa_set' and a.created_at > now() - interval '24 hours') >= 5 then
    raise exception using errcode = 'CM075', message = 'too_many_changes';
  end if;

  select a.vpa_address into v_old from public.seller_payout_accounts a where a.user_id = v_uid;
  if v_old = v_vpa then
    return jsonb_build_object('outcome', 'unchanged');
  end if;

  insert into public.seller_payout_accounts (user_id, vpa_address, status, set_by)
  values (v_uid, v_vpa, 'active', v_uid)
  on conflict (user_id) do update
    set vpa_address = excluded.vpa_address,
        razorpay_contact_id = null, razorpay_fund_account_id = null,        -- a new UPI ID needs a new Razorpay fund account
        status = case when public.seller_payout_accounts.status = 'suspended' then 'suspended' else 'active' end,   -- a suspension survives
        -- 5.7: a CHANGE of an existing UPI ID starts the cooldown clock. The very first save does not (there is no earlier, trusted ID to protect).
        vpa_changed_at = case when v_old is not null then now() else public.seller_payout_accounts.vpa_changed_at end,
        set_by = v_uid, updated_at = now();

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'payout_vpa_set', 'user', v_uid, jsonb_build_object('vpa', private.mask_vpa(v_vpa)));
  select c.upi_cooldown_hours into v_cool from private.settlement_config c where c.id;
  select case when v_cool > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_cool) > now()
              then a.vpa_changed_at + make_interval(hours => v_cool) end
    into v_at from public.seller_payout_accounts a where a.user_id = v_uid;
  return jsonb_build_object('outcome', case when v_old is null then 'saved' else 'changed' end, 'upi_cooldown_hours', v_cool, 'upi_unlocks_at', v_at);
end;
$$;

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
    select e.*, pr.display_name, a.vpa_address, a.status as acct_status,
           case when v_cool > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_cool) > now()
                then a.vpa_changed_at + make_interval(hours => v_cool) end as unlocks_at,
           case when a.user_id is null or a.vpa_address is null then 'no_upi_id'
                when a.status <> 'active' then 'account_' || a.status
                when (v_cool > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_cool) > now()) then 'upi_in_cooldown'
                when e.amt < v_min then 'below_minimum' end as blocked_reason
      from e
      left join public.seller_payout_accounts a on a.user_id = e.seller_id
      left join public.profiles pr on pr.id = e.seller_id
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object('seller_id', j.seller_id, 'seller_name', j.display_name, 'vpa_address', j.vpa_address,
                                                  'account_status', j.acct_status, 'amount_paise', j.amt, 'platform_fee_paise', j.fee, 'purchase_count', j.cnt)
                               order by j.amt desc, j.seller_id)
                from (select * from j where j.blocked_reason is null order by j.amt desc, j.seller_id limit p_limit) j), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('seller_id', j.seller_id, 'seller_name', j.display_name, 'account_status', j.acct_status,
                                                  'reason', j.blocked_reason, 'upi_unlocks_at', j.unlocks_at, 'amount_paise', j.amt, 'purchase_count', j.cnt)
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
    'upi_cooldown_hours', v_cool,
    'open_batch_id', v_open,
    'totals', v_totals, 'payable', v_payable, 'blocked', v_blocked);
end;
$$;

create or replace function public.admin_create_settlement_batch(p_label text, p_period_end timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := btrim(p_label);
  v_end   timestamptz := coalesce(p_period_end, now());     -- null = "everything up to now"
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
  -- a cut-off slightly in the future is tolerated (browser vs database clock skew); a sale can never be stamped later than now() anyway
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

  -- one statement = one snapshot: item totals and the purchase rows can never disagree
  with e as materialized (select * from private.settlement_eligible(v_end)),
  a as (
    select e.seller_id, acct.vpa_address, sum(e.amount_paise)::bigint as amt, sum(e.fee_paise)::bigint as fee, count(*)::integer as cnt
      from e
      join public.seller_payout_accounts acct on acct.user_id = e.seller_id and acct.status = 'active' and acct.vpa_address is not null
      -- 5.7: a UPI ID changed less than upi_cooldown_hours ago is not payable yet; the seller's earnings roll over to the next batch
     where not (v_cool > 0 and acct.vpa_changed_at is not null and acct.vpa_changed_at + make_interval(hours => v_cool) > now())
     group by e.seller_id, acct.vpa_address
    having sum(e.amount_paise) >= v_min                         -- below the minimum: rolls over to the next month
  ),
  ins as (
    insert into public.settlement_items (batch_id, seller_id, vpa_address, amount_paise, platform_fee_paise, purchase_count)
    select v_batch, a.seller_id, a.vpa_address, a.amt, a.fee, a.cnt from a
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
  v_vpa     text;
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
  select a.status, a.vpa_address, a.vpa_changed_at into v_account, v_vpa, v_changed from public.seller_payout_accounts a where a.user_id = v_uid;
  if v_vpa is null then v_account := null; end if;
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
        when v_account is null                                   then 'needs_upi'
        when v_account <> 'active'                               then 'under_review'
        when v_unlocks is not null                               then 'upi_cooldown'
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
        'unsettled_paise',     coalesce(sum(c.share) filter (where c.code in ('unsettled', 'needs_upi', 'under_review', 'upi_cooldown')), 0),
        'in_batch_paise',      coalesce(sum(c.share) filter (where c.code = 'in_batch'), 0),
        'settled_paise',       coalesce(sum(c.share) filter (where c.code = 'settled'), 0),
        'refunded_paise',      coalesce(sum(c.share) filter (where c.code = 'refunded'), 0),
        'action_needed_paise', coalesce(sum(c.share) filter (where c.code = 'needs_upi'), 0))
       from c)
    into v_items, v_summary;

  select coalesce(jsonb_agg(jsonb_build_object('batch_label', b.label, 'amount_paise', i.amount_paise, 'purchase_count', i.purchase_count,
                                               'reference', i.utr, 'paid_at', i.paid_at, 'upi_masked', private.mask_vpa(i.vpa_address))
                           order by i.paid_at desc, b.label), '[]'::jsonb)
    into v_pay
    from (select * from public.settlement_items x where x.seller_id = v_uid and x.status = 'paid' order by x.paid_at desc limit p_limit) i
    join public.settlement_batches b on b.id = i.batch_id;

  return jsonb_build_object('account_status', coalesce(v_account, 'none'), 'upi_masked', private.mask_vpa(v_vpa),
                            'next_payout_date', v_next, 'min_payout_paise', v_min,
                            'upi_cooldown_hours', v_cool, 'upi_unlocks_at', v_unlocks, 'summary', v_summary, 'items', v_items, 'payouts', v_pay);
end;
$$;

-- the small read the /sell/payout page needs (the table column is deliberately not granted to authenticated)
create function public.seller_upi_cooldown()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_cool integer;
  v_at   timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  select c.upi_cooldown_hours into v_cool from private.settlement_config c where c.id;
  select case when v_cool > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_cool) > now()
              then a.vpa_changed_at + make_interval(hours => v_cool) end
    into v_at from public.seller_payout_accounts a where a.user_id = v_uid;
  return jsonb_build_object('upi_cooldown_hours', v_cool, 'upi_unlocks_at', v_at);
end;
$$;
revoke all on function public.seller_upi_cooldown() from public, anon, authenticated;
grant execute on function public.seller_upi_cooldown() to authenticated;
