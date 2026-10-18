-- Milestone 5.4: direct UPI (VPA) payouts through Razorpay Payouts (RazorpayX), instant, no hold.
--
-- Built IN PARALLEL to Route (5.2/5.2c): nothing of Route is dropped. Route stays dormant (its flags remain OFF). The two payout
-- mechanisms are MUTUALLY EXCLUSIVE at flag level: private.is_route_transfers_enabled() and private.is_vpa_payouts_enabled() each
-- return false while the other flag is on, so enabling both pays nobody twice -- it pays nobody (fail closed).
--
-- What is new
--   * flag phase6_vpa_payouts (seeded OFF) + private.vpa_payout_config (single row: cutoff_at default 'infinity' = no purchase is
--     eligible until you set it; max_payout_paise default 500000 = Rs 5,000 per payout, a damage limiter for an irreversible UPI send)
--   * public.seller_payout_accounts: + vpa_address, razorpay_contact_id, razorpay_fund_account_id; razorpay_account_id becomes OPTIONAL
--     (a row needs a UPI ID or a Route account id). Column-level SELECT for sellers: they can read their own UPI ID and status, never
--     the Razorpay contact / fund-account / linked-account ids.
--   * public.vpa_payouts: ONE ledger row per purchase (unique purchase_id) = the database-level guard against paying a seller twice
--   * seller RPC: set_my_payout_vpa(text) -- the only way a seller writes their own UPI ID (format-checked, rate-limited, audited)
--   * service_role RPCs: plan_vpa_payout, record_vpa_fund_account, apply_vpa_payout_event, record_vpa_payout_failure, list_vpa_payout_work
--   * admin RPCs (admin + MFA first statement): admin_retry_vpa_payout, admin_set_seller_payout_status, admin_vpa_payouts_ledger
--   * REPLACED (same signatures/grants): private.payment_attention_rows, public.admin_seller_balances, public.seller_payout_status
--     (they now also understand UPI payouts), and the two flag helpers described above.
--
-- Payout key: razorpay's X-Payout-Idempotency header = the purchase id (plus "-vN" after an admin retry); reference_id = the same key (a Razorpay reference_id is <= 40 chars; a uuid plus "-vN" fits).
-- Amount: seller share = round(amount*100) - round(platform_fee*100), integer paise. No 48-hour hold, no dispute hold: a purchase is
-- eligible the moment it is paid (and on/after cutoff_at). Disputes become support tickets; nothing here reacts to them.
--
-- Error code: CM075 (invalid UPI payout input). Every earlier code is untouched.
--
-- Rollback (nothing outside these objects depends on them until the 5.4 app code is deployed):
--   restore the replaced functions from 20261013100000 (is_route_transfers_enabled), 20261015100000 (payment_attention_rows,
--   admin_seller_balances) and 20261016100000 (seller_payout_status); drop the new functions listed above; drop table public.vpa_payouts;
--   drop table private.vpa_payout_config; drop function private.is_vpa_payouts_enabled(), private.mask_vpa(text);
--   revoke the column grant and re-grant select on public.seller_payout_accounts to authenticated;
--   alter table public.seller_payout_accounts drop constraint seller_payout_destination_chk, drop column vpa_address,
--     drop column razorpay_contact_id, drop column razorpay_fund_account_id;  (and only if no row lacks razorpay_account_id:
--     alter column razorpay_account_id set not null);  delete from private.feature_flags where name = 'phase6_vpa_payouts';

insert into private.feature_flags (name, enabled) values ('phase6_vpa_payouts', false) on conflict (name) do nothing;

-- flag helpers: mutually exclusive, fail closed
create or replace function private.is_route_transfers_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((select f.enabled from private.feature_flags f where f.name = 'phase5_route_transfers'), false) is true
     and coalesce((select f.enabled from private.feature_flags f where f.name = 'phase6_vpa_payouts'), false) is not true;
$$;
create function private.is_vpa_payouts_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((select f.enabled from private.feature_flags f where f.name = 'phase6_vpa_payouts'), false) is true
     and coalesce((select f.enabled from private.feature_flags f where f.name = 'phase5_route_transfers'), false) is not true;
$$;
revoke execute on function private.is_vpa_payouts_enabled() from public, anon, authenticated, service_role;

create function private.mask_vpa(p_vpa text)
returns text language sql immutable set search_path = ''
as $$
  select case when p_vpa is null then null
              else left(split_part(p_vpa, '@', 1), 2) || '***@' || split_part(p_vpa, '@', 2) end;
$$;
revoke execute on function private.mask_vpa(text) from public, anon, authenticated, service_role;

