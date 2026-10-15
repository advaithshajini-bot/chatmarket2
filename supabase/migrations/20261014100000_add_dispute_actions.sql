-- Milestone 5.2c: disputes -> Route transfers (hold / release / reverse) and the buyer refund.
--
-- ADDITIVE. One new table (refunds), four new columns on the 5.2 table public.transfers, one new flag row (OFF), one private
-- helper pair, eight functions. The only existing function it touches is public.plan_transfer (CREATE OR REPLACE, same
-- signature and grants): it now also says `adopt_only` when a dispute was resolved in the buyer's favour while a creation
-- attempt was still pending, so a refunded purchase can never get a NEW transfer.
--
-- Nothing here moves money by itself. The database DECIDES what a dispute needs (private.dispute_action_needed, derived from the
-- dispute + transfer + refund rows, so it self-heals and needs no queue) and hands out short leases; the app performs the
-- Razorpay call and reports back.
--
--   dispute open              -> the transfer is held indefinitely (PATCH on_hold). Always runs: it is protective.
--   dispute resolved_denied   -> the hold is lifted (or restored to the original 48h end if that is still in the future).
--                                Needs phase5_route_transfers ON: it is the step that lets the seller be paid.
--   dispute resolved_refunded -> the transfer is reversed (always runs: protective), THEN the buyer is refunded. The refund
--                                needs its own flag, phase5_auto_refunds (seeded OFF); without it the refund stays a manual
--                                step in the Razorpay dashboard and nothing is lost.
--   anything that cannot be done safely (the transfer already settled when a dispute opened, a reversal Razorpay refuses, a
--   retry budget used up) is parked in transfers.review_reason and NOT retried until an admin clears it.
--
-- Error code: CM072 (invalid dispute-action input). Every earlier code is untouched.
--
-- Rollback (nothing outside these objects depends on them until the 5.2c app code is deployed):
--   create or replace public.plan_transfer from 20261013100000_add_route_transfers.sql (drops only the adopt_only key);
--   drop function public.admin_clear_transfer_review(uuid);
--   drop function public.record_refund_failure(uuid,text,boolean);
--   drop function public.apply_refund_event(text,uuid,text,integer,text,bigint,text);
--   drop function public.plan_refund(uuid);
--   drop function public.list_dispute_work(integer);
--   drop function public.finish_dispute_action(uuid,text,boolean,boolean,text,boolean,bigint);
--   drop function public.claim_dispute_action(uuid,text);
--   drop function private.dispute_action_needed(uuid);
--   drop function private.is_auto_refunds_enabled();
--   drop table public.refunds;
--   alter table public.transfers drop column review_reason, drop column action_lease_until,
--     drop column action_attempts, drop column action_next_attempt_at;
--   delete from private.feature_flags where name = 'phase5_auto_refunds';

insert into private.feature_flags (name, enabled) values ('phase5_auto_refunds', false) on conflict (name) do nothing;

create function private.is_auto_refunds_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select f.enabled from private.feature_flags f where f.name = 'phase5_auto_refunds'), false) is true;
$$;
revoke execute on function private.is_auto_refunds_enabled() from public, anon, authenticated, service_role;

alter table public.transfers
  add column review_reason          text,
  add column action_lease_until     timestamptz,
  add column action_attempts        integer not null default 0 check (action_attempts >= 0),
  add column action_next_attempt_at timestamptz;
comment on column public.transfers.review_reason is
  'Set when a dispute action could not be done safely. While set, no further automatic dispute action runs for this transfer; an admin clears it with admin_clear_transfer_review().';

-- ---------------------------------------------------------------- refunds
create table public.refunds (
  id                   uuid primary key default gen_random_uuid(),
  purchase_id          uuid not null unique references public.purchases(id) on delete cascade,
  razorpay_payment_id  text not null check (length(razorpay_payment_id) between 1 and 100),
  razorpay_refund_id   text unique check (razorpay_refund_id is null or razorpay_refund_id ~ '^rfnd_[A-Za-z0-9]{6,40}$'),
  amount_paise         integer not null check (amount_paise > 0),
  status               text not null default 'creating' check (status in ('creating', 'pending', 'processed', 'failed')),
  attempts             integer not null default 0 check (attempts >= 0),
  last_attempt_at      timestamptz,
  next_attempt_at      timestamptz,
  last_event_at        bigint,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (razorpay_refund_id is not null or status in ('creating', 'failed'))
);
create index refunds_status_idx on public.refunds (status);
comment on table public.refunds is
  'Ledger of buyer refunds issued through Razorpay for disputes resolved in the buyer''s favour -- at most ONE per purchase (unique purchase_id).';
