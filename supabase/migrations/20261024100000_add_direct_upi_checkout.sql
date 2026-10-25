-- Direct-to-seller payments (flag `direct_upi_checkout`, seeded OFF). ADDITIVE; while the flag is OFF nothing in the app changes.
--
-- What this adds
--   1. public.seller_identity_details   step 1 of seller onboarding: legal name, contact, address, PAN and a government-ID TYPE + LAST 4 ONLY.
--                                        (The full government-ID number is validated and then discarded: it is never stored.)
--   2. public.direct_payment_claims     a buyer pays the seller's UPI ID directly and submits the 12-digit UTR; the SELLER confirms or rejects.
--   3. RPCs: set_seller_identity_details, get_direct_payment_target, submit_direct_payment_claim, confirm_direct_payment_claim,
--            reject_direct_payment_claim, seller_direct_claims, my_direct_seller_status, direct_upi_checkout_enabled.
--   4. set_my_payout_vpa      replaced: with the flag ON it refuses until identity details are saved (everything else is the 5.7 body, unchanged).
--   5. private.settlement_eligible replaced: ignores payment_method = 'direct_upi' so direct sales never enter the monthly settlement desk.
--   6. listings BEFORE INSERT trigger: with the flag ON a seller needs identity details + an active, matured UPI ID to create a listing.
--   7. private.direct_upi_config       cooldown hours (default 72) and claim-overdue hours (default 48).
--
-- Rollback (nothing is dropped by this migration): update private.feature_flags set enabled = false where name = 'direct_upi_checkout';
-- Full removal would be a separate, explicitly approved migration (drop trigger/functions/tables listed above).

insert into private.feature_flags (name, enabled) values ('direct_upi_checkout', false) on conflict (name) do nothing;

create table private.direct_upi_config (
  id                 boolean primary key default true check (id),
  upi_cooldown_hours integer not null default 72 check (upi_cooldown_hours between 0 and 720),
  claim_ttl_hours    integer not null default 48 check (claim_ttl_hours between 1 and 720),
  updated_at         timestamptz not null default now()
);
insert into private.direct_upi_config (id) values (true) on conflict (id) do nothing;
alter table private.direct_upi_config enable row level security;
comment on table private.direct_upi_config is
  'upi_cooldown_hours: a CHANGED seller UPI ID is not shown to buyers (and cannot create listings) until this many hours pass (0 = off). claim_ttl_hours: a pending payment claim older than this is shown as overdue and can be superseded by a new claim.';

create function private.direct_upi_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$ select coalesce((select f.enabled from private.feature_flags f where f.name = 'direct_upi_checkout'), false) is true $$;
revoke execute on function private.direct_upi_enabled() from public, anon, authenticated, service_role;

create function public.direct_upi_checkout_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$ select private.direct_upi_enabled() $$;
revoke execute on function public.direct_upi_checkout_enabled() from public;
grant execute on function public.direct_upi_checkout_enabled() to anon, authenticated;

