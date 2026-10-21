-- Milestone 5.5: manual MONTHLY settlement of seller earnings to their saved UPI ID.
--
-- Decision: RazorpayX / outgoing payout APIs are NOT used. Buyers pay through the normal Razorpay Payment Gateway and the money settles to the
-- platform's own account. Once a month an admin pays each seller by hand (UPI) and records it here. All sales stay final and non-recourse:
-- nothing in this migration ever debits a seller, creates a negative balance or claws money back.
--
-- What is new (everything is additive; no existing object is changed or dropped)
--   * private.settlement_config (single row): start_at = only purchases made at/after this instant are ever settled (default '-infinity' = all paid sales)
--   * public.settlement_batches    one row per monthly run (label unique, at most ONE open batch at a time)
--   * public.settlement_items      one row per seller per batch: UPI ID snapshot, amount, status pending|paid|released, batch UTR/reference
--   * public.purchase_settlements  one row per settled purchase (PRIMARY KEY purchase_id) = the database-level guard against paying a sale twice
--   * private.settlement_eligible(timestamptz)  the one definition of "owed and not yet in a batch"
--   * admin RPCs (admin + MFA first statement): admin_settlement_pending, admin_create_settlement_batch, admin_settlement_batches,
--       admin_settlement_batch, admin_settle_items, admin_release_settlement_item, admin_cancel_settlement_batch
--   * seller RPC: seller_settlement_status (own rows only, allow-listed JSON, no ids of items/sellers)
--
-- Seller share (same rule as 5.4): round(amount*100) - round(platform_fee*100), integer paise. A purchase is eligible when it is 'paid', has a
-- Razorpay payment id, is not already in a batch, has no Route transfer and no UPI payout row (the retired flows), and its seller has an ACTIVE payout
-- account with a UPI ID. Sellers without one keep their earnings unsettled until they add it; a suspended seller is skipped (admin Pause).
-- A sale refunded BEFORE it is put in a batch is not eligible (status <> 'paid'). Once a sale is in a batch its amount is frozen; the admin desk flags
-- items that contain a sale refunded afterwards so they can be released and re-run. Money already paid is never reversed here.
--
-- The retired outgoing flows stay dormant: phase6_vpa_payouts and phase5_route_transfers remain OFF (this migration touches no flag) and
-- private.vpa_payout_config.cutoff_at stays 'infinity', so even a mistaken flag flip pays nobody.
--
-- Error code: CM076 (invalid settlement input / state). Every earlier code is untouched.
--
-- Rollback (nothing outside these objects depends on them until the 5.5 app code is deployed):
--   drop function public.seller_settlement_status(integer), public.admin_cancel_settlement_batch(uuid), public.admin_release_settlement_item(uuid, text),
--     public.admin_settle_items(uuid, text, uuid[]), public.admin_settlement_batch(uuid), public.admin_settlement_batches(integer),
--     public.admin_create_settlement_batch(text, timestamptz), public.admin_settlement_pending(timestamptz, integer), private.settlement_eligible(timestamptz);
--   drop table public.purchase_settlements, public.settlement_items, public.settlement_batches, private.settlement_config;

-- ---------------------------------------------------------------- config
create table private.settlement_config (
  id         boolean primary key default true check (id),
  start_at   timestamptz not null default '-infinity',
  updated_at timestamptz not null default now()
);
insert into private.settlement_config (id) values (true) on conflict (id) do nothing;
comment on table private.settlement_config is
  'start_at: only purchases made at/after this instant are ever put in a settlement batch (default -infinity = every paid sale). Raise it to exclude old or test sales.';

-- ---------------------------------------------------------------- tables
create table public.settlement_batches (
  id           uuid primary key default gen_random_uuid(),
  label        text not null check (length(btrim(label)) between 1 and 60),
  period_end   timestamptz not null,
  status       text not null default 'open' check (status in ('open', 'completed')),
  total_paise  bigint not null default 0 check (total_paise >= 0),
  seller_count integer not null default 0 check (seller_count >= 0),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  unique (label),
  check ((status = 'completed') = (completed_at is not null))
);
-- at most one open batch: the admin finishes (or cancels) one month before starting the next
create unique index settlement_batches_one_open on public.settlement_batches ((true)) where status = 'open';

