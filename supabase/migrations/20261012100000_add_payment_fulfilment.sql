-- Milestone 5.1: server-side payment fulfilment (webhook + verify share ONE idempotent function).
--
-- ADDITIVE ONLY. Creates two tables and five service_role-only functions. It does not alter or drop any existing
-- object, does not touch `public.purchases` policies/grants, and does not touch any feature flag.
--
-- Why: until now a purchase row existed only if the buyer's own browser called /api/razorpay/verify-payment after
-- paying. A closed tab / dropped connection after payment = charged, no access. Razorpay's signed `payment.captured`
-- webhook is the reliable signal; both paths now call public.fulfil_captured_payment(), which is idempotent.
--
-- Error handling: business outcomes are RETURNED as jsonb {outcome, purchase_id}; only malformed input raises
-- (errcode CM070). Existing codes CM001-CM062 are untouched.
--
-- Rollback (nothing else depends on these objects until the 5.1 app code is deployed):
--   drop function public.fulfil_captured_payment(text,text,integer,text,text,text,numeric,uuid,text);
--   drop function public.record_payment_order(text,uuid,uuid,integer);
--   drop function public.begin_webhook_event(text,text,text,text,text);
--   drop function public.finish_webhook_event(text,text,text,text);
--   drop table public.webhook_events; drop table public.payment_orders;

-- ---------------------------------------------------------------- payment_orders
-- One row per Razorpay order WE created (written server-side by /api/razorpay/create-order). This is the trusted
-- mapping order -> (buyer, listing, amount). We never rely on client-supplied ids or on Razorpay "notes".
create table public.payment_orders (
  razorpay_order_id text primary key check (length(razorpay_order_id) between 1 and 100),
  user_id           uuid not null references auth.users(id) on delete cascade,
  listing_id        uuid not null references public.listings(id) on delete cascade,
  amount_paise      integer not null check (amount_paise > 0),
  currency          text not null default 'INR' check (currency = 'INR'),
  created_at        timestamptz not null default now()
);
create index payment_orders_user_listing_idx on public.payment_orders (user_id, listing_id);
comment on table public.payment_orders is
  'Orders created by our server. Source of truth for who is paying for what, and how much, when a payment arrives.';

-- ---------------------------------------------------------------- webhook_events
-- Idempotency + audit for provider webhooks. We store ONLY ids and a SHA-256 of the body -- never the payload
-- (it can contain buyer email / phone).
create table public.webhook_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'razorpay',
  provider_event_id   text not null check (length(provider_event_id) between 1 and 200),
  event_type          text not null check (length(event_type) between 1 and 100),
  razorpay_order_id   text,
  razorpay_payment_id text,
  payload_sha256      text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status              text not null default 'received'
    check (status in ('received', 'processed', 'ignored', 'needs_review', 'failed')),
  outcome             text,
  error               text,
  attempts            integer not null default 1 check (attempts >= 1),
  purchase_id         uuid references public.purchases(id) on delete set null,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  unique (provider, provider_event_id)
);
create index webhook_events_status_idx on public.webhook_events (status) where status in ('needs_review', 'failed');
create index webhook_events_payment_idx on public.webhook_events (razorpay_payment_id);
comment on table public.webhook_events is
  'received = in flight; processed/ignored = done; needs_review = a human must look (money moved but no access granted, '
  'or a mismatch); failed = transient error, the provider will retry and begin_webhook_event() will let it through.';

-- Only admins can read; nobody but the SECURITY DEFINER functions below writes.
alter table public.payment_orders enable row level security;
alter table public.webhook_events enable row level security;
revoke all on public.payment_orders from anon, authenticated;
revoke all on public.webhook_events from anon, authenticated;
grant select on public.payment_orders to authenticated;
grant select on public.webhook_events to authenticated;
create policy "Admins can view payment orders" on public.payment_orders
  for select to authenticated using ((select private.is_admin()));
create policy "Admins can view webhook events" on public.webhook_events
  for select to authenticated using ((select private.is_admin()));

