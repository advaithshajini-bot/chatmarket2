-- Schema applied to the chatmarket Supabase project, via migrations run in
-- order: init_chatmarket_schema, add_admin_role_and_policies,
-- harden_rls_and_indexes, fix_is_admin_execute_grant,
-- buyer_access_and_reviews, seller_can_view_own_sales,
-- fix_purchases_listings_rls_recursion, add_admin_user_management,
-- fix_protect_is_admin_column_bypass, add_disputes_table,
-- add_listing_screenshots_storage, add_48h_review_gate,
-- remove_48h_gate_and_public_reviews, allow_reviews_without_purchase.
--
-- The final result — not the intermediate steps — is what's below.
-- Re-run this against a fresh project to reproduce the database this app expects.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  model text not null,
  category text not null,
  messages int not null default 0,
  completion int not null default 100,
  price numeric not null,
  rating numeric,
  reviews int not null default 0,
  seller_name text not null,
  seller_id uuid references auth.users(id) on delete set null,
  description text not null default '',
  status text not null default 'pending_review'
    check (status in ('pending_review', 'live', 'flagged', 'removed')),
  preview jsonb not null default '[]'::jsonb,
  thread jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  amount numeric not null,
  payment_method text not null default 'upi',
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  purchased_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Private helper for admin checks: SECURITY DEFINER so it can read
-- profiles.is_admin without RLS recursion. Only `authenticated` may call it —
-- policies evaluate in the caller's role, so this grant is required even
-- though the function itself runs with elevated privileges internally.
create schema if not exists private;

create function private.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

revoke execute on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.purchases enable row level security;

create policy "Profiles are publicly readable" on public.profiles
  for select to anon, authenticated using (true);

create policy "Users can update their own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id);

create policy "Live listings are publicly readable" on public.listings
  for select to anon, authenticated using (status = 'live');

create policy "Sellers can view their own listings regardless of status" on public.listings
  for select to authenticated using ((select auth.uid()) = seller_id);

create policy "Admins can view all listings" on public.listings
  for select to authenticated using ((select private.is_admin()));

create policy "Authenticated users can create their own listings" on public.listings
  for insert to authenticated with check ((select auth.uid()) = seller_id);

create policy "Admins can update any listing" on public.listings
  for update to authenticated using ((select private.is_admin()));

create policy "Users can view their own purchases" on public.purchases
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Users can create their own purchases" on public.purchases
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Postgres doesn't auto-index foreign key columns; these are read on every
-- RLS check above.
create index listings_seller_id_idx on public.listings (seller_id);
create index listings_status_idx on public.listings (status);
create index purchases_user_id_idx on public.purchases (user_id);
create index purchases_listing_id_idx on public.purchases (listing_id);

-- Added in a later migration (buyer_access_and_reviews): a buyer keeps read
-- access to a listing's full content even if it's later flagged/removed by
-- moderation, since they already paid for it.
create policy "Buyers can view listings they've purchased" on public.listings
  for select to authenticated
  using (
    exists (
      select 1 from public.purchases pu
      where pu.listing_id = listings.id
        and pu.user_id = (select auth.uid())
    )
  );

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  -- Nullable as of allow_reviews_without_purchase: a review no longer
  -- requires a real purchase. Still linked to one when the reviewer
  -- genuinely has it (powers a "Verified buyer" badge); RLS below prevents
  -- linking someone else's purchase to spoof that badge.
  purchase_id uuid unique references public.purchases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  -- Added in allow_reviews_without_purchase: without the purchase
  -- requirement, the old natural one-review-per-purchase limit disappears
  -- too. This replaces it with an explicit one-review-per-listing limit
  -- per user, purchased or not.
  constraint reviews_listing_user_unique unique (listing_id, user_id)
);

alter table public.reviews enable row level security;

create policy "Users can view their own reviews" on public.reviews
  for select to authenticated using ((select auth.uid()) = user_id);

-- Added in a later migration (remove_48h_gate_and_public_reviews): reviews
-- are product info meant to be seen by anyone browsing a listing, not just
-- the person who wrote them -- without this, a random visitor can't see
-- anyone else's review at all, which the listing page's public reviews
-- section needs.
create policy "Anyone can view reviews on live listings" on public.reviews
  for select to public
  using (exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live'));

-- Superseded by "Users can review any live listing" below
-- (allow_reviews_without_purchase) -- kept only as history of how this
-- table's trust model evolved:
--   1. add_admin_role_and_policies-era: a review required a real purchase
--      (the 48h-gated version further required pu.purchased_at <= now() - 48h)
--   2. allow_reviews_without_purchase: purchase requirement dropped
--      entirely -- see the README's "Row Level Security" section for the
--      trust trade-off this makes, and why a "Verified buyer" badge exists
--      to partially compensate for it.
create policy "Users can review any live listing" on public.reviews
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live')
    and (
      purchase_id is null
      or exists (
        select 1 from public.purchases pu
        where pu.id = purchase_id
          and pu.user_id = (select auth.uid())
          and pu.listing_id = reviews.listing_id
      )
    )
  );

create index reviews_user_id_idx on public.reviews (user_id);
create index reviews_listing_id_idx on public.reviews (listing_id);

-- Added in later migrations (seller_can_view_own_sales, then
-- fix_purchases_listings_rls_recursion): sellers need to see purchases of
-- listings they own, to compute earnings. The naive version of this policy
-- (a plain subquery on public.listings) caused infinite recursion, because
-- listings' own "Buyers can view listings they've purchased" policy queries
-- purchases right back. Fixed with a SECURITY DEFINER helper that bypasses
-- RLS for just this internal ownership check.
create function private.owns_listing(check_listing_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.listings l
    where l.id = check_listing_id
      and l.seller_id = (select auth.uid())
  );
