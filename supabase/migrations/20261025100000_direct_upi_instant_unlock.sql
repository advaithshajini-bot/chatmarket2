-- Direct UPI payments, change 2 (flag `direct_upi_checkout` stays OFF until you flip it). ADDITIVE.
--
-- The buyer's UTR now unlocks the purchase INSTANTLY (no seller confirmation). A seller who did not receive the money reports it,
-- and a chatmarket ADMIN (with MFA) decides: payment verified (access stays) or not verified (access removed).
--
--   * claims.status gains 'disputed' (seller reported a problem, awaiting admin) and 'revoked' (admin: payment not verified, access removed)
--   * claims gain dispute/resolution columns; private.direct_upi_config gains dispute_window_days (default 30)
--   * submit_direct_payment_claim REPLACED: validates, then creates the purchase AND a 'confirmed' claim in one step
--   * raise_direct_payment_dispute (seller), admin_direct_claims + admin_resolve_direct_dispute (admin + MFA)
--   * seller_direct_claims and private.direct_target REPLACED (new fields / 'payment_revoked' reason)
--   * confirm/reject_direct_payment_claim are KEPT for any claim that was already pending; the app no longer creates pending claims.
-- Rollback: update private.feature_flags set enabled = false where name = 'direct_upi_checkout';  (nothing is dropped)

alter table public.direct_payment_claims drop constraint direct_payment_claims_status_check;
alter table public.direct_payment_claims add constraint direct_payment_claims_status_check
  check (status in ('pending', 'confirmed', 'rejected', 'expired', 'disputed', 'revoked'));
alter table public.direct_payment_claims
  add column dispute_reason  text check (dispute_reason is null or length(dispute_reason) between 10 and 500),
  add column disputed_at     timestamptz,
  add column resolution      text check (resolution is null or resolution in ('upheld', 'revoked')),
  add column resolution_note text check (resolution_note is null or length(resolution_note) <= 500),
  add column resolved_by     uuid references auth.users(id) on delete set null,
  add column resolved_at     timestamptz;
alter table public.direct_payment_claims
  add constraint direct_claims_dispute_chk check (status not in ('disputed', 'revoked') or (dispute_reason is not null and disputed_at is not null and purchase_id is not null));

-- a UTR stays locked once used, even if the claim is disputed or revoked (it can never pay for a second listing)
drop index public.direct_claims_utr_idx;
create unique index direct_claims_utr_idx on public.direct_payment_claims (utr) where status not in ('rejected', 'expired');

alter table private.direct_upi_config add column dispute_window_days integer not null default 30 check (dispute_window_days between 1 and 365);
comment on column private.direct_upi_config.dispute_window_days is 'A seller can report a payment as not received for this many days after the claim.';

create or replace function private.direct_target(p_listing uuid, p_buyer uuid)
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
    return jsonb_build_object('available', false, 'reason',
      case when v_p = 'paid' then 'already_purchased'
           when exists (select 1 from public.direct_payment_claims c where c.buyer_id = p_buyer and c.listing_id = p_listing and c.status = 'revoked') then 'payment_revoked'
           else 'previously_refunded' end);
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

