-- Milestone 5.2a: Razorpay Route transfers -- ledger + deterministic state machine.
--
-- ADDITIVE ONLY. Two new tables, one feature-flag row (OFF), one private helper, eight functions. It does not alter or
-- drop any existing object. The ONLY existing rows it ever writes (later, from inside its own SECURITY DEFINER
-- functions) are purchases.razorpay_transfer_id / purchases.transfer_status, which exist for exactly this purpose.
--
-- Nothing here moves money. The database only RECORDS what the app tells it Razorpay did, enforces that a purchase can
-- have at most ONE transfer, and never lets a late or replayed event move a transfer backwards.
--
-- Kill switch: the flag `phase5_route_transfers` is seeded OFF. While OFF, plan_transfer() refuses ('disabled') and
-- list_transfer_work() offers no new transfers. Events for transfers that already exist are still recorded.
--
-- Eligibility does NOT use profiles.razorpay_linked_account_id / razorpay_account_status: public.set_seller_payout_account
-- is granted to every logged-in user, so a seller could mark THEMSELVES "active" with any account id. Instead an admin
-- (aal2) assigns the Razorpay linked account through public.admin_set_seller_payout_account into a NEW table.
--
-- Money is integer paise. seller share = round(amount*100) - round(platform_fee*100).
--
-- Error codes: CM071 (invalid transfer input). Every earlier error code (CM001-CM062 and the one 5.1 added) is untouched.
--
-- Rollback (nothing outside these objects depends on them until the 5.2 app code is deployed):
--   drop function public.plan_transfer(uuid);
--   drop function public.apply_transfer_event(text,uuid,text,text,boolean,integer,bigint,integer,text,text);
--   drop function public.record_transfer_failure(uuid,text,boolean);
--   drop function public.list_transfer_work(integer);
--   drop function public.prepare_transfer_hold(uuid);
--   drop function public.admin_set_seller_payout_account(uuid,text,text);
--   drop function private.purchase_transfer_status(text,boolean);
--   drop function private.is_route_transfers_enabled();
--   drop table public.transfers; drop table public.seller_payout_accounts;
--   delete from private.feature_flags where name = 'phase5_route_transfers';
--   (purchases.transfer_status / razorpay_transfer_id values written by these functions can be reset to 'pending' / null.)

-- ---------------------------------------------------------------- feature flag (OFF)
insert into private.feature_flags (name, enabled) values ('phase5_route_transfers', false) on conflict (name) do nothing;

create function private.is_route_transfers_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select f.enabled from private.feature_flags f where f.name = 'phase5_route_transfers'), false) is true;
$$;
revoke execute on function private.is_route_transfers_enabled() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- seller_payout_accounts (admin-controlled)
create table public.seller_payout_accounts (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  razorpay_account_id text not null check (razorpay_account_id ~ '^acc_[A-Za-z0-9]{6,40}$'),
  status              text not null check (status in ('pending', 'active', 'suspended')),
  set_by              uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);
comment on table public.seller_payout_accounts is
  'Razorpay Route linked account per seller. Written ONLY by admin_set_seller_payout_account (admin + MFA). '
  'Transfers are created only for status = active.';