-- ---------------------------------------------------------------- record_payment_order
create function public.record_payment_order(
  p_order_id     text,
  p_user_id      uuid,
  p_listing_id   uuid,
  p_amount_paise integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_order_id is null or length(p_order_id) not between 1 and 100
     or p_user_id is null or p_listing_id is null
     or p_amount_paise is null or p_amount_paise <= 0 then
    raise exception using errcode = 'CM070', message = 'invalid_payment_order';
  end if;
  insert into public.payment_orders (razorpay_order_id, user_id, listing_id, amount_paise)
  values (p_order_id, p_user_id, p_listing_id, p_amount_paise)
  on conflict (razorpay_order_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------- begin_webhook_event
-- Returns 'new' (first time), 'retry' (earlier attempt was received/failed -- process again) or
-- 'duplicate' (already processed / ignored / needs_review -- do nothing, answer 200).
create function public.begin_webhook_event(
  p_event_id   text,
  p_event_type text,
  p_order_id   text,
  p_payment_id text,
  p_sha256     text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 200
     or p_event_type is null or length(p_event_type) not between 1 and 100
     or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'CM070', message = 'invalid_webhook_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('webhook_event:' || p_event_id, 0));

  select e.status into v_status
    from public.webhook_events e
   where e.provider = 'razorpay' and e.provider_event_id = p_event_id;

  if not found then
    insert into public.webhook_events (provider_event_id, event_type, razorpay_order_id, razorpay_payment_id, payload_sha256)
    values (p_event_id, p_event_type, p_order_id, p_payment_id, p_sha256);
    return 'new';
  end if;

  if v_status in ('processed', 'ignored', 'needs_review') then
    return 'duplicate';
  end if;

  update public.webhook_events e
     set attempts = e.attempts + 1, status = 'received', error = null
   where e.provider = 'razorpay' and e.provider_event_id = p_event_id;
  return 'retry';
end;
$$;

-- ---------------------------------------------------------------- finish_webhook_event
create function public.finish_webhook_event(
  p_event_id text,
  p_status   text,
  p_outcome  text,
  p_error    text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status is null or p_status not in ('processed', 'ignored', 'needs_review', 'failed') then
    raise exception using errcode = 'CM070', message = 'invalid_webhook_status';
  end if;
  update public.webhook_events e
     set status       = p_status,
         outcome      = left(p_outcome, 100),
         error        = left(p_error, 500),
         processed_at = now()
   where e.provider = 'razorpay' and e.provider_event_id = p_event_id
     and e.status in ('received', 'failed');
end;
$$;

-- ---------------------------------------------------------------- fulfil_captured_payment
-- The ONE place a paid purchase is created. Idempotent and race-safe (advisory lock on the payment id plus the
-- table's own unique indexes).
--
--   p_amount_paise       what Razorpay says was paid; NULL = "signature already proved payment of this order"
--                        (browser verify path when Razorpay's lookup failed): the order's own amount is used.
--   p_expected_user_id   browser path passes the logged-in user: the order must belong to them. Webhook passes NULL.
--   p_event_id           when given, the webhook_events row is finished in the SAME transaction as the purchase.
--
-- outcome: fulfilled | already_fulfilled   -> access granted (success)
--          duplicate_payment               -> buyer already owns it, a SECOND payment was taken (refund needed)
--          order_unknown | order_user_mismatch | amount_mismatch | listing_unavailable -> nothing granted, review
create function public.fulfil_captured_payment(
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
              (v_order.user_id, v_order.listing_id, v_amount, v_method, p_order_id, p_payment_id,
               nullif(left(p_signature, 200), ''), round(v_amount * p_fee_pct, 2))
            returning id into v_purchase;
            v_outcome := 'fulfilled';
            insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
            values (null, 'payment_fulfilled', 'purchase', v_purchase,
                    jsonb_build_object('order_id', p_order_id, 'payment_id', p_payment_id,
                                       'amount_paise', v_order.amount_paise,
                                       'source', case when p_event_id is null then 'verify' else 'webhook' end));
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

-- ---------------------------------------------------------------- grants: service_role ONLY
revoke all on function public.record_payment_order(text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.begin_webhook_event(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.finish_webhook_event(text, text, text, text) from public, anon, authenticated;
revoke all on function public.fulfil_captured_payment(text, text, integer, text, text, text, numeric, uuid, text) from public, anon, authenticated;
grant execute on function public.record_payment_order(text, uuid, uuid, integer) to service_role;
grant execute on function public.begin_webhook_event(text, text, text, text, text) to service_role;
grant execute on function public.finish_webhook_event(text, text, text, text) to service_role;
grant execute on function public.fulfil_captured_payment(text, text, integer, text, text, text, numeric, uuid, text) to service_role;
