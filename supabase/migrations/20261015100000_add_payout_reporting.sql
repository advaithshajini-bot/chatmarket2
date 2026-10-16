-- Milestone 5.3 (part 1): admin reporting for payouts, refunds and disputes.
--
-- ADDITIVE and READ-ONLY. No table, column, flag or existing function is touched. Nine new functions:
--
--   private.transfer_bucket(...)                  one place that decides which money bucket a transfer is in
--   private.payment_attention_rows()              everything a human should look at, one row per problem
--   public.admin_payment_attention_count()        integer (drives the admin nav badge)
--   public.admin_payment_attention(integer)       the "Needs attention" list
--   public.admin_transfers_ledger(text,int,int)   filterable transfer ledger
--   public.admin_disputes_refunds(text,int,int)   disputes with their transfer and refund state
--   public.admin_purchase_timeline(uuid)          payment -> transfer -> dispute -> refund + webhook events + audit
--   public.admin_seller_balances(integer)         per-seller totals in integer paise
--
-- Every public function is SECURITY DEFINER with search_path = '' and runs private.is_admin_mfa() (admin AND aal2) as its
-- FIRST statement (errcode 42501). Granted to authenticated only; nothing is granted to anon or service_role.
-- Webhook payloads are never returned (the table only stores a SHA anyway); error text is returned to admins only.
--
-- Figures reflect the LOCAL ledger (webhook / poll updates), not bank reality: until Route is live there is no
-- reconciliation against Razorpay, by decision.
--
-- Error code: CM073 (invalid reporting input). Every earlier code is untouched.
--
-- Rollback (nothing depends on these until the 5.3 app code is deployed):
--   drop function public.admin_seller_balances(integer);
--   drop function public.admin_purchase_timeline(uuid);
--   drop function public.admin_disputes_refunds(text,integer,integer);
--   drop function public.admin_transfers_ledger(text,integer,integer);
--   drop function public.admin_payment_attention(integer);
--   drop function public.admin_payment_attention_count();
--   drop function private.payment_attention_rows();
--   drop function private.transfer_bucket(text,text,boolean,text);