-- ---------------------------------------------------------------- instant unlock
create or replace function public.submit_direct_payment_claim(p_listing_id uuid, p_utr text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_utr text := regexp_replace(coalesce(p_utr, ''), '\s', '', 'g');
  v_t   jsonb;
  v_id  uuid;
  v_purchase uuid;
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

  begin
    insert into public.purchases (user_id, listing_id, amount, status, payment_method, razorpay_payment_id, platform_fee)
    values (v_uid, p_listing_id, (v_t->>'amount_paise')::bigint::numeric / 100, 'paid', 'direct_upi', 'direct_upi_' || v_utr, 0)
    returning id into v_purchase;
    insert into public.direct_payment_claims (purchase_id, buyer_id, seller_id, listing_id, amount_paise, vpa_address, utr, status, expires_at, decided_at)
    values (v_purchase, v_uid, (v_t->>'seller_id')::uuid, p_listing_id, (v_t->>'amount_paise')::bigint, v_t->>'vpa', v_utr, 'confirmed', now(), now())
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_idx = constraint_name;
    if v_idx = 'purchases_user_id_listing_id_key' then
      raise exception using errcode = 'CM078', message = 'already_purchased';
    end if;
    raise exception using errcode = 'CM078', message = 'utr_already_used';
  end;

  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_claim_unlocked', 'listing', p_listing_id,
          jsonb_build_object('claim_id', v_id, 'purchase_id', v_purchase, 'amount_paise', (v_t->>'amount_paise')::bigint, 'utr_last4', right(v_utr, 4)));
  return jsonb_build_object('claim_id', v_id, 'status', 'confirmed', 'purchase_id', v_purchase);
end;
$$;

