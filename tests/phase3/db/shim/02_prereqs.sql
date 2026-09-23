-- Run as mig_owner in cm: minimal stand-ins for the pre-Phase-1 objects Phase 1 depends on.
create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, is_admin boolean not null default false);
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references auth.users(id),
  title text not null default 'x',
  price numeric not null default 0,
  status text not null default 'pending_review',
  created_at timestamptz not null default now()
);
create table public.purchases (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id), listing_id uuid references public.listings(id), status text not null default 'paid', purchased_at timestamptz not null default now());
alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.purchases enable row level security;

create function private.is_admin() returns boolean language sql stable security definer set search_path = '' as
  $$ select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin) $$;
revoke execute on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

create function private.owns_listing(check_listing_id uuid) returns boolean language sql stable security definer set search_path = '' as
  $$ select exists (select 1 from public.listings l where l.id = check_listing_id and l.seller_id = (select auth.uid())) $$;
revoke execute on function private.owns_listing(uuid) from public, anon;
grant execute on function private.owns_listing(uuid) to authenticated;

create function private.set_updated_at() returns trigger language plpgsql set search_path = '' as
  $$ begin new.updated_at = now(); return new; end; $$;