alter table public.refunds enable row level security;
revoke all on public.refunds from anon, authenticated;
grant select on public.refunds to authenticated;
create policy "Buyers can view their own refunds" on public.refunds
  for select to authenticated using (exists (select 1 from public.purchases p where p.id = purchase_id and p.user_id = (select auth.uid())));
create policy "Admins can view refunds" on public.refunds
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------- what does this dispute need?  (read-only, derived)
-- Returns 'hold' | 'flag' | 'reverse' | 'release' | 'refund' | NULL. NULL also while a lease or a backoff is running, or while
-- the transfer is parked for review.
create function private.dispute_action_needed(p_purchase_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_d      text;
  v_t      public.transfers%rowtype;
  v_tfound boolean;
  v_live   boolean;
  v_p      public.purchases%rowtype;
  v_r      public.refunds%rowtype;
begin
  select d.status into v_d from public.disputes d where d.purchase_id = p_purchase_id;
  if v_d is null then
    return null;
  end if;
  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  v_tfound := found;
  v_live := v_tfound and v_t.razorpay_transfer_id is not null
            and v_t.status in ('created', 'pending', 'processed', 'partially_reversed');
  if v_tfound then
    if v_t.review_reason is not null then
      return null;                                           -- parked: a human decides
    end if;
    if v_t.action_lease_until is not null and v_t.action_lease_until > now() then
      return null;                                           -- someone is working on it
    end if;
    if v_t.action_next_attempt_at is not null and v_t.action_next_attempt_at > now() then
      return null;                                           -- backing off
    end if;
  end if;

  if v_d = 'open' then
    if v_live and v_t.status in ('created', 'pending', 'processed') then
      if coalesce(v_t.settlement_status, '') = 'settled' then
        return 'flag';                                       -- too late to hold: the money has already left
      end if;
      if not (v_t.on_hold and v_t.hold_until is null) then
        return 'hold';
      end if;
    end if;
    return null;
  elsif v_d = 'resolved_denied' then
    if v_live and v_t.status in ('created', 'pending', 'processed') and v_t.on_hold and v_t.hold_until is null
       and coalesce(v_t.settlement_status, '') <> 'settled' and private.is_route_transfers_enabled() then
      return 'release';
    end if;
    return null;
  end if;

  -- resolved_refunded: reverse the transfer first, then refund the buyer
  if v_live and v_t.amount_reversed_paise < v_t.amount_paise then
    return 'reverse';
  end if;
  if v_tfound and v_t.status = 'creating' then
    return null;                                             -- the transfer is unresolved: let that finish (or fail) first
  end if;
  if not private.is_auto_refunds_enabled() then
    return null;
  end if;
  select * into v_p from public.purchases p where p.id = p_purchase_id;
  if not found or v_p.status <> 'refunded' or v_p.razorpay_payment_id is null then
    return null;
  end if;
  select * into v_r from public.refunds r where r.purchase_id = p_purchase_id;
  if not found then
    return 'refund';
  end if;
  if v_r.status = 'creating'
     and ((v_r.next_attempt_at is not null and v_r.next_attempt_at <= now())
          or (v_r.next_attempt_at is null and v_r.last_attempt_at < now() - interval '2 minutes')) then
    return 'refund';
  end if;
  return null;
end;
$$;
revoke execute on function private.dispute_action_needed(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- claim_dispute_action
-- Re-derives the need INSIDE the lock, then takes a 2-minute lease on the transfer. outcome:
--   claimed | not_needed | disabled | not_found
-- claimed returns what to do: hold -> {razorpay_transfer_id}; release -> {razorpay_transfer_id, on_hold, hold_until_epoch};
-- reverse -> {razorpay_transfer_id, amount_paise, amount_reversed_paise}; flag -> {}.
create function public.claim_dispute_action(p_purchase_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t       public.transfers%rowtype;
  v_p       public.purchases%rowtype;
  v_end     timestamptz;
  v_hold    boolean;
begin
  if p_purchase_id is null or p_action is null or p_action not in ('hold', 'flag', 'reverse', 'release') then
    raise exception using errcode = 'CM072', message = 'invalid_dispute_action';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));
  if p_action = 'release' and not private.is_route_transfers_enabled() then
    return jsonb_build_object('outcome', 'disabled');
  end if;
  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if private.dispute_action_needed(p_purchase_id) is distinct from p_action then
    return jsonb_build_object('outcome', 'not_needed');
  end if;

  update public.transfers t
     set action_lease_until = now() + interval '2 minutes', action_attempts = t.action_attempts + 1, updated_at = now()
   where t.id = v_t.id;

  if p_action = 'release' then
    select * into v_p from public.purchases p where p.id = p_purchase_id;
    v_end := v_p.purchased_at + interval '48 hours';
    v_hold := v_end > now() + interval '5 minutes';        -- the original window is still running: restore it, do not shorten it
    return jsonb_build_object('outcome', 'claimed', 'razorpay_transfer_id', v_t.razorpay_transfer_id,
      'on_hold', v_hold, 'hold_until_epoch', case when v_hold then floor(extract(epoch from v_end))::bigint end);
  elsif p_action = 'reverse' then
    return jsonb_build_object('outcome', 'claimed', 'razorpay_transfer_id', v_t.razorpay_transfer_id,
      'amount_paise', v_t.amount_paise, 'amount_reversed_paise', v_t.amount_reversed_paise);
  end if;
  return jsonb_build_object('outcome', 'claimed', 'razorpay_transfer_id', v_t.razorpay_transfer_id);
end;
$$;

-- ---------------------------------------------------------------- finish_dispute_action
-- Reports the result of a claimed action. outcome: ok | retry_scheduled | needs_review | ignored
--   p_ok            the Razorpay call succeeded (hold/release also pass the new hold state)
--   retryable       a failed call may be retried (backoff 1,2,4.. minutes, capped 6h, 8 attempts) -- else it is parked
create function public.finish_dispute_action(
  p_purchase_id uuid, p_action text, p_ok boolean, p_retryable boolean, p_error text,
  p_on_hold boolean default null, p_hold_until_epoch bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.transfers%rowtype;
  v_hold boolean;
  v_until timestamptz;
begin
  if p_purchase_id is null or p_action is null or p_action not in ('hold', 'flag', 'reverse', 'release')
     or p_ok is null or (not p_ok and p_retryable is null)
     or (p_hold_until_epoch is not null and p_hold_until_epoch <= 0) then
    raise exception using errcode = 'CM072', message = 'invalid_dispute_action';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));
  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  if not found then
    return jsonb_build_object('outcome', 'ignored');
  end if;

  if p_ok then
    v_hold := v_t.on_hold; v_until := v_t.hold_until;
    if v_t.settlement_status is distinct from 'settled' then
      if p_action = 'hold' then
        v_hold := true; v_until := null;
      elsif p_action = 'release' then
        v_hold := coalesce(p_on_hold, false);
        v_until := case when v_hold and p_hold_until_epoch is not null then to_timestamp(p_hold_until_epoch) end;
      end if;
    end if;
    update public.transfers t
       set on_hold = v_hold, hold_until = v_until, action_lease_until = null, action_attempts = 0,
           action_next_attempt_at = null, updated_at = now()
     where t.id = v_t.id;
    if p_action in ('hold', 'release') then
      update public.purchases pu set transfer_status = private.purchase_transfer_status(v_t.status, v_hold)
       where pu.id = p_purchase_id;
    end if;
    return jsonb_build_object('outcome', 'ok');
  end if;

  if p_retryable and v_t.action_attempts < 8 then
    update public.transfers t
       set action_lease_until = null, updated_at = now(),
           action_next_attempt_at = now() + least(power(2, t.action_attempts - 1) * interval '1 minute', interval '6 hours')
     where t.id = v_t.id;
    return jsonb_build_object('outcome', 'retry_scheduled');
  end if;
  update public.transfers t
     set action_lease_until = null, action_next_attempt_at = null, updated_at = now(),
         review_reason = left('dispute_' || p_action || ': ' || coalesce(p_error, 'unknown'), 300)
   where t.id = v_t.id;
  return jsonb_build_object('outcome', 'needs_review');