create table private.vpa_payout_config (
  id               boolean primary key default true check (id),
  cutoff_at        timestamptz not null default 'infinity',
  max_payout_paise integer not null default 500000 check (max_payout_paise > 0),
  updated_at       timestamptz not null default now()
);
insert into private.vpa_payout_config (id) values (true) on conflict (id) do nothing;
comment on table private.vpa_payout_config is
  'cutoff_at: only purchases made at/after this instant are ever paid out (default infinity = none). Set it to now() when you switch payouts on, so old sales are not paid retroactively. max_payout_paise: a larger payout is parked for review instead of sent.';

-- ---------------------------------------------------------------- seller_payout_accounts: UPI columns
alter table public.seller_payout_accounts
  add column vpa_address               text check (vpa_address is null or (length(vpa_address) <= 100 and vpa_address ~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$')),
  add column razorpay_contact_id       text check (razorpay_contact_id is null or razorpay_contact_id ~ '^cont_[A-Za-z0-9]{6,40}$'),
  add column razorpay_fund_account_id  text check (razorpay_fund_account_id is null or razorpay_fund_account_id ~ '^fa_[A-Za-z0-9]{6,40}$');
alter table public.seller_payout_accounts alter column razorpay_account_id drop not null;
alter table public.seller_payout_accounts
  add constraint seller_payout_destination_chk check (razorpay_account_id is not null or vpa_address is not null);
-- sellers (and admins through RLS) read only the harmless columns directly; Razorpay ids stay server-side
revoke select on public.seller_payout_accounts from authenticated;
grant select (user_id, vpa_address, status, updated_at) on public.seller_payout_accounts to authenticated;

-- ---------------------------------------------------------------- vpa_payouts (one per purchase)
create table public.vpa_payouts (
  id                 uuid primary key default gen_random_uuid(),
  purchase_id        uuid not null unique references public.purchases(id) on delete cascade,
  seller_id          uuid not null references auth.users(id) on delete cascade,
  vpa_address        text not null check (vpa_address ~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$'),
  razorpay_payout_id text unique check (razorpay_payout_id is null or razorpay_payout_id ~ '^pout_[A-Za-z0-9]{6,40}$'),
  amount_paise       integer not null check (amount_paise > 0),
  platform_fee_paise integer not null check (platform_fee_paise >= 0),
  status             text not null default 'creating' check (status in ('creating', 'queued', 'processing', 'processed', 'failed', 'reversed', 'cancelled')),
  key_version        integer not null default 1 check (key_version >= 1),
  utr                text check (utr is null or length(utr) <= 60),
  attempts           integer not null default 0 check (attempts >= 0),
  last_attempt_at    timestamptz,
  next_attempt_at    timestamptz,
  last_event_at      bigint,
  error              text,
  review_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (razorpay_payout_id is not null or status in ('creating', 'failed', 'cancelled'))
);
create index vpa_payouts_seller_idx on public.vpa_payouts (seller_id);
create index vpa_payouts_status_idx on public.vpa_payouts (status);
comment on table public.vpa_payouts is
  'Ledger of instant UPI payouts, exactly one per purchase (unique purchase_id) -- the database-level guard against paying a seller twice. Written only by the SECURITY DEFINER functions of migration 5.4.';
alter table public.vpa_payouts enable row level security;
revoke all on public.vpa_payouts from anon, authenticated;
-- sellers may read only their own rows and only the harmless columns; admins read through the admin_* functions (which return what the desk needs)
grant select (id, purchase_id, seller_id, status, amount_paise, created_at, updated_at) on public.vpa_payouts to authenticated;
create policy "Sellers can view their own UPI payouts" on public.vpa_payouts
  for select to authenticated using ((select auth.uid()) = seller_id);

-- ---------------------------------------------------------------- set_my_payout_vpa  (the seller's own UPI ID)
create function public.set_my_payout_vpa(p_vpa text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_vpa  text := lower(btrim(p_vpa));
  v_old  text;
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
        set_by = v_uid, updated_at = now();

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'payout_vpa_set', 'user', v_uid, jsonb_build_object('vpa', private.mask_vpa(v_vpa)));
  return jsonb_build_object('outcome', case when v_old is null then 'saved' else 'changed' end);
end;
$$;

-- ---------------------------------------------------------------- plan_vpa_payout (claim)
-- {outcome:'claimed', ...}  the caller may now call Razorpay (lookup_first = a previous attempt may have reached it: RE-SEND with the SAME key)
-- {outcome: disabled | not_found | not_eligible | before_cutoff | no_account | route_transfer_exists | over_cap | exists | backoff | in_progress | parked}
create function public.plan_vpa_payout(p_purchase_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p      public.purchases%rowtype;
  v_seller uuid;
  v_acct   public.seller_payout_accounts%rowtype;
  v_v      public.vpa_payouts%rowtype;
  v_cfg    private.vpa_payout_config%rowtype;
  v_amount integer;
  v_fee    integer;
  v_name   text;
begin
  if p_purchase_id is null then
    raise exception using errcode = 'CM075', message = 'invalid_payout_input';
  end if;
  if not private.is_vpa_payouts_enabled() then
    return jsonb_build_object('outcome', 'disabled');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vpa_payout:' || p_purchase_id::text, 0));
  select * into v_cfg from private.vpa_payout_config where id;

  select * into v_v from public.vpa_payouts x where x.purchase_id = p_purchase_id;
  if found then
    if v_v.status <> 'creating' then
      return jsonb_build_object('outcome', 'exists', 'status', v_v.status, 'razorpay_payout_id', v_v.razorpay_payout_id);
    end if;
    if v_v.next_attempt_at is not null and v_v.next_attempt_at > now() then
      return jsonb_build_object('outcome', 'backoff', 'next_attempt_at', v_v.next_attempt_at);
    end if;
    if v_v.next_attempt_at is null and v_v.last_attempt_at > now() - interval '2 minutes' then
      return jsonb_build_object('outcome', 'in_progress');
    end if;
    select * into v_acct from public.seller_payout_accounts a where a.user_id = v_v.seller_id;
    if not found or v_acct.vpa_address is distinct from v_v.vpa_address or v_acct.status <> 'active' then
      -- the seller changed their UPI ID (or was suspended) after the first attempt, which may already have reached Razorpay: a human decides
      update public.vpa_payouts x
         set status = 'failed', review_reason = 'upi_id_changed_or_account_inactive_after_claim', next_attempt_at = null, updated_at = now()
       where x.id = v_v.id;
      return jsonb_build_object('outcome', 'parked');
    end if;
    update public.vpa_payouts x
       set attempts = x.attempts + 1, last_attempt_at = now(), next_attempt_at = null, updated_at = now()
     where x.id = v_v.id;
    select pr.display_name into v_name from public.profiles pr where pr.id = v_v.seller_id;
    return jsonb_build_object(
      'outcome', 'claimed', 'purchase_id', p_purchase_id, 'seller_id', v_v.seller_id, 'seller_name', coalesce(v_name, 'Seller'),
      'vpa', v_v.vpa_address, 'amount_paise', v_v.amount_paise,
      'payout_key', case when v_v.key_version > 1 then p_purchase_id::text || '-v' || v_v.key_version else p_purchase_id::text end,
      'contact_id', v_acct.razorpay_contact_id, 'fund_account_id', v_acct.razorpay_fund_account_id,
      'lookup_first', true, 'attempts', v_v.attempts + 1);
  end if;

  select * into v_p from public.purchases p where p.id = p_purchase_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_p.status <> 'paid' or v_p.razorpay_payment_id is null then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'purchase_not_paid');
  end if;
  if v_p.purchased_at < v_cfg.cutoff_at then
    return jsonb_build_object('outcome', 'before_cutoff');
  end if;
  if exists (select 1 from public.transfers t where t.purchase_id = p_purchase_id) then
    return jsonb_build_object('outcome', 'route_transfer_exists');
  end if;

  select l.seller_id into v_seller from public.listings l where l.id = v_p.listing_id;
  if v_seller is null then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'no_seller');
  end if;
  select * into v_acct from public.seller_payout_accounts a where a.user_id = v_seller;
  if not found or v_acct.status <> 'active' or v_acct.vpa_address is null then
    return jsonb_build_object('outcome', 'no_account');
  end if;

  v_amount := round(v_p.amount * 100)::integer;
  v_fee    := round(coalesce(v_p.platform_fee, 0) * 100)::integer;
  if v_fee < 0 or v_fee >= v_amount then
    return jsonb_build_object('outcome', 'not_eligible', 'reason', 'no_seller_share');
  end if;

  if v_amount - v_fee > v_cfg.max_payout_paise then
    insert into public.vpa_payouts (purchase_id, seller_id, vpa_address, amount_paise, platform_fee_paise, status, review_reason)
    values (p_purchase_id, v_seller, v_acct.vpa_address, v_amount - v_fee, v_fee, 'failed', 'over_max_payout_amount');
    return jsonb_build_object('outcome', 'over_cap');
  end if;

  insert into public.vpa_payouts (purchase_id, seller_id, vpa_address, amount_paise, platform_fee_paise, attempts, last_attempt_at)
  values (p_purchase_id, v_seller, v_acct.vpa_address, v_amount - v_fee, v_fee, 1, now());
  select pr.display_name into v_name from public.profiles pr where pr.id = v_seller;

  return jsonb_build_object(
    'outcome', 'claimed', 'purchase_id', p_purchase_id, 'seller_id', v_seller, 'seller_name', coalesce(v_name, 'Seller'),
    'vpa', v_acct.vpa_address, 'amount_paise', v_amount - v_fee, 'payout_key', p_purchase_id::text,
    'contact_id', v_acct.razorpay_contact_id, 'fund_account_id', v_acct.razorpay_fund_account_id,
    'lookup_first', false, 'attempts', 1);
end;
$$;

-- ---------------------------------------------------------------- record_vpa_fund_account
-- Remembers the Razorpay contact + fund account created for a seller's CURRENT UPI ID. Refuses if the UPI ID changed meanwhile.
create function public.record_vpa_fund_account(p_seller_id uuid, p_vpa text, p_contact_id text, p_fund_account_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_seller_id is null or p_vpa is null or p_contact_id is null or p_contact_id !~ '^cont_[A-Za-z0-9]{6,40}$'
     or p_fund_account_id is null or p_fund_account_id !~ '^fa_[A-Za-z0-9]{6,40}$' then
    raise exception using errcode = 'CM075', message = 'invalid_fund_account';
  end if;
  update public.seller_payout_accounts a
     set razorpay_contact_id = p_contact_id, razorpay_fund_account_id = p_fund_account_id, updated_at = now()
   where a.user_id = p_seller_id and a.vpa_address = p_vpa;
  if not found then
    return jsonb_build_object('outcome', 'vpa_changed');
  end if;
  return jsonb_build_object('outcome', 'ok');
end;
$$;

-- ---------------------------------------------------------------- apply_vpa_payout_event (the ONLY place a payout's state changes after creation)
-- Idempotent, forward-only, order-tolerant. creating < queued < processing < processed < reversed ; failed / cancelled are terminal.
-- A late 'failed' can never undo 'processed'. p_amount_paise, when given, MUST equal the ledger row.
create function public.apply_vpa_payout_event(
  p_payout_id   text,
  p_purchase_id uuid,
  p_status      text,
  p_utr         text default null,
  p_event_at    bigint default null,
  p_amount_paise integer default null,
  p_reason      text default null,
  p_event_id    text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_v        public.vpa_payouts%rowtype;
  v_outcome  text;
  v_rank_old integer;
  v_rank_new integer;
begin
  if p_payout_id is null or p_payout_id !~ '^pout_[A-Za-z0-9]{6,40}$'
     or p_status is null or p_status not in ('queued', 'processing', 'processed', 'failed', 'reversed', 'cancelled')
     or (p_event_at is not null and p_event_at <= 0)
     or (p_amount_paise is not null and p_amount_paise <= 0) then
    raise exception using errcode = 'CM075', message = 'invalid_payout_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('vpa_payout_id:' || p_payout_id, 0));
  select * into v_v from public.vpa_payouts x where x.razorpay_payout_id = p_payout_id;
  if not found and p_purchase_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('vpa_payout:' || p_purchase_id::text, 0));
    select * into v_v from public.vpa_payouts x where x.purchase_id = p_purchase_id;
    if found and v_v.razorpay_payout_id is not null and v_v.razorpay_payout_id <> p_payout_id then
      v_outcome := 'conflicting_payout';                  -- a SECOND Razorpay payout for one purchase: a human must look
    elsif not found then
      v_outcome := 'unknown_payout';
    end if;
  elsif not found then
    v_outcome := 'unknown_payout';
  end if;

  if v_outcome is null and p_amount_paise is not null and p_amount_paise <> v_v.amount_paise then
    v_outcome := 'inconsistent_event';
  end if;

  if v_outcome is null then
    v_rank_old := case v_v.status when 'creating' then 0 when 'queued' then 1 when 'processing' then 2 when 'processed' then 3 when 'reversed' then 4 else 9 end;
    v_rank_new := case p_status when 'queued' then 1 when 'processing' then 2 when 'processed' then 3 when 'reversed' then 4 else 9 end;
    if v_v.status in ('failed', 'cancelled', 'reversed') then
      v_outcome := 'stale';                                -- terminal
    elsif p_event_at is not null and v_v.last_event_at is not null and p_event_at < v_v.last_event_at then
      v_outcome := 'stale';
    elsif p_status in ('failed', 'cancelled') and v_v.status = 'processed' then
      v_outcome := 'stale';                                -- a late "failed" can never undo a processed payout
    elsif p_status not in ('failed', 'cancelled') and v_rank_new < v_rank_old then
      v_outcome := 'stale';
    else
      update public.vpa_payouts x
         set razorpay_payout_id = coalesce(x.razorpay_payout_id, p_payout_id),
             status = p_status,
             utr = coalesce(left(p_utr, 60), x.utr),
             last_event_at = greatest(coalesce(x.last_event_at, 0), coalesce(p_event_at, 0)),
             next_attempt_at = null,
             error = case when p_status in ('failed', 'cancelled', 'reversed') then left(coalesce(p_reason, x.error, 'razorpay_reported_' || p_status), 300) else null end,
             updated_at = now()
       where x.id = v_v.id;
      v_outcome := 'applied';
    end if;
  end if;

  if p_event_id is not null then
    update public.webhook_events e
       set status       = case when v_outcome in ('applied', 'stale') then 'processed' else 'needs_review' end,
           outcome      = 'payout_' || v_outcome,
           processed_at = now(), error = null
     where e.provider = 'razorpay' and e.provider_event_id = p_event_id
       and e.status in ('received', 'failed');
  end if;

  return jsonb_build_object('outcome', v_outcome, 'purchase_id', v_v.purchase_id);
end;
$$;

-- ---------------------------------------------------------------- record_vpa_payout_failure
create function public.record_vpa_payout_failure(p_purchase_id uuid, p_error text, p_retryable boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_v public.vpa_payouts%rowtype;
begin
  if p_purchase_id is null or p_retryable is null then
    raise exception using errcode = 'CM075', message = 'invalid_payout_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('vpa_payout:' || p_purchase_id::text, 0));
  select * into v_v from public.vpa_payouts x where x.purchase_id = p_purchase_id;
  if not found or v_v.status <> 'creating' then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if p_retryable and v_v.attempts < 8 then
    update public.vpa_payouts x
       set error = left(p_error, 300),
           next_attempt_at = now() + least(power(2, x.attempts - 1) * interval '1 minute', interval '6 hours'),
           updated_at = now()
     where x.id = v_v.id;
    return jsonb_build_object('outcome', 'retry_scheduled');
  end if;
  update public.vpa_payouts x
     set status = 'failed', error = left(coalesce(p_error, 'unknown'), 300), next_attempt_at = null, updated_at = now()
   where x.id = v_v.id;
  return jsonb_build_object('outcome', 'failed');
end;
$$;

-- ---------------------------------------------------------------- list_vpa_payout_work
--   create: a paid purchase (on/after cutoff, <90 days old) of a seller with an active UPI ID and no payout / no Route transfer yet, or a
--           'creating' row due for another attempt   (ONLY while the flag is ON)
--   poll:   a payout with an id still queued/processing and quiet for a while (always, flag or not)
create function public.list_vpa_payout_work(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit  integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_items  jsonb := '[]'::jsonb;
  v_cutoff timestamptz := (select c.cutoff_at from private.vpa_payout_config c where c.id);
begin
  if private.is_vpa_payouts_enabled() then
    select coalesce(jsonb_agg(w.item order by w.ts), '[]'::jsonb) into v_items from (
      (select jsonb_build_object('kind', 'create', 'purchase_id', p.id) as item, p.purchased_at as ts
         from public.purchases p
         join public.listings l on l.id = p.listing_id
         join public.seller_payout_accounts a on a.user_id = l.seller_id and a.status = 'active' and a.vpa_address is not null
        where p.status = 'paid' and p.razorpay_payment_id is not null
          and p.purchased_at >= v_cutoff and p.purchased_at > now() - interval '90 days'
          and not exists (select 1 from public.vpa_payouts v where v.purchase_id = p.id)
          and not exists (select 1 from public.transfers t where t.purchase_id = p.id)
          and (round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100)) > 0
        order by p.purchased_at limit v_limit)
      union all
      (select jsonb_build_object('kind', 'create', 'purchase_id', v.purchase_id), v.created_at
         from public.vpa_payouts v
        where v.status = 'creating'
          and ((v.next_attempt_at is not null and v.next_attempt_at <= now())
            or (v.next_attempt_at is null and v.last_attempt_at < now() - interval '2 minutes'))
        order by v.created_at limit v_limit)
    ) w;
  end if;

  return (
    select coalesce(jsonb_agg(x.item), '[]'::jsonb) from (
      select item from (
        select jsonb_array_elements(v_items) as item, 0 as ord
        union all
        (select jsonb_build_object('kind', 'poll', 'purchase_id', v.purchase_id, 'razorpay_payout_id', v.razorpay_payout_id), 1
           from public.vpa_payouts v
          where v.razorpay_payout_id is not null
            and ((v.status = 'processing' and v.updated_at < now() - interval '15 minutes')
              or (v.status = 'queued'     and v.updated_at < now() - interval '30 minutes'))
          order by v.updated_at limit v_limit)
      ) u order by ord limit v_limit
    ) x
  );
end;
$$;

-- ---------------------------------------------------------------- admin: retry, suspend, ledger
-- Re-queues a payout that FAILED / was CANCELLED / was REVERSED by the bank, under a NEW idempotency key (a new Razorpay payout).
-- Only call it after you have checked in the RazorpayX dashboard that the money did not leave.
create function public.admin_retry_vpa_payout(p_purchase_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_v public.vpa_payouts%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_purchase_id is null then
    raise exception using errcode = 'CM075', message = 'invalid_payout_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('vpa_payout:' || p_purchase_id::text, 0));
  select * into v_v from public.vpa_payouts x where x.purchase_id = p_purchase_id;
  if not found or v_v.status not in ('failed', 'cancelled', 'reversed') then
    raise exception using errcode = 'CM075', message = 'nothing_to_retry';
  end if;
  update public.vpa_payouts x
     set status = 'creating', razorpay_payout_id = null, key_version = x.key_version + 1,
         vpa_address = coalesce((select a.vpa_address from public.seller_payout_accounts a where a.user_id = x.seller_id and a.status = 'active'), x.vpa_address),
         attempts = 0, next_attempt_at = null, last_attempt_at = null, last_event_at = null,
         error = null, review_reason = null, utr = null, updated_at = now()
   where x.id = v_v.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'vpa_payout_retried', 'purchase', p_purchase_id,
          jsonb_build_object('previous_status', v_v.status, 'previous_payout_id', v_v.razorpay_payout_id, 'key_version', v_v.key_version + 1));
end;
$$;

create function public.admin_set_seller_payout_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_user_id is null or p_status is null or p_status not in ('pending', 'active', 'suspended') then
    raise exception using errcode = 'CM075', message = 'invalid_payout_input';
  end if;
  update public.seller_payout_accounts a set status = p_status, set_by = (select auth.uid()), updated_at = now() where a.user_id = p_user_id;
  if not found then
    raise exception using errcode = 'CM075', message = 'no_such_payout_account';
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'payout_account_status_set', 'user', p_user_id, jsonb_build_object('status', p_status));
end;
$$;

-- p_status: null (all) | creating | queued | processing | processed | failed | reversed | cancelled
create function public.admin_vpa_payouts_ledger(p_status text default null, p_limit integer default 100, p_offset integer default 0)
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
     or (p_status is not null and p_status not in ('creating', 'queued', 'processing', 'processed', 'failed', 'reversed', 'cancelled')) then
    raise exception using errcode = 'CM075', message = 'invalid_payout_input';
  end if;
  select count(*)::integer into v_total from public.vpa_payouts v where p_status is null or v.status = p_status;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_items
    from (
      select v.created_at, v.id,
             jsonb_build_object(
               'purchase_id', v.purchase_id, 'status', v.status, 'amount_paise', v.amount_paise, 'platform_fee_paise', v.platform_fee_paise,
               'vpa_address', v.vpa_address, 'razorpay_payout_id', v.razorpay_payout_id, 'utr', v.utr, 'attempts', v.attempts,
               'error', left(v.error, 300), 'review_reason', v.review_reason, 'key_version', v.key_version,
               'seller_id', v.seller_id, 'seller_name', sp.display_name, 'created_at', v.created_at, 'updated_at', v.updated_at) as j
        from public.vpa_payouts v
        left join public.profiles sp on sp.id = v.seller_id
       where p_status is null or v.status = p_status
       order by v.created_at desc, v.id
       limit p_limit offset p_offset
    ) x;
  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;

-- ---------------------------------------------------------------- REPLACED reporting functions (same signatures and grants)
create or replace function private.payment_attention_rows()
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
      or (w.status = 'failed' and w.received_at < now() - interval '1 hour' and w.received_at > now() - interval '30 days')
  union all
  -- UPI payouts (5.4): failed / parked, returned by the bank, stuck creating, queued (low RazorpayX balance) or processing too long
  select case when v.status = 'failed' and v.review_reason is not null then 'payout_parked'
              when v.status = 'failed' then 'payout_failed'
              when v.status in ('reversed', 'cancelled') then 'payout_returned'
              when v.status = 'creating' then 'payout_stuck'
              when v.status = 'queued' then 'payout_queued'
              else 'payout_slow' end,
         v.purchase_id, v.updated_at,
         coalesce(v.review_reason, v.error,
                  case v.status when 'creating' then 'creating for over 15 minutes'
                                when 'queued' then 'queued for over an hour (check the RazorpayX balance)'
                                else 'processing for over a day' end),
         v.seller_id, p.user_id, v.amount_paise::bigint, null::uuid
    from public.vpa_payouts v
    join public.purchases p on p.id = v.purchase_id
   where v.status in ('failed', 'reversed', 'cancelled')
      or (v.status = 'creating'   and v.updated_at < now() - interval '15 minutes')
      or (v.status = 'queued'     and v.updated_at < now() - interval '1 hour')
      or (v.status = 'processing' and v.updated_at < now() - interval '1 day');
$$;

create or replace function public.admin_seller_balances(p_limit integer default 200)
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
       and not exists (select 1 from public.vpa_payouts vp where vp.purchase_id = p.id)
     group by l.seller_id
  ),
  upi as (
    select vp.seller_id,
           coalesce(sum(vp.amount_paise) filter (where vp.status = 'processed'), 0)::bigint as paid,
           coalesce(sum(vp.amount_paise) filter (where vp.status in ('creating', 'queued', 'processing')), 0)::bigint as in_progress,
           coalesce(sum(vp.amount_paise) filter (where vp.status in ('failed', 'cancelled', 'reversed')), 0)::bigint as attention
      from public.vpa_payouts vp group by vp.seller_id
  ),
  sellers as (
    select seller_id from agg
    union select seller_id from upi
    union select seller_id from waiting
    union select user_id from public.seller_payout_accounts
  )
  select (select count(*)::integer from sellers),
         coalesce(jsonb_agg(z.j order by z.o1 desc, z.o2 desc, z.o3, z.o4), '[]'::jsonb)
    into v_total, v_items
    from (
      select (coalesce(g.needs_attention, 0) + coalesce(u.attention, 0)) as o1, coalesce(w.awaiting, 0) as o2, pr.display_name as o3, s.seller_id as o4,
             jsonb_build_object(
               'seller_id', s.seller_id, 'seller_name', pr.display_name,
               'account_status', a.status, 'razorpay_account_id', a.razorpay_account_id,
               'held_paise', coalesce(g.held, 0), 'releasing_paise', coalesce(g.releasing, 0), 'settled_paise', coalesce(g.settled, 0),
               'reversed_paise', coalesce(g.reversed, 0), 'attention_paise', coalesce(g.needs_attention, 0),
               'attention_count', coalesce(g.attention_count, 0),
               'awaiting_transfer_paise', coalesce(w.awaiting, 0), 'awaiting_transfer_count', coalesce(w.awaiting_count, 0),
               'vpa_address', a.vpa_address, 'upi_paid_paise', coalesce(u.paid, 0), 'upi_in_progress_paise', coalesce(u.in_progress, 0),
               'upi_attention_paise', coalesce(u.attention, 0)) as j
        from sellers s
        left join agg g on g.seller_id = s.seller_id
        left join waiting w on w.seller_id = s.seller_id
        left join upi u on u.seller_id = s.seller_id
        left join public.seller_payout_accounts a on a.user_id = s.seller_id
        left join public.profiles pr on pr.id = s.seller_id
       order by 1 desc, 2 desc, 3, 4
       limit p_limit
    ) z;

  return jsonb_build_object('total', v_total, 'items', v_items);
end;
$$;


create or replace function public.seller_payout_status(p_limit integer default 100)
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
  v_acc     text;
  v_mode    boolean := private.is_vpa_payouts_enabled();
  v_items   jsonb;
  v_summary jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'CM074', message = 'invalid_payout_status_input';
  end if;

  select a.status, a.vpa_address, a.razorpay_account_id into v_account, v_vpa, v_acc
    from public.seller_payout_accounts a where a.user_id = v_uid;
  -- a destination must exist: a UPI ID, or (Route mode only) a linked account. While UPI payouts are on, only a UPI ID counts.
  if v_vpa is null and (v_mode or v_acc is null) then v_account := null; end if;

  with s as (
    select p.id as purchase_id, p.purchased_at, l.title as listing_title,
           greatest(round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100), 0)::bigint as share,
           p.status as pstatus,
           t.id as tid, t.status as tstatus, t.settlement_status, t.on_hold, t.hold_until, t.review_reason, t.amount_reversed_paise,
           d.status as dstatus,
           vp.id as vid, vp.status as vstatus, vp.review_reason as vreview
      from public.purchases p
      join public.listings l on l.id = p.listing_id
      left join public.transfers t on t.purchase_id = p.id
      left join public.disputes d on d.purchase_id = p.id
      left join public.vpa_payouts vp on vp.purchase_id = p.id
     where l.seller_id = v_uid
       and p.razorpay_payment_id is not null
  ),
  c as (
    select s.*,
      case
        -- UPI payouts (5.4). "All sales are final": once the money has gone out, nothing that happens later (a dispute ticket, a refund
        -- to the buyer) changes what the seller sees, and nothing here is ever a debt or a negative amount.
        when s.vstatus = 'processed'                                                           then 'instant_paid'
        when s.vid is not null and s.vreview is not null                                       then 'under_review'
        when s.vid is not null and s.vstatus in ('failed', 'cancelled', 'reversed')            then 'action_needed'
        when s.vid is not null                                                                 then 'instant_in_progress'
        when v_mode and s.tid is null and s.pstatus = 'refunded'                               then 'reversed'
        when v_mode and s.tid is null and v_account is null                                    then 'action_needed'
        when v_mode and s.tid is null and v_account in ('pending', 'suspended')                then 'under_review'
        when v_mode and s.tid is null                                                          then 'instant_in_progress'
        -- legacy Route sales (unchanged from 5.3b)
        when s.pstatus = 'refunded' or s.tstatus = 'reversed'                                  then 'reversed'
        when s.dstatus = 'open'                                                                then 'dispute'
        when s.tid is null and v_account is null                                               then 'needs_account'
        when s.tid is null and v_account = 'pending'                                           then 'account_pending'
        when s.tid is null and v_account = 'suspended'                                         then 'under_review'
        when s.tid is null                                                                     then 'queued'
        when s.review_reason is not null                                                       then 'under_review'
        when s.tstatus in ('creating', 'failed')                                               then 'processing'
        when s.settlement_status = 'settled'                                                   then 'paid'
        when s.on_hold and s.hold_until is not null and s.hold_until > now()                   then 'held'
        when s.on_hold and s.hold_until is null                                                then 'processing'
        else 'releasing'
      end as code
    from s
  )
  select
    coalesce((select jsonb_agg(x.j order by x.purchased_at desc, x.purchase_id)
                from (
                  select c.purchased_at, c.purchase_id,
                         jsonb_build_object(
                           'purchase_id', c.purchase_id, 'listing_title', c.listing_title, 'purchased_at', c.purchased_at,
                           'status', c.code, 'share_paise', c.share,
                           'reversed_paise', case when c.code = 'reversed' then c.share else coalesce(c.amount_reversed_paise, 0) end,
                           'release_date', case when c.code = 'held' then c.hold_until else null end) as j
                    from c
                   order by c.purchased_at desc, c.purchase_id
                   limit p_limit
                ) x), '[]'::jsonb),
    (select jsonb_build_object(
        'held_paise',      coalesce(sum(c.share) filter (where c.code in ('held', 'dispute')), 0),
        'releasing_paise', coalesce(sum(c.share) filter (where c.code in ('releasing', 'processing', 'queued')), 0),
        'paid_paise',      coalesce(sum(c.share - coalesce(c.amount_reversed_paise, 0)) filter (where c.code in ('paid', 'instant_paid')), 0),
        'reversed_paise',  coalesce(sum(c.share) filter (where c.code = 'reversed'), 0),
        'waiting_paise',   coalesce(sum(c.share) filter (where c.code in ('needs_account', 'account_pending', 'under_review')), 0),
        'in_progress_paise',   coalesce(sum(c.share) filter (where c.code = 'instant_in_progress'), 0),
        'action_needed_paise', coalesce(sum(c.share) filter (where c.code = 'action_needed'), 0))
       from c)
    into v_items, v_summary;

  return jsonb_build_object('account_status', coalesce(v_account, 'none'), 'upi_masked', private.mask_vpa(v_vpa), 'summary', v_summary, 'items', v_items);
end;
$$;


-- ---------------------------------------------------------------- grants
revoke all on function public.set_my_payout_vpa(text) from public, anon, authenticated;
revoke all on function public.plan_vpa_payout(uuid) from public, anon, authenticated;
revoke all on function public.record_vpa_fund_account(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_vpa_payout_event(text, uuid, text, text, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.record_vpa_payout_failure(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.list_vpa_payout_work(integer) from public, anon, authenticated;
revoke all on function public.admin_retry_vpa_payout(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_seller_payout_status(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_vpa_payouts_ledger(text, integer, integer) from public, anon, authenticated;
grant execute on function public.set_my_payout_vpa(text) to authenticated;
grant execute on function public.plan_vpa_payout(uuid) to service_role;
grant execute on function public.record_vpa_fund_account(uuid, text, text, text) to service_role;
grant execute on function public.apply_vpa_payout_event(text, uuid, text, text, bigint, integer, text, text) to service_role;
grant execute on function public.record_vpa_payout_failure(uuid, text, boolean) to service_role;
grant execute on function public.list_vpa_payout_work(integer) to service_role;
grant execute on function public.admin_retry_vpa_payout(uuid) to authenticated;
grant execute on function public.admin_set_seller_payout_status(uuid, text) to authenticated;
grant execute on function public.admin_vpa_payouts_ledger(text, integer, integer) to authenticated;