-- ---------------------------------------------------------------- transfers (one per purchase)
create table public.transfers (
  id                   uuid primary key default gen_random_uuid(),
  purchase_id          uuid not null unique references public.purchases(id) on delete cascade,
  seller_id            uuid not null references auth.users(id) on delete cascade,
  razorpay_account_id  text not null check (razorpay_account_id ~ '^acc_[A-Za-z0-9]{6,40}$'),
  razorpay_payment_id  text not null check (length(razorpay_payment_id) between 1 and 100),
  razorpay_transfer_id text unique check (razorpay_transfer_id is null or razorpay_transfer_id ~ '^trf_[A-Za-z0-9]{6,40}$'),
  amount_paise         integer not null check (amount_paise > 0),
  platform_fee_paise   integer not null check (platform_fee_paise >= 0),
  amount_reversed_paise integer not null default 0 check (amount_reversed_paise >= 0 and amount_reversed_paise <= amount_paise),
  status               text not null default 'creating'
    check (status in ('creating', 'created', 'pending', 'processed', 'partially_reversed', 'reversed', 'failed')),
  settlement_status    text check (settlement_status is null or settlement_status in ('pending', 'on_hold', 'settled')),
  on_hold              boolean not null default true,
  hold_until           timestamptz,                 -- NULL while on_hold = true means "held indefinitely"
  attempts             integer not null default 0 check (attempts >= 0),
  last_attempt_at      timestamptz,
  next_attempt_at      timestamptz,
  last_event_at        bigint,                      -- unix seconds of the newest event applied (out-of-order guard)
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (razorpay_transfer_id is not null or status in ('creating', 'failed'))
);
create index transfers_seller_idx on public.transfers (seller_id);
create index transfers_status_idx on public.transfers (status);
comment on table public.transfers is
  'Ledger of Route transfers, exactly one per purchase (unique purchase_id) -- the database-level guard against paying a seller twice.';

alter table public.seller_payout_accounts enable row level security;
alter table public.transfers enable row level security;
revoke all on public.seller_payout_accounts from anon, authenticated;
revoke all on public.transfers from anon, authenticated;
grant select on public.seller_payout_accounts to authenticated;
grant select on public.transfers to authenticated;
create policy "Sellers can view their own payout account" on public.seller_payout_accounts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Admins can view payout accounts" on public.seller_payout_accounts
  for select to authenticated using ((select private.is_admin()));
create policy "Sellers can view their own transfers" on public.transfers
  for select to authenticated using ((select auth.uid()) = seller_id);