create table public.settlement_items (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references public.settlement_batches(id) on delete cascade,
  seller_id          uuid not null references auth.users(id) on delete cascade,
  vpa_address        text not null check (vpa_address ~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$'),
  amount_paise       bigint not null check (amount_paise > 0),
  platform_fee_paise bigint not null check (platform_fee_paise >= 0),
  purchase_count     integer not null check (purchase_count > 0),
  status             text not null default 'pending' check (status in ('pending', 'paid', 'released')),
  utr                text check (utr is null or length(utr) between 1 and 80),
  paid_at            timestamptz,
  released_reason    text check (released_reason is null or length(released_reason) between 1 and 300),
  updated_at         timestamptz not null default now(),
  unique (batch_id, seller_id),
  check ((status = 'paid') = (paid_at is not null)),
  check (status <> 'paid' or utr is not null),
  check ((status = 'released') = (released_reason is not null))
);
create index settlement_items_seller_idx on public.settlement_items (seller_id);

create table public.purchase_settlements (
  purchase_id        uuid primary key references public.purchases(id) on delete cascade,
  item_id            uuid not null references public.settlement_items(id) on delete cascade,
  seller_id          uuid not null references auth.users(id) on delete cascade,
  amount_paise       integer not null check (amount_paise > 0),
  platform_fee_paise integer not null check (platform_fee_paise >= 0),
  created_at         timestamptz not null default now()
);
create index purchase_settlements_item_idx on public.purchase_settlements (item_id);
create index purchase_settlements_seller_idx on public.purchase_settlements (seller_id);

comment on table public.purchase_settlements is
  'One row per settled sale (primary key purchase_id): a sale can be in at most one settlement item, so it cannot be paid twice. Written only by the SECURITY DEFINER functions of migration 5.5.';

-- nobody reads or writes these tables directly: sellers use seller_settlement_status(), admins use the admin_* functions
alter table public.settlement_batches enable row level security;
alter table public.settlement_items enable row level security;
alter table public.purchase_settlements enable row level security;
revoke all on public.settlement_batches, public.settlement_items, public.purchase_settlements from anon, authenticated;
revoke all on private.settlement_config from public, anon, authenticated;

-- ---------------------------------------------------------------- the one definition of "owed and not yet in a batch"
create function private.settlement_eligible(p_period_end timestamptz)
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
     and p.razorpay_payment_id is not null
     and l.seller_id is not null
     and p.purchased_at >= c.start_at
     and p.purchased_at < p_period_end
     and round(coalesce(p.platform_fee, 0) * 100) < round(p.amount * 100)
     and not exists (select 1 from public.purchase_settlements s where s.purchase_id = p.id)
     and not exists (select 1 from public.transfers t where t.purchase_id = p.id)      -- retired Route flow: never pay a sale twice
     and not exists (select 1 from public.vpa_payouts v where v.purchase_id = p.id);   -- retired instant-UPI flow
$$;
revoke execute on function private.settlement_eligible(timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- admin: preview what a batch would contain (read-only)
create function public.admin_settlement_pending(p_period_end timestamptz default null, p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_end     timestamptz := coalesce(p_period_end, now());
  v_start   timestamptz;
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
  select c.start_at into v_start from private.settlement_config c where c.id;
  select b.id into v_open from public.settlement_batches b where b.status = 'open';

  with e as (
    select x.seller_id, sum(x.amount_paise)::bigint as amt, sum(x.fee_paise)::bigint as fee, count(*)::integer as cnt
      from private.settlement_eligible(v_end) x group by x.seller_id
  ),
  j as (
    select e.*, pr.display_name, a.vpa_address, a.status as acct_status,
           case when a.user_id is null or a.vpa_address is null then 'no_upi_id'
                when a.status <> 'active' then 'account_' || a.status end as blocked_reason
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
                                                  'reason', j.blocked_reason, 'amount_paise', j.amt, 'purchase_count', j.cnt)
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
    'open_batch_id', v_open,
    'totals', v_totals, 'payable', v_payable, 'blocked', v_blocked);
end;
$$;

-- ---------------------------------------------------------------- admin: freeze a batch (snapshot of who is owed what)
create function public.admin_create_settlement_batch(p_label text, p_period_end timestamptz)
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
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  -- a cut-off slightly in the future is tolerated (browser vs database clock skew); a sale can never be stamped later than now() anyway
  if v_label is null or length(v_label) < 1 or length(v_label) > 60 or v_end > now() + interval '1 hour' then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('settlement_batch', 0));
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
     group by e.seller_id, acct.vpa_address
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

-- ---------------------------------------------------------------- admin: list batches
create function public.admin_settlement_batches(p_limit integer default 24)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb) into v_items
    from (
      select b.created_at, b.id,
             jsonb_build_object(
               'batch_id', b.id, 'label', b.label, 'status', b.status, 'period_end', b.period_end,
               'total_paise', b.total_paise, 'seller_count', b.seller_count, 'created_at', b.created_at, 'completed_at', b.completed_at,
               'paid_paise',     coalesce(sum(i.amount_paise) filter (where i.status = 'paid'), 0),
               'paid_count',     count(i.id) filter (where i.status = 'paid'),
               'pending_paise',  coalesce(sum(i.amount_paise) filter (where i.status = 'pending'), 0),
               'pending_count',  count(i.id) filter (where i.status = 'pending'),
               'released_paise', coalesce(sum(i.amount_paise) filter (where i.status = 'released'), 0)) as j
        from public.settlement_batches b
        left join public.settlement_items i on i.batch_id = b.id
       group by b.id
       order by b.created_at desc, b.id
       limit p_limit
    ) x;
  return jsonb_build_object('items', v_items);