-- ---------------------------------------------------------------- seller reports "not received"
create function public.raise_direct_payment_dispute(p_claim_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_reason text := btrim(coalesce(p_reason, ''));
  v_days integer;
  c public.direct_payment_claims%rowtype;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception using errcode = 'CM078', message = 'invalid_reason';
  end if;
  if (select count(*) from public.audit_log a where a.actor_id = v_uid and a.action = 'direct_claim_disputed' and a.created_at > now() - interval '24 hours') >= 20 then
    raise exception using errcode = 'CM078', message = 'too_many_reports';
  end if;
  select * into c from public.direct_payment_claims x where x.id = p_claim_id and x.seller_id = v_uid for update;
  if not found then
    raise exception using errcode = 'CM078', message = 'claim_not_found';
  end if;
  if c.status = 'disputed' then
    return jsonb_build_object('outcome', 'already_reported');
  end if;
  if c.status <> 'confirmed' or c.resolved_at is not null then
    raise exception using errcode = 'CM078', message = 'claim_not_reportable';
  end if;
  select d.dispute_window_days into v_days from private.direct_upi_config d where d.id;
  if c.created_at < now() - make_interval(days => v_days) then
    raise exception using errcode = 'CM078', message = 'report_window_passed';
  end if;
  update public.direct_payment_claims set status = 'disputed', dispute_reason = v_reason, disputed_at = now() where id = c.id;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_claim_disputed', 'listing', c.listing_id, jsonb_build_object('claim_id', c.id, 'utr_last4', right(c.utr, 4)));
  return jsonb_build_object('outcome', 'reported');
end;
$$;
revoke execute on function public.raise_direct_payment_dispute(uuid, text) from public, anon;
grant execute on function public.raise_direct_payment_dispute(uuid, text) to authenticated;

-- ---------------------------------------------------------------- admin desk (admin + MFA)
create function public.admin_direct_claims(p_status text default 'disputed', p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_status not in ('disputed', 'revoked', 'confirmed', 'all') or p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = 'CM078', message = 'invalid_filter';
  end if;
  select coalesce(jsonb_agg(q.r order by q.t desc), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', c.id, 'status', c.status, 'listing_id', c.listing_id, 'listing_title', l.title,
               'seller_id', c.seller_id, 'seller_name', coalesce(sp.display_name, 'Seller'), 'seller_vpa', c.vpa_address,
               'buyer_id', c.buyer_id, 'buyer_name', coalesce(bp.display_name, 'Buyer'),
               'amount_paise', c.amount_paise, 'utr', c.utr, 'created_at', c.created_at,
               'dispute_reason', c.dispute_reason, 'disputed_at', c.disputed_at,
               'resolution', c.resolution, 'resolution_note', c.resolution_note, 'resolved_at', c.resolved_at) as r,
             coalesce(c.disputed_at, c.created_at) as t
        from public.direct_payment_claims c
        join public.listings l on l.id = c.listing_id
        left join public.profiles sp on sp.id = c.seller_id
        left join public.profiles bp on bp.id = c.buyer_id
       where (p_status = 'all' and c.status in ('confirmed', 'disputed', 'revoked')) or c.status = p_status
       order by coalesce(c.disputed_at, c.created_at) desc
       limit p_limit) q;
  return jsonb_build_object('claims', v_rows,
    'disputed_count', (select count(*) from public.direct_payment_claims c where c.status = 'disputed'));
end;
$$;
revoke execute on function public.admin_direct_claims(text, integer) from public, anon;
grant execute on function public.admin_direct_claims(text, integer) to authenticated;

create function public.admin_resolve_direct_dispute(p_claim_id uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  c public.direct_payment_claims%rowtype;
begin
  if not (select private.is_admin_mfa()) then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  if p_decision not in ('upheld', 'revoked') or (v_note is not null and length(v_note) > 500) then
    raise exception using errcode = 'CM078', message = 'invalid_decision';
  end if;
  select * into c from public.direct_payment_claims x where x.id = p_claim_id for update;
  if not found then
    raise exception using errcode = 'CM078', message = 'claim_not_found';
  end if;
  if c.status <> 'disputed' then
    raise exception using errcode = 'CM078', message = 'claim_not_disputed';
  end if;
  if p_decision = 'upheld' then
    -- the payment is accepted as genuine: access stays, and the seller cannot report this claim again
    update public.direct_payment_claims set status = 'confirmed', resolution = 'upheld', resolution_note = v_note, resolved_by = v_uid, resolved_at = now() where id = c.id;
  else
    -- payment not verified: access is removed (the purchase stops being 'paid'); the UTR stays locked
    update public.purchases set status = 'refunded' where id = c.purchase_id;
    update public.direct_payment_claims set status = 'revoked', resolution = 'revoked', resolution_note = v_note, resolved_by = v_uid, resolved_at = now() where id = c.id;
  end if;
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (v_uid, 'direct_dispute_resolved', 'listing', c.listing_id, jsonb_build_object('claim_id', c.id, 'decision', p_decision, 'utr_last4', right(c.utr, 4)));
  return jsonb_build_object('outcome', p_decision);
end;
$$;
revoke execute on function public.admin_resolve_direct_dispute(uuid, text, text) from public, anon;
grant execute on function public.admin_resolve_direct_dispute(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- seller desk: new fields
create or replace function public.seller_direct_claims(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rows jsonb;
  v_days integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception using errcode = 'CM078', message = 'invalid_limit';
  end if;
  select d.dispute_window_days into v_days from private.direct_upi_config d where d.id;
  select coalesce(jsonb_agg(q.r order by q.sort_open desc, q.created_at desc), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'id', c.id, 'listing_id', c.listing_id, 'listing_title', l.title,
               'buyer_name', coalesce(pr.display_name, 'Buyer'), 'amount_paise', c.amount_paise, 'utr', c.utr,
               'status', c.status, 'overdue', c.status = 'pending' and c.expires_at < now(),
               'created_at', c.created_at, 'expires_at', c.expires_at, 'decided_at', c.decided_at, 'reject_reason', c.reject_reason,
               'can_report', c.status = 'confirmed' and c.resolved_at is null and c.created_at >= now() - make_interval(days => v_days),
               'dispute_reason', c.dispute_reason, 'resolution', c.resolution, 'resolution_note', c.resolution_note) as r,
             (c.status in ('pending', 'disputed')) as sort_open, c.created_at
        from public.direct_payment_claims c
        join public.listings l on l.id = c.listing_id
        left join public.profiles pr on pr.id = c.buyer_id
       where c.seller_id = v_uid
       order by (c.status in ('pending', 'disputed')) desc, c.created_at desc
       limit p_limit) q;
  return jsonb_build_object('claims', v_rows,
    'pending_count', (select count(*) from public.direct_payment_claims c where c.seller_id = v_uid and c.status = 'pending'),
    'disputed_count', (select count(*) from public.direct_payment_claims c where c.seller_id = v_uid and c.status = 'disputed'));
end;
$$;