end;
$$;

-- ---------------------------------------------------------------- list_dispute_work
create function public.list_dispute_work(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('kind', w.a, 'purchase_id', w.purchase_id) order by w.ord, w.created_at), '[]'::jsonb)
    from (
      select d.purchase_id, d.created_at, x.a,
             case x.a when 'hold' then 0 when 'flag' then 0 when 'reverse' then 1 when 'release' then 2 else 3 end as ord
        from public.disputes d
       cross join lateral (select private.dispute_action_needed(d.purchase_id) as a) x
       where x.a is not null and d.created_at > now() - interval '180 days'
       order by case x.a when 'hold' then 0 when 'flag' then 0 when 'reverse' then 1 when 'release' then 2 else 3 end, d.created_at
       limit v_limit
    ) w
  );
end;
$$;

-- ---------------------------------------------------------------- plan_refund
-- Claims the right to refund ONE purchase. outcome: claimed | not_needed | disabled | exists
-- The caller must ALWAYS list the payment's refunds at Razorpay before creating one (a manual dashboard refund counts).
create function public.plan_refund(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p      public.purchases%rowtype;
  v_r      public.refunds%rowtype;
  v_amount integer;
begin
  if p_purchase_id is null then
    raise exception using errcode = 'CM072', message = 'invalid_dispute_action';
  end if;
  if not private.is_auto_refunds_enabled() then
    return jsonb_build_object('outcome', 'disabled');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund_purchase:' || p_purchase_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));
  if private.dispute_action_needed(p_purchase_id) is distinct from 'refund' then
    return jsonb_build_object('outcome', 'not_needed');
  end if;
  select * into v_p from public.purchases p where p.id = p_purchase_id;
  v_amount := round(v_p.amount * 100)::integer;
  if v_amount <= 0 then
    return jsonb_build_object('outcome', 'not_needed');
  end if;
  select * into v_r from public.refunds r where r.purchase_id = p_purchase_id;
  if found then
    update public.refunds r set attempts = r.attempts + 1, last_attempt_at = now(), next_attempt_at = null, updated_at = now() where r.id = v_r.id;
    return jsonb_build_object('outcome', 'claimed', 'payment_id', v_r.razorpay_payment_id, 'amount_paise', v_r.amount_paise, 'attempts', v_r.attempts + 1);
  end if;
  insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, attempts, last_attempt_at)
  values (p_purchase_id, v_p.razorpay_payment_id, v_amount, 1, now());
  return jsonb_build_object('outcome', 'claimed', 'payment_id', v_p.razorpay_payment_id, 'amount_paise', v_amount, 'attempts', 1);