end;
$$;

-- ---------------------------------------------------------------- admin: one batch with its items (what the CSV is built from)
create function public.admin_settlement_batch(p_batch_id uuid)
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
               'item_id', i.id, 'seller_id', i.seller_id, 'seller_name', pr.display_name, 'vpa_address', i.vpa_address,
               'amount_paise', i.amount_paise, 'platform_fee_paise', i.platform_fee_paise, 'purchase_count', i.purchase_count,
               'status', i.status, 'utr', i.utr, 'paid_at', i.paid_at, 'released_reason', i.released_reason,
               'account_status', a.status,
               -- safety flags for the person about to send money by hand
               'refunded_purchase_count', (select count(*) from public.purchase_settlements s join public.purchases p on p.id = s.purchase_id
                                            where s.item_id = i.id and p.status <> 'paid'),
               'upi_changed_since_snapshot', (a.vpa_address is distinct from i.vpa_address),
               'upi_changed_recently', exists (select 1 from public.audit_log al
                                                where al.action = 'payout_vpa_set' and al.target_id = i.seller_id
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

-- ---------------------------------------------------------------- admin: record that the money was sent (all pending items, or a chosen few)
-- p_reference: the bulk-transfer reference / UTR the admin got from the bank (stored on every item it covers).
create function public.admin_settle_items(p_batch_id uuid, p_reference text, p_item_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref     text := btrim(p_reference);
  v_b       public.settlement_batches%rowtype;
  v_ids     uuid[];
  v_n       integer;
  v_sum     bigint;
  v_left    integer;
  v_done    boolean := false;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_batch_id is null or v_ref is null or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._/ -]{0,79}$'
     or (p_item_ids is not null and cardinality(p_item_ids) = 0) then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select * into v_b from public.settlement_batches b where b.id = p_batch_id for update;
  if not found or v_b.status <> 'open' then
    raise exception using errcode = 'CM076', message = 'batch_not_open';
  end if;

  select array_agg(i.id) into v_ids from public.settlement_items i
   where i.batch_id = p_batch_id and i.status = 'pending' and (p_item_ids is null or i.id = any (p_item_ids));
  if v_ids is null or (p_item_ids is not null and cardinality(v_ids) <> (select count(distinct x) from unnest(p_item_ids) x)) then
    raise exception using errcode = 'CM076', message = 'invalid_items';
  end if;

  update public.settlement_items i
     set status = 'paid', utr = v_ref, paid_at = now(), updated_at = now()
   where i.id = any (v_ids);
  get diagnostics v_n = row_count;
  select coalesce(sum(i.amount_paise), 0) into v_sum from public.settlement_items i where i.id = any (v_ids);

  select count(*) into v_left from public.settlement_items i where i.batch_id = p_batch_id and i.status = 'pending';
  if v_left = 0 then
    update public.settlement_batches b set status = 'completed', completed_at = now() where b.id = p_batch_id;
    v_done := true;
  end if;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'settlement_items_paid', 'settlement_batch', p_batch_id,
          jsonb_build_object('reference', v_ref, 'items', v_n, 'total_paise', v_sum, 'batch_completed', v_done));
  return jsonb_build_object('settled_count', v_n, 'settled_paise', v_sum, 'batch_completed', v_done);
end;
$$;