create policy "Admins can view transfers" on public.transfers
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------- purchases.transfer_status mapping
--   held     = a transfer exists and its settlement is on hold (or it has not been processed yet)
--   released = processed and the hold is lifted (Razorpay will settle it on the linked account's schedule)
--   reversed = fully or partly reversed
--   pending  = no live transfer (none yet, or it failed)
create function private.purchase_transfer_status(p_status text, p_on_hold boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_status in ('reversed', 'partially_reversed') then 'reversed'
    when p_status = 'processed' and not coalesce(p_on_hold, true) then 'released'
    when p_status in ('created', 'pending', 'processed') then 'held'
    else 'pending'
  end;
$$;
revoke execute on function private.purchase_transfer_status(text, boolean) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- admin_set_seller_payout_account
create function public.admin_set_seller_payout_account(p_user_id uuid, p_account_id text, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_user_id is null or p_account_id is null or p_account_id !~ '^acc_[A-Za-z0-9]{6,40}$'
     or p_status is null or p_status not in ('pending', 'active', 'suspended') then
    raise exception using errcode = 'CM071', message = 'invalid_payout_account';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception using errcode = 'CM071', message = 'invalid_payout_account';
  end if;
  insert into public.seller_payout_accounts (user_id, razorpay_account_id, status, set_by)
  values (p_user_id, p_account_id, p_status, (select auth.uid()))
  on conflict (user_id) do update
    set razorpay_account_id = excluded.razorpay_account_id, status = excluded.status,
        set_by = excluded.set_by, updated_at = now();
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'payout_account_set', 'user', p_user_id,
          jsonb_build_object('account_id', p_account_id, 'status', p_status));
end;
$$;

-- ---------------------------------------------------------------- plan_transfer
-- Claims the right to create the transfer for ONE purchase. Returns jsonb:
--   {outcome:'claimed', ...}  the caller may now call Razorpay (lookup_first = true means "a previous attempt may have
--                             reached Razorpay: look up the payment's existing transfers BEFORE creating another")
--   {outcome: disabled | not_found | not_eligible | no_account | exists | backoff | in_progress, ...}
create function public.plan_transfer(p_purchase_id uuid)
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
    -- a previous attempt may have reached Razorpay (timeout, crash): reclaim, but look before creating
    update public.transfers t
       set attempts = t.attempts + 1, last_attempt_at = now(), next_attempt_at = null, updated_at = now()
     where t.id = v_t.id;
    return jsonb_build_object(
      'outcome', 'claimed', 'purchase_id', p_purchase_id, 'payment_id', v_t.razorpay_payment_id,
      'account_id', v_t.razorpay_account_id, 'amount_paise', v_t.amount_paise,
      'on_hold', v_t.on_hold, 'hold_until_epoch', floor(extract(epoch from v_t.hold_until))::bigint,
      'lookup_first', true, 'attempts', v_t.attempts + 1);
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
    'lookup_first', v_lookup, 'attempts', 1);
end;
$$;

-- ---------------------------------------------------------------- apply_transfer_event
-- The ONLY place a transfer's state changes after creation. Idempotent, forward-only, order-tolerant.
-- Used for: the create response, a poll result, and every transfer.* webhook (which finishes its webhook_events row
-- in the same transaction when p_event_id is given).
--
--   p_purchase_id   from the transfer's notes: lets an event that outruns our own "record the id" step adopt the
--                   claimed row. Optional.
--   p_amount_paise / p_recipient   when given, MUST equal the ledger row, else 'inconsistent_event' (nothing written).
--   p_event_at      unix seconds; an event older than the newest already applied is 'stale'.
--
-- outcome: applied | stale | unknown_transfer | conflicting_transfer | inconsistent_event
create function public.apply_transfer_event(
  p_transfer_id        text,
  p_purchase_id        uuid,
  p_status             text,
  p_settlement_status  text,
  p_on_hold            boolean,
  p_amount_reversed    integer,
  p_event_at           bigint,
  p_amount_paise       integer default null,
  p_recipient          text default null,
  p_event_id           text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t        public.transfers%rowtype;
  v_outcome  text;
  v_rank_old integer;
  v_rank_new integer;
  v_status   text;
  v_settle   text;
  v_hold     boolean;
  v_rev      integer;
begin
  if p_transfer_id is null or p_transfer_id !~ '^trf_[A-Za-z0-9]{6,40}$'
     or p_status is null or p_status not in ('created', 'pending', 'processed', 'partially_reversed', 'reversed', 'failed')
     or (p_settlement_status is not null and p_settlement_status not in ('pending', 'on_hold', 'settled'))
     or (p_amount_reversed is not null and p_amount_reversed < 0)
     or (p_event_at is not null and p_event_at <= 0)
     or (p_amount_paise is not null and p_amount_paise <= 0) then
    raise exception using errcode = 'CM071', message = 'invalid_transfer_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('transfer:' || p_transfer_id, 0));

  select * into v_t from public.transfers t where t.razorpay_transfer_id = p_transfer_id;
  if not found and p_purchase_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));
    select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
    if found and v_t.razorpay_transfer_id is not null and v_t.razorpay_transfer_id <> p_transfer_id then
      v_outcome := 'conflicting_transfer';            -- a SECOND Razorpay transfer for one purchase: a human must look
    elsif not found then
      v_outcome := 'unknown_transfer';
    end if;
  elsif not found then
    v_outcome := 'unknown_transfer';
  end if;

  if v_outcome is null then
    if (p_amount_paise is not null and p_amount_paise <> v_t.amount_paise)
       or (p_recipient is not null and p_recipient <> v_t.razorpay_account_id)
       or (coalesce(p_amount_reversed, 0) > v_t.amount_paise) then
      v_outcome := 'inconsistent_event';
    end if;
  end if;

  if v_outcome is null then
    v_rank_old := case v_t.status when 'creating' then 0 when 'created' then 1 when 'pending' then 2 when 'processed' then 3
                                  when 'partially_reversed' then 4 when 'reversed' then 5 when 'failed' then 9 end;
    v_rank_new := case p_status when 'created' then 1 when 'pending' then 2 when 'processed' then 3
                                when 'partially_reversed' then 4 when 'reversed' then 5 when 'failed' then 9 end;
    if v_t.status in ('failed', 'reversed') then
      v_outcome := 'stale';                           -- terminal
    elsif p_event_at is not null and v_t.last_event_at is not null and p_event_at < v_t.last_event_at then
      v_outcome := 'stale';
    elsif p_status = 'failed' and v_t.status in ('processed', 'partially_reversed') then
      v_outcome := 'stale';                           -- a late "failed" can never undo a processed transfer
    elsif p_status <> 'failed' and v_rank_new < v_rank_old then
      v_outcome := 'stale';
    else
      v_status := p_status;
      v_settle := case when v_t.settlement_status = 'settled' then 'settled' else coalesce(p_settlement_status, v_t.settlement_status) end;
      v_hold   := case when v_t.settlement_status = 'settled' then false else coalesce(p_on_hold, v_t.on_hold) end;
      v_rev    := greatest(v_t.amount_reversed_paise, coalesce(p_amount_reversed, 0));
      update public.transfers t
         set razorpay_transfer_id = coalesce(t.razorpay_transfer_id, p_transfer_id),
             status = v_status, settlement_status = v_settle, on_hold = v_hold,
             amount_reversed_paise = v_rev,
             last_event_at = greatest(coalesce(t.last_event_at, 0), coalesce(p_event_at, 0)),
             hold_until = case when v_hold then t.hold_until else null end,
             next_attempt_at = null,
             error = case when v_status = 'failed' then coalesce(t.error, 'razorpay_reported_failed') else null end,
             updated_at = now()
       where t.id = v_t.id;
      update public.purchases pu
         set razorpay_transfer_id = p_transfer_id,
             transfer_status = private.purchase_transfer_status(v_status, v_hold)
       where pu.id = v_t.purchase_id;
      v_outcome := 'applied';
    end if;
  end if;

  if p_event_id is not null then
    update public.webhook_events e
       set status       = case when v_outcome in ('applied', 'stale') then 'processed' else 'needs_review' end,
           outcome      = 'transfer_' || v_outcome,
           processed_at = now(), error = null
     where e.provider = 'razorpay' and e.provider_event_id = p_event_id
       and e.status in ('received', 'failed');
  end if;

  return jsonb_build_object('outcome', v_outcome, 'purchase_id', v_t.purchase_id);
end;
$$;

-- ---------------------------------------------------------------- record_transfer_failure
-- Called when a create attempt did not produce a transfer. Retryable errors back off exponentially
-- (1,2,4,... minutes; the 6-hour cap is a defensive bound, unreachable at 8 attempts) and give up after 8 attempts; non-retryable errors fail at once.
create function public.record_transfer_failure(p_purchase_id uuid, p_error text, p_retryable boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.transfers%rowtype;
begin
  if p_purchase_id is null or p_retryable is null then
    raise exception using errcode = 'CM071', message = 'invalid_transfer_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('transfer_purchase:' || p_purchase_id::text, 0));
  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  if not found or v_t.status <> 'creating' then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if p_retryable and v_t.attempts < 8 then
    update public.transfers t
       set error = left(p_error, 300),
           next_attempt_at = now() + least(power(2, t.attempts - 1) * interval '1 minute', interval '6 hours'),
           updated_at = now()
     where t.id = v_t.id;
    return jsonb_build_object('outcome', 'retry_scheduled');
  end if;
  update public.transfers t
     set status = 'failed', error = left(coalesce(p_error, 'unknown'), 300), next_attempt_at = null, updated_at = now()
   where t.id = v_t.id;
  return jsonb_build_object('outcome', 'failed');
end;
$$;

-- ---------------------------------------------------------------- list_transfer_work
-- What the reconciliation sweep should look at, oldest first, at most p_limit items (1..100).
--   create: a paid purchase of an active seller with no transfer yet, or a 'creating' row due for another attempt
--           (ONLY while the flag is ON)
--   poll:   a transfer that has an id but has not changed for a while (always, flag or not)
create function public.list_transfer_work(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_items jsonb := '[]'::jsonb;
begin
  if private.is_route_transfers_enabled() then
    select coalesce(jsonb_agg(w.item order by w.ts), '[]'::jsonb) into v_items from (
      (select jsonb_build_object('kind', 'create', 'purchase_id', p.id) as item, p.purchased_at as ts
         from public.purchases p
         join public.listings l on l.id = p.listing_id
         join public.seller_payout_accounts a on a.user_id = l.seller_id and a.status = 'active'
        where p.status = 'paid' and p.razorpay_payment_id is not null
          and p.purchased_at > now() - interval '90 days'
          and not exists (select 1 from public.transfers t where t.purchase_id = p.id)
          and (round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100)) > 0
        order by p.purchased_at limit v_limit)
      union all
      (select jsonb_build_object('kind', 'create', 'purchase_id', t.purchase_id), t.created_at
         from public.transfers t
        where t.status = 'creating'
          and ((t.next_attempt_at is not null and t.next_attempt_at <= now())
            or (t.next_attempt_at is null and t.last_attempt_at < now() - interval '2 minutes'))
        order by t.created_at limit v_limit)
    ) w;
  end if;

  return (
    select coalesce(jsonb_agg(x.item), '[]'::jsonb) from (
      select item from (
        select jsonb_array_elements(v_items) as item, 0 as ord
        union all
        (select jsonb_build_object('kind', 'poll', 'purchase_id', t.purchase_id, 'razorpay_transfer_id', t.razorpay_transfer_id), 1
           from public.transfers t
          where t.razorpay_transfer_id is not null
            and ((t.status in ('created', 'pending') and t.updated_at < now() - interval '1 hour')
              or (t.status = 'processed' and coalesce(t.settlement_status, '') <> 'settled' and t.updated_at < now() - interval '6 hours'))
          order by t.updated_at limit v_limit)
      ) u order by ord limit v_limit
    ) x
  );
end;
$$;

-- ---------------------------------------------------------------- prepare_transfer_hold
-- Read-only helper for 5.2c (dispute -> hold / release): returns the Razorpay transfer id when the transfer is still
-- holdable (it has an id and has not settled / failed / been reversed).
create function public.prepare_transfer_hold(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.transfers%rowtype;
begin
  if p_purchase_id is null then
    raise exception using errcode = 'CM071', message = 'invalid_transfer_input';
  end if;
  select * into v_t from public.transfers t where t.purchase_id = p_purchase_id;
  if not found then
    return jsonb_build_object('outcome', 'no_transfer');
  end if;
  if v_t.razorpay_transfer_id is null or v_t.status in ('creating', 'failed', 'reversed')
     or v_t.settlement_status = 'settled' then
    return jsonb_build_object('outcome', 'not_holdable', 'status', v_t.status);
  end if;
  return jsonb_build_object('outcome', 'ok', 'razorpay_transfer_id', v_t.razorpay_transfer_id, 'on_hold', v_t.on_hold);
end;
$$;

-- ---------------------------------------------------------------- grants
-- service_role only, except the admin RPC (authenticated; it checks admin + MFA itself, first statement).
revoke all on function public.plan_transfer(uuid) from public, anon, authenticated;
revoke all on function public.apply_transfer_event(text, uuid, text, text, boolean, integer, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_transfer_failure(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.list_transfer_work(integer) from public, anon, authenticated;
revoke all on function public.prepare_transfer_hold(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_seller_payout_account(uuid, text, text) from public, anon, authenticated;
grant execute on function public.plan_transfer(uuid) to service_role;
grant execute on function public.apply_transfer_event(text, uuid, text, text, boolean, integer, bigint, integer, text, text) to service_role;
grant execute on function public.record_transfer_failure(uuid, text, boolean) to service_role;
grant execute on function public.list_transfer_work(integer) to service_role;
grant execute on function public.prepare_transfer_hold(uuid) to service_role;
grant execute on function public.admin_set_seller_payout_account(uuid, text, text) to authenticated;