end;
$$;

-- ---------------------------------------------------------------- apply_refund_event
-- The ONLY place a refund's state changes after creation (create response, poll, refund.* webhook). Idempotent, forward-only.
-- outcome: applied | stale | unknown_refund | conflicting_refund | inconsistent_event
create function public.apply_refund_event(
  p_refund_id text, p_purchase_id uuid, p_status text, p_amount_paise integer,
  p_payment_id text, p_event_at bigint, p_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r       public.refunds%rowtype;
  v_outcome text;
  v_rank_o  integer;
  v_rank_n  integer;
begin
  if p_refund_id is null or p_refund_id !~ '^rfnd_[A-Za-z0-9]{6,40}$'
     or p_status is null or p_status not in ('pending', 'processed', 'failed')
     or (p_amount_paise is not null and p_amount_paise <= 0)
     or (p_event_at is not null and p_event_at <= 0) then
    raise exception using errcode = 'CM072', message = 'invalid_refund_event';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund:' || p_refund_id, 0));

  select * into v_r from public.refunds r where r.razorpay_refund_id = p_refund_id;
  if not found and p_purchase_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('refund_purchase:' || p_purchase_id::text, 0));
    select * into v_r from public.refunds r where r.purchase_id = p_purchase_id;
    if found and v_r.razorpay_refund_id is not null and v_r.razorpay_refund_id <> p_refund_id then
      v_outcome := 'conflicting_refund';
    elsif not found then
      v_outcome := 'unknown_refund';
    end if;
  elsif not found then
    v_outcome := 'unknown_refund';
  end if;

  if v_outcome is null then
    if (p_amount_paise is not null and p_amount_paise <> v_r.amount_paise)
       or (p_payment_id is not null and p_payment_id <> v_r.razorpay_payment_id) then
      v_outcome := 'inconsistent_event';
    end if;
  end if;

  if v_outcome is null then
    v_rank_o := case v_r.status when 'creating' then 0 when 'pending' then 1 when 'processed' then 2 when 'failed' then 9 end;
    v_rank_n := case p_status when 'pending' then 1 when 'processed' then 2 when 'failed' then 9 end;
    if v_r.status in ('processed', 'failed') then
      v_outcome := 'stale';
    elsif p_event_at is not null and v_r.last_event_at is not null and p_event_at < v_r.last_event_at then
      v_outcome := 'stale';
    elsif v_rank_n < v_rank_o then
      v_outcome := 'stale';
    else
      update public.refunds r
         set razorpay_refund_id = coalesce(r.razorpay_refund_id, p_refund_id), status = p_status,
             last_event_at = greatest(coalesce(r.last_event_at, 0), coalesce(p_event_at, 0)),
             next_attempt_at = null,
             error = case when p_status = 'failed' then coalesce(r.error, 'razorpay_reported_failed') else null end,
             updated_at = now()
       where r.id = v_r.id;
      v_outcome := 'applied';
    end if;
  end if;

  if p_event_id is not null then
    update public.webhook_events e
       set status       = case when v_outcome in ('applied', 'stale') then 'processed' else 'needs_review' end,
           outcome      = 'refund_' || v_outcome,
           processed_at = now(), error = null
     where e.provider = 'razorpay' and e.provider_event_id = p_event_id
       and e.status in ('received', 'failed');
  end if;
  return jsonb_build_object('outcome', v_outcome, 'purchase_id', v_r.purchase_id);