-- ---------------------------------------------------------------- bucket
-- attention > failed > reversed > in_flight > settled > releasing > held
create function private.transfer_bucket(p_status text, p_settlement text, p_on_hold boolean, p_review_reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_review_reason is not null then 'parked'
    when p_status = 'failed'         then 'failed'
    when p_status = 'reversed'       then 'reversed'
    when p_status = 'creating'       then 'creating'
    when p_settlement = 'settled'    then 'settled'
    when p_on_hold                   then 'held'
    else 'releasing'
  end;
$$;
revoke execute on function private.transfer_bucket(text, text, boolean, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- attention rows (one per problem)
create function private.payment_attention_rows()
returns table (
  kind         text,
  purchase_id  uuid,
  since        timestamptz,
  detail       text,
  seller_id    uuid,
  buyer_id     uuid,
  amount_paise bigint,
  event_id     uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  -- transfers: parked > failed > stuck creating (one row per transfer)
  select case when t.review_reason is not null then 'parked_transfer'
              when t.status = 'failed' then 'transfer_failed'
              else 'transfer_stuck' end,
         t.purchase_id, t.updated_at,
         coalesce(t.review_reason, t.error, 'creating for over 15 minutes'),
         t.seller_id, p.user_id, round(p.amount * 100)::bigint, null::uuid
    from public.transfers t
    join public.purchases p on p.id = t.purchase_id
   where t.review_reason is not null
      or t.status = 'failed'
      or (t.status = 'creating' and t.updated_at < now() - interval '15 minutes')
  union all
  -- refunds: failed, stuck creating, pending for over a day
  select case when r.status = 'failed' then 'refund_failed' else 'refund_stuck' end,
         r.purchase_id, r.updated_at,
         coalesce(r.error, case when r.status = 'creating' then 'creating for over 15 minutes' else 'pending for over a day' end),
         l.seller_id, p.user_id, r.amount_paise::bigint, null::uuid
    from public.refunds r
    join public.purchases p on p.id = r.purchase_id
    left join public.listings l on l.id = p.listing_id
   where r.status = 'failed'
      or (r.status = 'creating' and r.updated_at < now() - interval '15 minutes')
      or (r.status = 'pending'  and r.updated_at < now() - interval '1 day')
  union all
  -- disputes: open, a transfer exists, not parked, but the hold has not been confirmed for 10 minutes
  select 'dispute_hold_pending', d.purchase_id, d.created_at, 'open dispute; transfer not yet on hold',
         t.seller_id, d.buyer_id, round(p.amount * 100)::bigint, null::uuid
    from public.disputes d
    join public.transfers t on t.purchase_id = d.purchase_id
    join public.purchases p on p.id = d.purchase_id
   where d.status = 'open'
     and t.review_reason is null
     and t.status in ('created', 'pending', 'processed', 'partially_reversed')
     and (t.on_hold is not true or t.hold_until is not null)
     and d.created_at < now() - interval '10 minutes'
  union all
  -- webhook events a human must look at (needs_review: last 30 days; failed: stuck for over an hour)
  select 'webhook_' || w.status, w.purchase_id, w.received_at,
         coalesce(w.outcome, '') || case when w.error is not null then ' ' || w.error else '' end,
         null::uuid, null::uuid, null::bigint, w.id
    from public.webhook_events w
   where (w.status = 'needs_review' and w.received_at > now() - interval '30 days')
      or (w.status = 'failed' and w.received_at < now() - interval '1 hour' and w.received_at > now() - interval '30 days');
$$;
revoke execute on function private.payment_attention_rows() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- count (nav badge)
create function public.admin_payment_attention_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  return (select count(*)::integer from private.payment_attention_rows());
end;
$$;

-- ---------------------------------------------------------------- attention list
create function public.admin_payment_attention(p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_total integer;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'CM073', message = 'invalid_reporting_input';
  end if;

  select count(*)::integer into v_total from private.payment_attention_rows();

  select coalesce(jsonb_agg(x.j order by x.since asc), '[]'::jsonb) into v_items
    from (
      select r.since,
             jsonb_build_object(
               'kind', r.kind, 'purchase_id', r.purchase_id, 'event_id', r.event_id,
               'since', r.since, 'age_seconds', floor(extract(epoch from (now() - r.since)))::bigint,
               'detail', left(r.detail, 300), 'amount_paise', r.amount_paise,
               'seller_id', r.seller_id, 'seller_name', sp.display_name,
               'buyer_id', r.buyer_id, 'buyer_name', bp.display_name) as j
        from private.payment_attention_rows() r
        left join public.profiles sp on sp.id = r.seller_id
        left join public.profiles bp on bp.id = r.buyer_id
       order by r.since asc
       limit p_limit
    ) x;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------- transfers ledger
-- p_bucket: null (all) | held | releasing | settled | reversed | failed | parked | creating
create function public.admin_transfers_ledger(p_bucket text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_items jsonb;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0
     or (p_bucket is not null and p_bucket not in ('held', 'releasing', 'settled', 'reversed', 'failed', 'parked', 'creating')) then
    raise exception using errcode = 'CM073', message = 'invalid_reporting_input';
  end if;

  select count(*)::integer into v_total
    from public.transfers t
   where p_bucket is null
      or private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) = p_bucket;

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_items
    from (
      select t.created_at, t.id,
             jsonb_build_object(
               'purchase_id', t.purchase_id, 'bucket', private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason),
               'status', t.status, 'settlement_status', t.settlement_status, 'on_hold', t.on_hold, 'hold_until', t.hold_until,
               'amount_paise', t.amount_paise, 'platform_fee_paise', t.platform_fee_paise, 'amount_reversed_paise', t.amount_reversed_paise,
               'attempts', t.attempts, 'error', left(t.error, 300), 'review_reason', t.review_reason,
               'razorpay_transfer_id', t.razorpay_transfer_id,
               'seller_id', t.seller_id, 'seller_name', sp.display_name,
               'buyer_name', bp.display_name, 'created_at', t.created_at, 'updated_at', t.updated_at,
               'dispute_status', d.status) as j
        from public.transfers t
        join public.purchases p on p.id = t.purchase_id
        left join public.profiles sp on sp.id = t.seller_id
        left join public.profiles bp on bp.id = p.user_id
        left join public.disputes d on d.purchase_id = t.purchase_id
       where p_bucket is null
          or private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) = p_bucket
       order by t.created_at desc, t.id
       limit p_limit offset p_offset
    ) x;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------- disputes + refunds (one row per dispute)
create function public.admin_disputes_refunds(p_status text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_items jsonb;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0
     or (p_status is not null and p_status not in ('open', 'resolved_refunded', 'resolved_denied')) then
    raise exception using errcode = 'CM073', message = 'invalid_reporting_input';
  end if;

  select count(*)::integer into v_total from public.disputes d where p_status is null or d.status = p_status;

  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_items
    from (
      select d.created_at, d.id,
             jsonb_build_object(
               'purchase_id', d.purchase_id, 'dispute_status', d.status, 'reason', left(d.reason, 300),
               'created_at', d.created_at, 'resolved_at', d.resolved_at,
               'amount_paise', round(p.amount * 100)::bigint,
               'buyer_name', bp.display_name, 'seller_name', sp.display_name,
               'transfer_bucket', case when t.id is null then null
                                       else private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) end,
               'transfer_review_reason', t.review_reason,
               'refund_status', r.status, 'refund_amount_paise', r.amount_paise, 'refund_error', left(r.error, 300)) as j
        from public.disputes d
        join public.purchases p on p.id = d.purchase_id
        left join public.profiles bp on bp.id = d.buyer_id
        left join public.profiles sp on sp.id = coalesce(d.seller_id, (select l.seller_id from public.listings l where l.id = p.listing_id))
        left join public.transfers t on t.purchase_id = d.purchase_id
        left join public.refunds r on r.purchase_id = d.purchase_id
       where p_status is null or d.status = p_status
       order by d.created_at desc, d.id
       limit p_limit offset p_offset
    ) x;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------- per-purchase timeline
create function public.admin_purchase_timeline(p_purchase_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_p public.purchases%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_purchase_id is null then
    raise exception using errcode = 'CM073', message = 'invalid_reporting_input';
  end if;
  select * into v_p from public.purchases p where p.id = p_purchase_id;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'purchase', (select jsonb_build_object(
        'id', v_p.id, 'amount_paise', round(v_p.amount * 100)::bigint, 'platform_fee_paise', round(coalesce(v_p.platform_fee, 0) * 100)::bigint,
        'status', v_p.status, 'transfer_status', v_p.transfer_status, 'purchased_at', v_p.purchased_at,
        'razorpay_payment_id', v_p.razorpay_payment_id,
        'buyer_name', (select display_name from public.profiles where id = v_p.user_id),
        'seller_name', (select pr.display_name from public.listings l join public.profiles pr on pr.id = l.seller_id where l.id = v_p.listing_id),
        'listing_title', (select l.title from public.listings l where l.id = v_p.listing_id))),
    'transfer', (select to_jsonb(x) from (
        select t.status, t.settlement_status, t.on_hold, t.hold_until, t.amount_paise, t.platform_fee_paise, t.amount_reversed_paise,
               t.attempts, t.last_attempt_at, t.next_attempt_at, left(t.error, 300) as error, t.review_reason,
               t.razorpay_transfer_id, t.created_at, t.updated_at
          from public.transfers t where t.purchase_id = p_purchase_id) x),
    'dispute', (select to_jsonb(x) from (
        select d.status, d.reason, d.resolution_note, d.created_at, d.resolved_at
          from public.disputes d where d.purchase_id = p_purchase_id) x),
    'refund', (select to_jsonb(x) from (
        select r.status, r.amount_paise, r.attempts, left(r.error, 300) as error, r.razorpay_refund_id, r.created_at, r.updated_at
          from public.refunds r where r.purchase_id = p_purchase_id) x),
    'webhook_events', (select coalesce(jsonb_agg(x.j order by x.received_at), '[]'::jsonb) from (
        select w.received_at, jsonb_build_object('event_type', w.event_type, 'status', w.status, 'outcome', w.outcome,
                 'error', left(w.error, 300), 'attempts', w.attempts, 'received_at', w.received_at, 'processed_at', w.processed_at) as j
          from public.webhook_events w
         where w.purchase_id = p_purchase_id
            or (v_p.razorpay_payment_id is not null and w.razorpay_payment_id = v_p.razorpay_payment_id)
         limit 100) x),
    'audit', (select coalesce(jsonb_agg(x.j order by x.created_at), '[]'::jsonb) from (
        select a.created_at, jsonb_build_object('action', a.action, 'created_at', a.created_at) as j
          from public.audit_log a
         where a.target_type = 'purchase' and a.target_id = p_purchase_id
         limit 100) x)
  );
end;
$$;

-- ---------------------------------------------------------------- seller balances (integer paise)
create function public.admin_seller_balances(p_limit integer default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_total integer;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'CM073', message = 'invalid_reporting_input';
  end if;

  with tb as (
    select t.seller_id,
           private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) as b,
           (t.amount_paise - t.amount_reversed_paise)::bigint as net,
           t.amount_reversed_paise::bigint as rev
      from public.transfers t
  ),
  agg as (
    select seller_id,
           coalesce(sum(net) filter (where b = 'held'), 0)      as held,
           coalesce(sum(net) filter (where b = 'releasing'), 0) as releasing,
           coalesce(sum(net) filter (where b = 'settled'), 0)   as settled,
           coalesce(sum(rev), 0)                                as reversed,
           coalesce(sum(net) filter (where b in ('failed', 'parked', 'creating')), 0) as needs_attention,
           count(*) filter (where b in ('failed', 'parked'))::integer as attention_count
      from tb group by seller_id
  ),
  waiting as (
    -- paid, payment id present, no transfer row: money the seller has earned but no transfer exists for yet
    select l.seller_id,
           coalesce(sum(round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100)), 0)::bigint as awaiting,
           count(*)::integer as awaiting_count
      from public.purchases p
      join public.listings l on l.id = p.listing_id
     where p.status = 'paid' and p.razorpay_payment_id is not null and l.seller_id is not null
       and not exists (select 1 from public.transfers t where t.purchase_id = p.id)
     group by l.seller_id
  ),
  sellers as (
    select seller_id from agg
    union select seller_id from waiting
    union select user_id from public.seller_payout_accounts
  )
  select (select count(*)::integer from sellers),
         coalesce(jsonb_agg(z.j order by z.o1 desc, z.o2 desc, z.o3, z.o4), '[]'::jsonb)
    into v_total, v_items
    from (
      select coalesce(g.needs_attention, 0) as o1, coalesce(w.awaiting, 0) as o2, pr.display_name as o3, s.seller_id as o4,
             jsonb_build_object(
               'seller_id', s.seller_id, 'seller_name', pr.display_name,
               'account_status', a.status, 'razorpay_account_id', a.razorpay_account_id,
               'held_paise', coalesce(g.held, 0), 'releasing_paise', coalesce(g.releasing, 0), 'settled_paise', coalesce(g.settled, 0),
               'reversed_paise', coalesce(g.reversed, 0), 'attention_paise', coalesce(g.needs_attention, 0),
               'attention_count', coalesce(g.attention_count, 0),
               'awaiting_transfer_paise', coalesce(w.awaiting, 0), 'awaiting_transfer_count', coalesce(w.awaiting_count, 0)) as j
        from sellers s
        left join agg g on g.seller_id = s.seller_id
        left join waiting w on w.seller_id = s.seller_id
        left join public.seller_payout_accounts a on a.user_id = s.seller_id
        left join public.profiles pr on pr.id = s.seller_id
       order by 1 desc, 2 desc, 3, 4
       limit p_limit
    ) z;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

revoke all on function public.admin_payment_attention_count() from public, anon, authenticated;
revoke all on function public.admin_payment_attention(integer) from public, anon, authenticated;
revoke all on function public.admin_transfers_ledger(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_purchase_timeline(uuid) from public, anon, authenticated;
revoke all on function public.admin_disputes_refunds(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_seller_balances(integer) from public, anon, authenticated;
grant execute on function public.admin_payment_attention_count() to authenticated;
grant execute on function public.admin_payment_attention(integer) to authenticated;
grant execute on function public.admin_transfers_ledger(text, integer, integer) to authenticated;
grant execute on function public.admin_purchase_timeline(uuid) to authenticated;
grant execute on function public.admin_disputes_refunds(text, integer, integer) to authenticated;
grant execute on function public.admin_seller_balances(integer) to authenticated;
