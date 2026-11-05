-- Milestone 5.10 -- (1) "Payout Completed" straight from the Settlement Desk's seller summary row, (2) database-backed rate limiting.
--   * public.admin_complete_seller_payout(seller, period_end, reference, payment_date): admin + MFA. For ONE seller it freezes their eligible sales into a
--     batch of one that is created already 'completed' with the line already 'paid' (so it works while a monthly batch is open), in a single transaction.
--     The same rules as a normal batch apply (active account, complete bank details, bank-change cooldown, minimum payout). /sell/earnings reads
--     settlement_items, so the seller sees Paid + date + reference at once. Audited.
--   * private.rate_limit_events + private.rate_limit_consume(): sliding-window counter shared by every serverless instance.
--   * public.rate_limit_hit / rate_limit_reset: service_role ONLY (called by server routes: login, PAN / identity, bank details).
--   * triggers on seller_identity_details and seller_payout_accounts: a seller's own writes are capped per hour in the database itself, so the cap
--     holds even for a request that skips the API route. Admin / system writes (auth.uid() is not the row owner) are never counted.
-- Error code CM082 = rate_limited (new). Additive only: no table or column is changed.
-- Rollback: drop trigger rate_limit_identity_writes on public.seller_identity_details; drop trigger rate_limit_bank_writes on public.seller_payout_accounts;
--   drop function public.admin_complete_seller_payout(uuid, timestamptz, text, date), public.rate_limit_hit(text, text, integer, integer),
--   public.rate_limit_reset(text, text), private.rate_limit_writes(), private.rate_limit_consume(text, text, integer, integer); drop table private.rate_limit_events;

-- ------------------------------------------------------------------ rate limiting
create table if not exists private.rate_limit_events (
  id     bigint generated always as identity primary key,
  bucket text not null check (length(bucket) between 1 and 64),
  key    text not null check (length(key) between 1 and 128),
  at     timestamptz not null default now()
);
create index if not exists rate_limit_events_lookup on private.rate_limit_events (bucket, key, at);
create index if not exists rate_limit_events_at on private.rate_limit_events (at);
alter table private.rate_limit_events enable row level security;