end;
$$;

-- ---------------------------------------------------------------- record_refund_failure
create function public.record_refund_failure(p_purchase_id uuid, p_error text, p_retryable boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_r public.refunds%rowtype;
begin
  if p_purchase_id is null or p_retryable is null then
    raise exception using errcode = 'CM072', message = 'invalid_dispute_action';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund_purchase:' || p_purchase_id::text, 0));
  select * into v_r from public.refunds r where r.purchase_id = p_purchase_id;
  if not found or v_r.status <> 'creating' then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if p_retryable and v_r.attempts < 8 then
    update public.refunds r
       set error = left(p_error, 300),
           next_attempt_at = now() + least(power(2, r.attempts - 1) * interval '1 minute', interval '6 hours'),
           updated_at = now()
     where r.id = v_r.id;
    return jsonb_build_object('outcome', 'retry_scheduled');
  end if;
  update public.refunds r
     set status = 'failed', error = left(coalesce(p_error, 'unknown'), 300), next_attempt_at = null, updated_at = now()
   where r.id = v_r.id;
  return jsonb_build_object('outcome', 'failed');
end;
$$;

-- ---------------------------------------------------------------- admin: clear a parked transfer
create function public.admin_clear_transfer_review(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_purchase_id is null then
    raise exception using errcode = 'CM072', message = 'invalid_dispute_action';
  end if;
  update public.transfers t
     set review_reason = null, action_attempts = 0, action_next_attempt_at = null, action_lease_until = null, updated_at = now()
   where t.purchase_id = p_purchase_id and t.review_reason is not null;
  if not found then
    raise exception using errcode = 'CM072', message = 'nothing_to_clear';
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'transfer_review_cleared', 'purchase', p_purchase_id, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- plan_transfer: never CREATE for a refunded dispute (see header)
create or replace function public.plan_transfer(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p        public.purchases%rowtype;
  v_seller   uuid;
  v_acct     public.seller_payout_accounts%rowtype;
  v_t        public.transfers%rowtype;
  v_amount   integer;
  v_fee      integer;
  v_hold_end timestamptz;
  v_dispute  text;
  v_on_hold  boolean;
  v_lookup   boolean := false;
begin
  if p_purchase_id is null then
    raise exception using errcode = 'CM071', message = 'invalid_transfer_input';
  end if;
  if not private.is_route_transfers_enabled() then
    return jsonb_build_object('outcome', 'disabled');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));

  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  if found then
    if v_t.status <> 'creating' then
      return jsonb_build_object('outcome', 'exists', 'status', v_t.status, 'razorpay_transfer_id', v_t.razorpay_transfer_id);
    end if;
    if v_t.next_attempt_at is not null and v_t.next_attempt_at > now() then
      return jsonb_build_object('outcome', 'backoff', 'next_attempt_at', v_t.next_attempt_at);
    end if;
    if v_t.next_attempt_at is null and v_t.last_attempt_at > now() - interval '2 minutes' then
      return jsonb_build_object('outcome', 'in_progress');
    end if;
    -- a previous attempt may have reached Razorpay (timeout, crash): reclaim, but look before creating.
    -- 5.2c: if the dispute was resolved in the buyer's favour meanwhile, the caller may only ADOPT an existing
    -- transfer (so it can be reversed), never create a new one.
    select d.status into v_dispute from public.disputes d where d.purchase_id = p_purchase_id;
    update public.transfers t
       set attempts = t.attempts + 1, last_attempt_at = now(), next_attempt_at = null, updated_at = now()
     where t.id = v_t.id;
    return jsonb_build_object(
      'outcome', 'claimed', 'purchase_id', p_purchase_id, 'payment_id', v_t.razorpay_payment_id,
      'account_id', v_t.razorpay_account_id, 'amount_paise', v_t.amount_paise,
      'on_hold', v_t.on_hold, 'hold_until_epoch', floor(extract(epoch from v_t.hold_until))::bigint,
      'lookup_first', true, 'adopt_only', coalesce(v_dispute = 'resolved_refunded', false), 'attempts', v_t.attempts + 1);
  end if;

  select * into v_p from public.purchases p where p.id = p_purchase_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_p.status <> 'paid' or v_p.razorpay_payment_id is null then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'purchase_not_paid');
  end if;

  select l.seller_id into v_seller from public.listings l where l.id = v_p.listing_id;
  if v_seller is null then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'no_seller');
  end if;
  select * into v_acct from public.seller_payout_accounts a where a.user_id = v_seller;
  if not found or v_acct.status <> 'active' then
    return jsonb_build_object('outcome', 'no_account');
  end if;

  select d.status into v_dispute from public.disputes d where d.purchase_id = p_purchase_id;
  if v_dispute = 'resolved_refunded' then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'refunded');
  end if;

  v_amount := round(v_p.amount * 100)::integer;
  v_fee    := round(coalesce(v_p.platform_fee, 0) * 100)::integer;
  if v_fee < 0 or v_fee >= v_amount then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'no_seller_share');
  end if;

  -- hold: 48h after the payment was recorded; an OPEN dispute holds indefinitely; an elapsed window needs no hold
  v_hold_end := v_p.purchased_at + interval '48 hours';
  if v_dispute = 'open' then
    v_on_hold := true; v_hold_end := null;
  elsif v_hold_end <= now() + interval '5 minutes' then
    v_on_hold := false; v_hold_end := null;
  else
    v_on_hold := true;
  end if;

  insert into public.transfers
    (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, amount_paise, platform_fee_paise,
     on_hold, hold_until, attempts, last_attempt_at)
  values
    (p_purchase_id, v_seller, v_acct.razorpay_account_id, v_p.razorpay_payment_id, v_amount - v_fee, v_fee,
     v_on_hold, v_hold_end, 1, now());

  return jsonb_build_object(
    'outcome', 'claimed', 'purchase_id', p_purchase_id, 'payment_id', v_p.razorpay_payment_id,
    'account_id', v_acct.razorpay_account_id, 'amount_paise', v_amount - v_fee,
    'on_hold', v_on_hold, 'hold_until_epoch', floor(extract(epoch from v_hold_end))::bigint,
    'lookup_first', v_lookup, 'adopt_only', false, 'attempts', 1);
