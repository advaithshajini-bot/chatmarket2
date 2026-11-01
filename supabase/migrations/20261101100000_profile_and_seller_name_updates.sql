-- Profile auto-provisioning on first sign-in, legal-name support, and public seller names that never show an email address.
-- Additive: one column, helper + trigger function, trigger re-pointed, one RPC replaced. The old public.handle_new_user() is kept (unused).

alter table public.profiles add column if not exists legal_name text check (legal_name is null or length(legal_name) <= 120);

-- Turns anything name-like into something safe to show publicly: an email becomes its part before '@' (dots/underscores/dashes -> spaces); blanks become null.
create or replace function private.safe_public_name(p_name text)
returns text language sql immutable set search_path = ''
as $$
  select nullif(btrim(regexp_replace(case when position('@' in coalesce(p_name, '')) > 0 then split_part(p_name, '@', 1) else coalesce(p_name, '') end, '[._+-]+', ' ', 'g')), '');
$$;
revoke all on function private.safe_public_name(text) from public, anon, authenticated;

-- Every new auth user (email, OTP or OAuth) gets a profile row. The legal name is only taken from a real name the identity provider gave us,
-- never from the email prefix, so it cannot mask a display name the user chooses later.
create or replace function public.handle_new_user_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_legal text;
  v_name text;
begin
  v_legal := private.safe_public_name(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'));
  v_name := coalesce(
    private.safe_public_name(new.raw_user_meta_data->>'display_name'),
    v_legal,
    private.safe_public_name(split_part(coalesce(new.email, ''), '@', 1)),
    'Member');
  insert into public.profiles (id, display_name, legal_name, created_at)
  values (new.id, v_name, v_legal, now())
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user_profile() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

-- Users who signed up while the old trigger was missing or failed get their profile now.
insert into public.profiles (id, display_name, legal_name)
select u.id,
       coalesce(private.safe_public_name(u.raw_user_meta_data->>'display_name'), private.safe_public_name(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name')),
                private.safe_public_name(split_part(coalesce(u.email, ''), '@', 1)), 'Member'),
       private.safe_public_name(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'))
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- Public name order: bank beneficiary (legal name on the payout account) > profiles.legal_name > profiles.display_name; never an email.
create or replace function public.seller_public_profile(p_seller uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_p record;
  v_beneficiary text;
  v_name text;
  v_listings integer;
  v_sales integer;
  v_rating numeric;
  v_reviews integer;
  v_verified boolean;
begin
  select pr.display_name, pr.legal_name, pr.bio, pr.created_at into v_p from public.profiles pr where pr.id = p_seller;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select a.bank_beneficiary_name into v_beneficiary from public.seller_payout_accounts a where a.user_id = p_seller;
  v_name := coalesce(private.safe_public_name(v_beneficiary), private.safe_public_name(v_p.legal_name), private.safe_public_name(v_p.display_name), 'Verified Creator');
  select count(*)::integer into v_listings from public.listings l where l.seller_id = p_seller and l.status = 'live';
  select count(*)::integer into v_sales from public.purchases pu join public.listings l on l.id = pu.listing_id
   where l.seller_id = p_seller and pu.status = 'paid';
  select round(avg(r.rating)::numeric, 1), count(*)::integer into v_rating, v_reviews
    from public.reviews r join public.listings l on l.id = r.listing_id where l.seller_id = p_seller;
  select exists (select 1 from public.seller_payout_accounts a where a.user_id = p_seller and a.status = 'active'
                  and ((a.bank_account_number is not null and a.bank_ifsc is not null) or a.route_status = 'activated'))
    into v_verified;
  return jsonb_build_object('found', true, 'display_name', v_name, 'bio', v_p.bio, 'joined_at', v_p.created_at,
                            'listing_count', v_listings, 'sales_count', v_sales, 'avg_rating', v_rating, 'review_count', v_reviews, 'verified', v_verified);
end;
$$;
revoke all on function public.seller_public_profile(uuid) from public;
grant execute on function public.seller_public_profile(uuid) to anon, authenticated;