create or replace function private.rate_limit_consume(p_bucket text, p_key text, p_limit integer, p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_n integer; v_oldest timestamptz; v_win interval;
begin
  if p_bucket is null or p_key is null or p_limit is null or p_window_seconds is null
     or length(p_bucket) not between 1 and 64 or length(p_key) not between 1 and 128
     or p_limit not between 1 and 1000 or p_window_seconds not between 1 and 86400 then
    raise exception using errcode = '22023', message = 'invalid_rate_limit_input';
  end if;
  v_win := make_interval(secs => p_window_seconds);
  perform pg_advisory_xact_lock(hashtextextended(p_bucket || ':' || p_key, 0));
  delete from private.rate_limit_events e where e.bucket = p_bucket and e.key = p_key and e.at < now() - v_win;
  if random() < 0.02 then
    delete from private.rate_limit_events e where e.at < now() - interval '2 days';
  end if;
  select count(*)::integer, min(e.at) into v_n, v_oldest from private.rate_limit_events e where e.bucket = p_bucket and e.key = p_key;
  if v_n >= p_limit then
    return jsonb_build_object('allowed', false, 'remaining', 0,
                              'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_oldest + v_win - now())))::integer));
  end if;
  insert into private.rate_limit_events (bucket, key) values (p_bucket, p_key);
  return jsonb_build_object('allowed', true, 'remaining', p_limit - v_n - 1, 'retry_after_seconds', 0);
end;
$$;
revoke all on function private.rate_limit_consume(text, text, integer, integer) from public, anon, authenticated;

create or replace function public.rate_limit_hit(p_bucket text, p_key text, p_limit integer, p_window_seconds integer)
returns jsonb language sql security definer set search_path = ''
as $$ select private.rate_limit_consume(p_bucket, p_key, p_limit, p_window_seconds); $$;
revoke all on function public.rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer) to service_role;

create or replace function public.rate_limit_reset(p_bucket text, p_key text)
returns void language sql security definer set search_path = ''
as $$ delete from private.rate_limit_events e where e.bucket = p_bucket and e.key = p_key; $$;
revoke all on function public.rate_limit_reset(text, text) from public, anon, authenticated;
grant execute on function public.rate_limit_reset(text, text) to service_role;

-- Seller-owned writes: counted only when the signed-in user is writing THEIR OWN row.
create or replace function private.rate_limit_writes()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  r jsonb;
begin
  if v_uid is null or v_uid is distinct from new.user_id then
    return new;
  end if;
  r := private.rate_limit_consume(tg_argv[0], v_uid::text, tg_argv[1]::integer, tg_argv[2]::integer);
  if not (r->>'allowed')::boolean then
    raise exception using errcode = 'CM082', message = 'rate_limited', hint = (r->>'retry_after_seconds');
  end if;
  return new;
end;
$$;
revoke all on function private.rate_limit_writes() from public, anon, authenticated;

drop trigger if exists rate_limit_identity_writes on public.seller_identity_details;
create trigger rate_limit_identity_writes before insert or update on public.seller_identity_details
  for each row execute function private.rate_limit_writes('identity_write', '10', '3600');
drop trigger if exists rate_limit_bank_writes on public.seller_payout_accounts;
create trigger rate_limit_bank_writes before insert or update on public.seller_payout_accounts
  for each row execute function private.rate_limit_writes('bank_write', '10', '3600');

-- ------------------------------------------------------------------ Payout Completed (one seller, from the summary row)
create or replace function public.admin_complete_seller_payout(p_seller_id uuid, p_period_end timestamptz, p_reference text, p_payment_date date default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_ref   text := btrim(p_reference);
  v_end   timestamptz := coalesce(p_period_end, now());
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_date  date := coalesce(p_payment_date, (now() at time zone 'Asia/Kolkata')::date);
  v_paid  timestamptz;
  v_label text;
  v_batch uuid;
  v_item  uuid;
  v_min   integer;
  v_cool  integer;
  v_amt   bigint; v_fee bigint; v_cnt integer;
  a       public.seller_payout_accounts%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_seller_id is null or v_ref is null or v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._/ -]{0,79}$'
     or v_end > now() + interval '1 hour' or v_date > v_today or v_date < v_today - 90 then
    raise exception using errcode = 'CM076', message = 'invalid_settlement_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('settlement_batch', 0));
  select c.min_payout_paise, c.upi_cooldown_hours into v_min, v_cool from private.settlement_config c where c.id;

  select * into a from public.seller_payout_accounts x
   where x.user_id = p_seller_id and x.status = 'active' and x.bank_account_number is not null and x.bank_ifsc is not null
     and not (v_cool > 0 and x.bank_changed_at is not null and x.bank_changed_at + make_interval(hours => v_cool) > now());
  if not found then
    raise exception using errcode = 'CM076', message = 'nothing_to_settle';
  end if;

  select coalesce(sum(e.amount_paise), 0)::bigint, coalesce(sum(e.fee_paise), 0)::bigint, count(*)::integer
    into v_amt, v_fee, v_cnt from private.settlement_eligible(v_end) e where e.seller_id = p_seller_id;
  if v_cnt = 0 or v_amt < v_min or v_amt <= 0 then
    raise exception using errcode = 'CM076', message = 'nothing_to_settle';
  end if;

  v_paid  := case when v_date = v_today then now() else ((v_date + time '12:00') at time zone 'Asia/Kolkata') end;
  v_label := 'seller-' || to_char(v_today, 'YYYYMMDD') || '-' || left(replace(p_seller_id::text, '-', ''), 8);
  if exists (select 1 from public.settlement_batches b where b.label = v_label) then
    v_label := v_label || '-' || (extract(epoch from clock_timestamp())::bigint)::text;
  end if;

  insert into public.settlement_batches (label, period_end, created_by, status, completed_at, total_paise, seller_count)
  values (v_label, v_end, (select auth.uid()), 'completed', now(), v_amt, 1) returning id into v_batch;

  insert into public.settlement_items (batch_id, seller_id, bank_account_number, bank_ifsc, bank_beneficiary_name, bank_account_type,
                                       amount_paise, platform_fee_paise, purchase_count, status, utr, paid_at)
  values (v_batch, p_seller_id, a.bank_account_number, a.bank_ifsc, coalesce(a.bank_beneficiary_name, 'Account holder'), coalesce(a.bank_account_type, 'savings'),
          v_amt, v_fee, v_cnt, 'paid', v_ref, v_paid) returning id into v_item;

  insert into public.purchase_settlements (purchase_id, item_id, seller_id, amount_paise, platform_fee_paise)
  select e.purchase_id, v_item, e.seller_id, e.amount_paise, e.fee_paise from private.settlement_eligible(v_end) e where e.seller_id = p_seller_id;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values ((select auth.uid()), 'seller_payout_completed', 'settlement_item', v_item,
          jsonb_build_object('reference', v_ref, 'payment_date', v_date, 'amount_paise', v_amt, 'seller_id', p_seller_id, 'purchases', v_cnt, 'batch_id', v_batch));
  return jsonb_build_object('settled_paise', v_amt, 'paid_at', v_paid, 'purchase_count', v_cnt, 'batch_id', v_batch);
end;
$$;
revoke all on function public.admin_complete_seller_payout(uuid, timestamptz, text, date) from public, anon;
grant execute on function public.admin_complete_seller_payout(uuid, timestamptz, text, date) to authenticated;