$$;

revoke execute on function private.owns_listing(uuid) from public, anon, authenticated;
grant execute on function private.owns_listing(uuid) to authenticated;

create policy "Sellers can view purchases of their own listings" on public.purchases
  for select to authenticated
  using ((select private.owns_listing(purchases.listing_id)));

-- Added for the admin "user management" UI (grant/revoke is_admin from the
-- app instead of only via the SQL editor). Two parts, added together:
--
-- 1. A policy letting admins update any profile (the existing
--    "Users can update their own profile" policy is scoped to auth.uid() = id).
-- 2. A trigger closing a real privilege-escalation hole: without it, that
--    self-update policy has no column restriction, so any logged-in user
--    could run `update profiles set is_admin = true where id = auth.uid()`
--    from the client and grant themselves admin. A trigger is needed (not a
--    WITH CHECK) because WITH CHECK only sees the new row, not the old one,
--    so it can't tell whether is_admin actually changed on its own.
--
-- The trigger only intervenes for requests carrying an end-user JWT
-- (auth.uid() is not null); direct SQL-editor / service-role updates (no
-- JWT context) are left alone, so the original "grant admin via SQL editor"
-- workflow still works.
create function private.protect_is_admin_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_admin is distinct from old.is_admin
     and (select auth.uid()) is not null
     and not (select private.is_admin())
  then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

create trigger protect_is_admin_column
  before update on public.profiles
  for each row execute procedure private.protect_is_admin_column();

create policy "Admins can update any profile" on public.profiles
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- Real disputes table, replacing lib/admin-data.js's mock INITIAL_DISPUTES
-- (that file has been deleted). One dispute per purchase. listing_id and
-- seller_id are denormalized from the purchase's listing at filing time so
-- admin/seller views don't need extra joins and keep working even if the
-- listing is later removed.
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid references auth.users(id) on delete set null,
  reason text not null,
  status text not null default 'open'
    check (status in ('open', 'resolved_refunded', 'resolved_denied')),
  resolution_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.disputes enable row level security;

create policy "Buyers can view their own disputes" on public.disputes
  for select to authenticated using ((select auth.uid()) = buyer_id);

create policy "Buyers can file a dispute on their own paid purchase" on public.disputes
  for insert to authenticated
  with check (
    (select auth.uid()) = buyer_id
    and exists (
      select 1 from public.purchases pu
      where pu.id = purchase_id
        and pu.user_id = (select auth.uid())
        and pu.status = 'paid'
    )
  );

-- Reuses the same SECURITY DEFINER ownership check already relied on by
-- purchases' seller policy, to avoid the recursion bug documented above.
create policy "Sellers can view disputes on their own listings" on public.disputes
  for select to authenticated using ((select private.owns_listing(disputes.listing_id)));

create policy "Admins can view all disputes" on public.disputes
  for select to authenticated using ((select private.is_admin()));

-- No direct client-side UPDATE policy: resolution goes through
-- resolve_dispute() below so the dispute row and the linked purchase's
-- refund status change together or not at all.

create index disputes_buyer_id_idx on public.disputes (buyer_id);
create index disputes_listing_id_idx on public.disputes (listing_id);
create index disputes_status_idx on public.disputes (status);

-- Admin resolution needs to touch two tables atomically: the dispute itself,
-- and (for a refund outcome) the purchase's status. A SECURITY DEFINER RPC
-- does both in one transaction and re-checks admin status server-side
-- (defense in depth beyond just gating the button in the UI).
create function public.resolve_dispute(p_dispute_id uuid, p_outcome text, p_note text default null)
returns public.disputes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dispute public.disputes;
begin
  if not (select private.is_admin()) then
    raise exception 'not authorized';
  end if;

  if p_outcome not in ('resolved_refunded', 'resolved_denied') then
    raise exception 'invalid outcome: %', p_outcome;
  end if;

  select * into v_dispute from public.disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status <> 'open' then
    raise exception 'dispute is already resolved';
  end if;

  update public.disputes
  set status = p_outcome,
      resolution_note = p_note,
      resolved_by = (select auth.uid()),
      resolved_at = now()
  where id = p_dispute_id
  returning * into v_dispute;

  if p_outcome = 'resolved_refunded' then
    update public.purchases set status = 'refunded' where id = v_dispute.purchase_id;
  end if;

  return v_dispute;
end;
$$;

revoke execute on function public.resolve_dispute(uuid, text, text) from public, anon;
grant execute on function public.resolve_dispute(uuid, text, text) to authenticated;

-- Storage for the output-screenshot gallery on a listing (PDF screen s2/b3:
-- "Output images appear in the swipeable gallery buyers see on the thread page").
-- Public bucket: screenshots are marketing/preview material meant to be seen
-- once a listing is browsable, the same way listing rows themselves are
-- publicly readable. Path convention enforced by the upload policy is
-- <seller_id>/<listing_id>/<filename>, so ownership can be checked from the
-- path alone -- no listings-table lookup needed, since the listing row
-- doesn't exist yet at upload time (screenshots are attached during step 1
-- of the wizard, before the listing is created in step 3).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-screenshots', 'listing-screenshots', true, 5242880, array['image/png', 'image/jpeg', 'image/webp']);

create policy "Listing screenshots are publicly readable" on storage.objects
  for select to public
  using (bucket_id = 'listing-screenshots');

create policy "Sellers can upload screenshots into their own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'listing-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Sellers can delete their own screenshots" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'listing-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Admins can delete any screenshot" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-screenshots' and (select private.is_admin()));

-- Where the uploaded URLs get attached once the listing is created.
alter table public.listings add column screenshots jsonb not null default '[]'::jsonb;