-- ---------------------------------------------------------------- step 1: identity and tax details
create table public.seller_identity_details (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  legal_first_name text not null check (btrim(legal_first_name) <> '' and length(legal_first_name) <= 60 and legal_first_name !~ '[0-9<>@]'),
  legal_last_name  text not null check (btrim(legal_last_name) <> '' and length(legal_last_name) <= 60 and legal_last_name !~ '[0-9<>@]'),
  contact_email    text not null check (length(contact_email) <= 254 and contact_email ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  phone_number     text not null check (phone_number ~ '^[6-9][0-9]{9}$'),
  street_address   text not null check (length(btrim(street_address)) between 5 and 300 and street_address !~ '[<>]'),
  country          text not null default 'India' check (country = 'India'),
  pan_number       text not null check (pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  govt_id_type     text not null check (govt_id_type in ('aadhaar', 'voter_id', 'passport')),
  govt_id_last4    text not null check (govt_id_last4 ~ '^[A-Z0-9]{4}$'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.seller_identity_details is
  'Seller identity + tax details, written ONLY by set_seller_identity_details. The full government-ID number is never stored (type + last 4 only). Readable by the owner and by an admin with MFA.';
alter table public.seller_identity_details enable row level security;
revoke all on public.seller_identity_details from anon, authenticated;
grant select on public.seller_identity_details to authenticated;
create policy "Sellers can view their own identity details" on public.seller_identity_details
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Admins with MFA can view identity details" on public.seller_identity_details
  for select to authenticated using ((select private.is_admin_mfa()));

create function private.seller_identity_complete(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.seller_identity_details d where d.user_id = p_user) $$;
revoke execute on function private.seller_identity_complete(uuid) from public, anon, authenticated, service_role;

create function public.set_seller_identity_details(
  p_first text, p_last text, p_email text, p_phone text, p_address text, p_country text,
  p_pan text, p_id_type text, p_id_number text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid   uuid := (select auth.uid());
  v_first text := btrim(coalesce(p_first, ''));
  v_last  text := btrim(coalesce(p_last, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[\s-]', '', 'g');
  v_addr  text := btrim(coalesce(p_address, ''));
  v_pan   text := upper(btrim(coalesce(p_pan, '')));
  v_type  text := lower(btrim(coalesce(p_id_type, '')));
  v_num   text := upper(regexp_replace(coalesce(p_id_number, ''), '[\s-]', '', 'g'));
  v_old   boolean;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if v_phone ~ '^\+91[0-9]{10}$' then v_phone := substr(v_phone, 4);
  elsif v_phone ~ '^91[0-9]{10}$' then v_phone := substr(v_phone, 3);
  elsif v_phone ~ '^0[0-9]{10}$' then v_phone := substr(v_phone, 2); end if;

  if v_first = '' or length(v_first) > 60 or v_first ~ '[0-9<>@]' then raise exception using errcode = 'CM077', message = 'invalid_first_name'; end if;
  if v_last  = '' or length(v_last)  > 60 or v_last  ~ '[0-9<>@]' then raise exception using errcode = 'CM077', message = 'invalid_last_name'; end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception using errcode = 'CM077', message = 'invalid_email'; end if;
  if v_phone !~ '^[6-9][0-9]{9}$' then raise exception using errcode = 'CM077', message = 'invalid_phone'; end if;
  if length(v_addr) < 5 or length(v_addr) > 300 or v_addr ~ '[<>]' then raise exception using errcode = 'CM077', message = 'invalid_address'; end if;
  if btrim(coalesce(p_country, 'India')) <> 'India' then raise exception using errcode = 'CM077', message = 'invalid_country'; end if;
  if v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then raise exception using errcode = 'CM077', message = 'invalid_pan'; end if;
  if v_type not in ('aadhaar', 'voter_id', 'passport') then raise exception using errcode = 'CM077', message = 'invalid_id_type'; end if;
  if (v_type = 'aadhaar'  and v_num !~ '^[2-9][0-9]{11}$')
  or (v_type = 'voter_id' and v_num !~ '^[A-Z]{3}[0-9]{7}$')
  or (v_type = 'passport' and v_num !~ '^[A-Z][0-9]{7}$') then
    raise exception using errcode = 'CM077', message = 'invalid_id_number';
  end if;
  if (select count(*) from public.audit_log a
       where a.actor_id = v_uid and a.action = 'seller_identity_set' and a.created_at > now() - interval '24 hours') >= 5 then
    raise exception using errcode = 'CM077', message = 'too_many_changes';
  end if;

  select true into v_old from public.seller_identity_details d where d.user_id = v_uid;
  insert into public.seller_identity_details
    (user_id, legal_first_name, legal_last_name, contact_email, phone_number, street_address, country, pan_number, govt_id_type, govt_id_last4)
  values (v_uid, v_first, v_last, v_email, v_phone, v_addr, 'India', v_pan, v_type, right(v_num, 4))
  on conflict (user_id) do update
    set legal_first_name = excluded.legal_first_name, legal_last_name = excluded.legal_last_name, contact_email = excluded.contact_email,
        phone_number = excluded.phone_number, street_address = excluded.street_address, country = excluded.country,
        pan_number = excluded.pan_number, govt_id_type = excluded.govt_id_type, govt_id_last4 = excluded.govt_id_last4,
        updated_at = now();

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'seller_identity_set', 'user', v_uid,
          jsonb_build_object('pan', left(v_pan, 2) || '******' || right(v_pan, 2), 'govt_id_type', v_type, 'updated', coalesce(v_old, false)));
  return jsonb_build_object('outcome', case when coalesce(v_old, false) then 'updated' else 'saved' end);
end;
$$;
revoke execute on function public.set_seller_identity_details(text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.set_seller_identity_details(text, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- step 2 guard: the UPI function (5.7 body) now needs identity first when the flag is ON
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
  -- direct-UPI: with the flag ON, identity and tax details must be saved BEFORE a UPI ID (step 1 before step 2).
  if private.direct_upi_enabled() and not private.seller_identity_complete(v_uid) then
    raise exception using errcode = 'CM077', message = 'identity_required';
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

-- ---------------------------------------------------------------- direct payment claims
create table public.direct_payment_claims (
  id            uuid primary key default gen_random_uuid(),
  purchase_id   uuid references public.purchases(id) on delete set null,
  buyer_id      uuid not null references auth.users(id) on delete cascade,
  seller_id     uuid not null references auth.users(id) on delete cascade,
  listing_id    uuid not null references public.listings(id) on delete cascade,
  amount_paise  bigint not null check (amount_paise > 0),
  vpa_address   text not null,
  utr           text not null check (utr ~ '^[0-9]{12}$'),
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'expired')),
  reject_reason text check (reject_reason is null or length(reject_reason) <= 200),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  decided_at    timestamptz,
  check (buyer_id <> seller_id),
  check (status <> 'confirmed' or purchase_id is not null)
);
create unique index direct_claims_one_pending_idx on public.direct_payment_claims (buyer_id, listing_id) where status = 'pending';
create unique index direct_claims_utr_idx on public.direct_payment_claims (utr) where status in ('pending', 'confirmed');
create index direct_claims_seller_idx on public.direct_payment_claims (seller_id, status, created_at desc);
create index direct_claims_buyer_idx on public.direct_payment_claims (buyer_id, listing_id, created_at desc);
comment on table public.direct_payment_claims is
  'A buyer paid the seller directly by UPI and submitted the UTR. Only the SELLER can confirm (creating the purchase) or reject. The platform never receives the money. Written only through the claim RPCs.';
alter table public.direct_payment_claims enable row level security;
revoke all on public.direct_payment_claims from anon, authenticated;
grant select on public.direct_payment_claims to authenticated;
create policy "Buyers can view their own claims" on public.direct_payment_claims for select to authenticated using ((select auth.uid()) = buyer_id);
create policy "Sellers can view claims on their listings" on public.direct_payment_claims for select to authenticated using ((select auth.uid()) = seller_id);
create policy "Admins can view claims" on public.direct_payment_claims for select to authenticated using ((select private.is_admin()));

-- shared availability rule: used by the checkout lookup AND by claim submission, so they can never disagree
create function private.direct_target(p_listing uuid, p_buyer uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  l  record;
  a  record;
  v_h integer;
  v_ttl integer;
  v_unlock timestamptz;
  v_p text;
begin
  select x.id, x.title, x.seller_id, x.price, x.status into l from public.listings x where x.id = p_listing;
  if not found or l.status <> 'live' or l.seller_id is null then
    return jsonb_build_object('available', false, 'reason', 'listing_unavailable');
  end if;
  if l.seller_id = p_buyer then
    return jsonb_build_object('available', false, 'reason', 'own_listing');
  end if;
  select p.status into v_p from public.purchases p where p.user_id = p_buyer and p.listing_id = p_listing;
  if found then
    return jsonb_build_object('available', false, 'reason', case when v_p = 'paid' then 'already_purchased' else 'previously_refunded' end);
  end if;
  select acc.vpa_address, acc.status, acc.vpa_changed_at into a from public.seller_payout_accounts acc where acc.user_id = l.seller_id;
  if not found or a.vpa_address is null or a.status <> 'active' or not private.seller_identity_complete(l.seller_id) then
    return jsonb_build_object('available', false, 'reason', 'seller_not_ready');
  end if;
  select c.upi_cooldown_hours, c.claim_ttl_hours into v_h, v_ttl from private.direct_upi_config c where c.id;
  if v_h > 0 and a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => v_h) > now() then
    v_unlock := a.vpa_changed_at + make_interval(hours => v_h);
    return jsonb_build_object('available', false, 'reason', 'upi_in_cooldown', 'unlocks_at', v_unlock);
  end if;
  if round(l.price * 100) < 1 then
    return jsonb_build_object('available', false, 'reason', 'listing_unavailable');
  end if;
  return jsonb_build_object(
    'available', true, 'listing_id', l.id, 'title', l.title, 'seller_id', l.seller_id,
    'amount_paise', round(l.price * 100)::bigint, 'vpa', a.vpa_address,
    'payee_name', coalesce((select pr.display_name from public.profiles pr where pr.id = l.seller_id), 'Seller'),
    'claim_ttl_hours', v_ttl);
end;
$$;
revoke execute on function private.direct_target(uuid, uuid) from public, anon, authenticated, service_role;

create function public.get_direct_payment_target(p_listing_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_t   jsonb;
  v_c   jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if not private.direct_upi_enabled() then
    return jsonb_build_object('enabled', false);
  end if;
  v_t := private.direct_target(p_listing_id, v_uid);
  select jsonb_build_object('id', c.id, 'status', c.status, 'created_at', c.created_at, 'expires_at', c.expires_at,
                            'overdue', c.status = 'pending' and c.expires_at < now(), 'reject_reason', c.reject_reason)
    into v_c
    from public.direct_payment_claims c
   where c.buyer_id = v_uid and c.listing_id = p_listing_id
   order by c.created_at desc limit 1;
  return jsonb_build_object('enabled', true) || v_t || jsonb_build_object('claim', v_c);
end;
$$;
revoke execute on function public.get_direct_payment_target(uuid) from public, anon;
grant execute on function public.get_direct_payment_target(uuid) to authenticated;

create function public.submit_direct_payment_claim(p_listing_id uuid, p_utr text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_utr text := regexp_replace(coalesce(p_utr, ''), '\s', '', 'g');
  v_t   jsonb;
  v_id  uuid;
  v_exp timestamptz;
  v_idx text;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if not private.direct_upi_enabled() then
    raise exception using errcode = 'CM078', message = 'feature_off';
  end if;
  if v_utr !~ '^[0-9]{12}$' then
    raise exception using errcode = 'CM078', message = 'invalid_utr';
  end if;
  if (select count(*) from public.direct_payment_claims c where c.buyer_id = v_uid and c.created_at > now() - interval '24 hours') >= 10 then
    raise exception using errcode = 'CM078', message = 'too_many_claims';
  end if;
  v_t := private.direct_target(p_listing_id, v_uid);
  if not (v_t->>'available')::boolean then
    raise exception using errcode = 'CM078', message = v_t->>'reason';
  end if;

  -- a pending claim older than its window no longer blocks a new one: it is closed as expired
  update public.direct_payment_claims c set status = 'expired', decided_at = now()
   where c.buyer_id = v_uid and c.listing_id = p_listing_id and c.status = 'pending' and c.expires_at < now();

  v_exp := now() + make_interval(hours => (v_t->>'claim_ttl_hours')::integer);
  begin
    insert into public.direct_payment_claims (buyer_id, seller_id, listing_id, amount_paise, vpa_address, utr, expires_at)
    values (v_uid, (v_t->>'seller_id')::uuid, p_listing_id, (v_t->>'amount_paise')::bigint, v_t->>'vpa', v_utr, v_exp)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_idx = constraint_name;
    if v_idx = 'direct_claims_one_pending_idx' then
      raise exception using errcode = 'CM078', message = 'claim_already_pending';
    end if;
    raise exception using errcode = 'CM078', message = 'utr_already_used';
  end;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_claim_submitted', 'listing', p_listing_id,
          jsonb_build_object('claim_id', v_id, 'amount_paise', (v_t->>'amount_paise')::bigint, 'utr_last4', right(v_utr, 4)));
  return jsonb_build_object('claim_id', v_id, 'status', 'pending', 'expires_at', v_exp);
end;
$$;
revoke execute on function public.submit_direct_payment_claim(uuid, text) from public, anon;
grant execute on function public.submit_direct_payment_claim(uuid, text) to authenticated;

-- confirm / reject work even if the flag is later switched OFF, so a claim already submitted is never stranded
create function public.confirm_direct_payment_claim(p_claim_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  c     public.direct_payment_claims%rowtype;
  v_purchase uuid;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  select * into c from public.direct_payment_claims x where x.id = p_claim_id and x.seller_id = v_uid for update;
  if not found then
    raise exception using errcode = 'CM078', message = 'claim_not_found';
  end if;
  if c.status = 'confirmed' then
    return jsonb_build_object('outcome', 'already_confirmed', 'purchase_id', c.purchase_id);
  end if;
  if c.status <> 'pending' then
    raise exception using errcode = 'CM078', message = 'claim_not_pending';
  end if;
  if exists (select 1 from public.purchases p where p.user_id = c.buyer_id and p.listing_id = c.listing_id) then
    raise exception using errcode = 'CM078', message = 'buyer_already_owns';
  end if;
  insert into public.purchases (user_id, listing_id, amount, status, payment_method, razorpay_payment_id, platform_fee)
  values (c.buyer_id, c.listing_id, c.amount_paise::numeric / 100, 'paid', 'direct_upi', 'direct_upi_' || c.utr, 0)
  returning id into v_purchase;
  update public.direct_payment_claims set status = 'confirmed', purchase_id = v_purchase, decided_at = now() where id = c.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_claim_confirmed', 'listing', c.listing_id,
          jsonb_build_object('claim_id', c.id, 'purchase_id', v_purchase, 'amount_paise', c.amount_paise, 'utr_last4', right(c.utr, 4)));
  return jsonb_build_object('outcome', 'confirmed', 'purchase_id', v_purchase);
end;
$$;
revoke execute on function public.confirm_direct_payment_claim(uuid) from public, anon;
grant execute on function public.confirm_direct_payment_claim(uuid) to authenticated;

create function public.reject_direct_payment_claim(p_claim_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  c public.direct_payment_claims%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if v_reason is not null and length(v_reason) > 200 then
    raise exception using errcode = 'CM078', message = 'reason_too_long';
  end if;
  select * into c from public.direct_payment_claims x where x.id = p_claim_id and x.seller_id = v_uid for update;
  if not found then
    raise exception using errcode = 'CM078', message = 'claim_not_found';
  end if;
  if c.status = 'rejected' then
    return jsonb_build_object('outcome', 'already_rejected');
  end if;
  if c.status <> 'pending' then
    raise exception using errcode = 'CM078', message = 'claim_not_pending';
  end if;
  update public.direct_payment_claims set status = 'rejected', reject_reason = v_reason, decided_at = now() where id = c.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_claim_rejected', 'listing', c.listing_id, jsonb_build_object('claim_id', c.id, 'utr_last4', right(c.utr, 4)));
  return jsonb_build_object('outcome', 'rejected');
end;
$$;
revoke execute on function public.reject_direct_payment_claim(uuid, text) from public, anon;
grant execute on function public.reject_direct_payment_claim(uuid, text) to authenticated;

create function public.seller_direct_claims(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = 'CM078', message = 'invalid_limit';
  end if;
  select coalesce(jsonb_agg(q.r order by q.sort_pending desc, q.created_at desc), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', c.id, 'listing_id', c.listing_id, 'listing_title', l.title,
               'buyer_name', coalesce(pr.display_name, 'Buyer'), 'amount_paise', c.amount_paise, 'utr', c.utr,
               'status', c.status, 'overdue', c.status = 'pending' and c.expires_at < now(),
               'created_at', c.created_at, 'expires_at', c.expires_at, 'decided_at', c.decided_at, 'reject_reason', c.reject_reason) as r,
             (c.status = 'pending') as sort_pending, c.created_at
        from public.direct_payment_claims c
        join public.listings l on l.id = c.listing_id
        left join public.profiles pr on pr.id = c.buyer_id
       where c.seller_id = v_uid
       order by (c.status = 'pending') desc, c.created_at desc
       limit p_limit) q;
  return jsonb_build_object('claims', v_rows,
    'pending_count', (select count(*) from public.direct_payment_claims c where c.seller_id = v_uid and c.status = 'pending'));
end;
$$;
revoke execute on function public.seller_direct_claims(integer) from public, anon;
grant execute on function public.seller_direct_claims(integer) to authenticated;

create function public.my_direct_seller_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  a record;
  v_h integer;
  v_unlock timestamptz;
  v_identity boolean;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  v_identity := private.seller_identity_complete(v_uid);
  select acc.vpa_address, acc.status, acc.vpa_changed_at into a from public.seller_payout_accounts acc where acc.user_id = v_uid;
  select c.upi_cooldown_hours into v_h from private.direct_upi_config c where c.id;
  if found and a.vpa_changed_at is not null and v_h > 0 and a.vpa_changed_at + make_interval(hours => v_h) > now() then
    v_unlock := a.vpa_changed_at + make_interval(hours => v_h);
  end if;
  return jsonb_build_object(
    'flag_on', private.direct_upi_enabled(), 'identity_complete', v_identity,
    'has_upi', a.vpa_address is not null, 'upi_active', coalesce(a.status = 'active', false),
    'upi_unlocks_at', v_unlock, 'upi_cooldown_hours', v_h);
end;
$$;
revoke execute on function public.my_direct_seller_status() from public, anon;
grant execute on function public.my_direct_seller_status() to authenticated;

-- ---------------------------------------------------------------- listing gate (server-side; only when the flag is ON)
create function private.require_seller_ready()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  a record;
  v_h integer;
begin
  if not private.direct_upi_enabled() or (select auth.uid()) is null or new.seller_id is distinct from (select auth.uid()) then
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
revoke execute on function private.require_seller_ready() from public, anon, authenticated, service_role;
create trigger listings_require_seller_ready before insert on public.listings
  for each row execute function private.require_seller_ready();

-- ---------------------------------------------------------------- direct sales never enter the monthly settlement
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
     and p.razorpay_payment_id is not null
     and l.seller_id is not null
     and p.purchased_at >= c.start_at
     and p.purchased_at < p_period_end
     and round(coalesce(p.platform_fee, 0) * 100) < round(p.amount * 100)
     and not exists (select 1 from public.purchase_settlements s where s.purchase_id = p.id)
     and not exists (select 1 from public.transfers t where t.purchase_id = p.id)      -- retired Route flow: never pay a sale twice
     and not exists (select 1 from public.vpa_payouts v where v.purchase_id = p.id);   -- retired instant-UPI flow
$$;