-- ---------------------------------------------------------------- admin: a manual transfer bounced -> put that seller's sales back to unsettled
create function public.admin_release_settlement_item(p_item_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := btrim(p_reason);
  v_i      public.settlement_items%rowtype;
  v_b      public.settlement_batches%rowtype;
  v_left   integer;
  v_done   boolean := false;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_item_id is null or v_reason is null or length(v_reason) < 1 or length(v_reason) > 300 then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select * into v_i from public.settlement_items i where i.id = p_item_id;
  if not found then
    raise exception using errcode = 'CM076', message = 'invalid_items';
  end if;
  select * into v_b from public.settlement_batches b where b.id = v_i.batch_id for update;
  select * into v_i from public.settlement_items i where i.id = p_item_id for update;
  if v_b.status <> 'open' or v_i.status <> 'pending' then
    raise exception using errcode = 'CM076', message = 'batch_not_open';     -- a paid item is final and cannot be released
  end if;

  delete from public.purchase_settlements s where s.item_id = p_item_id;      -- those sales are unsettled again and join the next batch
  update public.settlement_items i set status = 'released', released_reason = v_reason, updated_at = now() where i.id = p_item_id;

  select count(*) into v_left from public.settlement_items i where i.batch_id = v_b.id and i.status = 'pending';
  if v_left = 0 then
    update public.settlement_batches b set status = 'completed', completed_at = now() where b.id = v_b.id;
    v_done := true;
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'settlement_item_released', 'settlement_item', p_item_id,
          jsonb_build_object('batch_id', v_b.id, 'seller_id', v_i.seller_id, 'amount_paise', v_i.amount_paise, 'reason', v_reason, 'batch_completed', v_done));
  return jsonb_build_object('released', true, 'batch_completed', v_done);
end;
$$;

-- ---------------------------------------------------------------- admin: throw away a batch nobody has paid yet (wrong cut-off, wrong label)
create function public.admin_cancel_settlement_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b public.settlement_batches%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_batch_id is null then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  select * into v_b from public.settlement_batches b where b.id = p_batch_id for update;
  if not found or v_b.status <> 'open' or exists (select 1 from public.settlement_items i where i.batch_id = p_batch_id and i.status = 'paid') then
    raise exception using errcode = 'CM076', message = 'batch_not_open';
  end if;
  delete from public.settlement_batches b where b.id = p_batch_id;            -- cascades to its items and purchase rows
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'settlement_batch_cancelled', 'settlement_batch', p_batch_id,
          jsonb_build_object('label', v_b.label, 'total_paise', v_b.total_paise, 'sellers', v_b.seller_count));
end;
$$;

-- ---------------------------------------------------------------- seller: my own earnings, in plain codes (never ids of items/sellers, never errors)
-- sale status: settled | in_batch | unsettled | needs_upi | under_review | refunded
create function public.seller_settlement_status(p_limit integer default 100)
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
  select c.start_at into v_start from private.settlement_config c where c.id;
  select a.status, a.vpa_address into v_account, v_vpa from public.seller_payout_accounts a where a.user_id = v_uid;
  if v_vpa is null then v_account := null; end if;

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
        'unsettled_paise',     coalesce(sum(c.share) filter (where c.code in ('unsettled', 'needs_upi', 'under_review')), 0),
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
                            'next_payout_date', v_next, 'summary', v_summary, 'items', v_items, 'payouts', v_pay);
end;
$$;

-- ---------------------------------------------------------------- grants
revoke all on function public.admin_settlement_pending(timestamptz, integer) from public, anon, authenticated;
revoke all on function public.admin_create_settlement_batch(text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_settlement_batches(integer) from public, anon, authenticated;
revoke all on function public.admin_settlement_batch(uuid) from public, anon, authenticated;
revoke all on function public.admin_settle_items(uuid, text, uuid[]) from public, anon, authenticated;
revoke all on function public.admin_release_settlement_item(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_cancel_settlement_batch(uuid) from public, anon, authenticated;
revoke all on function public.seller_settlement_status(integer) from public, anon, authenticated;
grant execute on function public.admin_settlement_pending(timestamptz, integer) to authenticated;
grant execute on function public.admin_create_settlement_batch(text, timestamptz) to authenticated;
grant execute on function public.admin_settlement_batches(integer) to authenticated;
grant execute on function public.admin_settlement_batch(uuid) to authenticated;
grant execute on function public.admin_settle_items(uuid, text, uuid[]) to authenticated;
grant execute on function public.admin_release_settlement_item(uuid, text) to authenticated;
grant execute on function public.admin_cancel_settlement_batch(uuid) to authenticated;
grant execute on function public.seller_settlement_status(integer) to authenticated;