end;
$$;

-- ---------------------------------------------------------------- grants
-- service_role only, except the admin RPC (authenticated; it checks admin + MFA itself, first statement).
revoke all on function public.claim_dispute_action(uuid, text) from public, anon, authenticated;
revoke all on function public.finish_dispute_action(uuid, text, boolean, boolean, text, boolean, bigint) from public, anon, authenticated;
revoke all on function public.list_dispute_work(integer) from public, anon, authenticated;
revoke all on function public.plan_refund(uuid) from public, anon, authenticated;
revoke all on function public.apply_refund_event(text, uuid, text, integer, text, bigint, text) from public, anon, authenticated;
revoke all on function public.record_refund_failure(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_clear_transfer_review(uuid) from public, anon, authenticated;
grant execute on function public.claim_dispute_action(uuid, text) to service_role;
grant execute on function public.finish_dispute_action(uuid, text, boolean, boolean, text, boolean, bigint) to service_role;
grant execute on function public.list_dispute_work(integer) to service_role;
grant execute on function public.plan_refund(uuid) to service_role;
grant execute on function public.apply_refund_event(text, uuid, text, integer, text, bigint, text) to service_role;
grant execute on function public.record_refund_failure(uuid, text, boolean) to service_role;
grant execute on function public.admin_clear_transfer_review(uuid) to authenticated;
