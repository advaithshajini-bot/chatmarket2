-- SCRATCH-ONLY stand-in for the Phase 1-3 objects that migrations 100400-100700 depend on.
-- NOT a copy of the real schema (it was not in the handoff zip): only the columns/functions those migrations
-- and the M4.4 tests touch. Never run against the real project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
grant anon, authenticated, service_role to current_user;
create schema auth; create schema private; create schema storage;
grant usage on schema public, auth, storage, private to anon, authenticated, service_role;

create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;

create table public.profiles (id uuid primary key references auth.users(id), is_admin boolean not null default false);
create function public.profiles_autocreate() returns trigger language plpgsql as $$ begin insert into public.profiles(id) values (new.id) on conflict do nothing; return new; end $$;
create trigger t_prof after insert on auth.users for each row execute function public.profiles_autocreate();

create function private.is_admin() returns boolean language sql stable security definer set search_path = '' as
  $$ select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) $$;
create function private.is_admin_mfa() returns boolean language sql stable security definer set search_path = '' as
  $$ select private.is_admin() and coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create table private.feature_flags (name text primary key, enabled boolean not null default false);
insert into private.feature_flags values ('phase3_execution', false);
create function private.is_execution_enabled() returns boolean language sql stable security definer set search_path = '' as
  $$ select coalesce((select enabled from private.feature_flags where name='phase3_execution'), false) $$;
create function private.assert_execution_config_within_ceilings(p jsonb) returns void language sql as $$ select $$;

create table public.listings (
  id uuid primary key default gen_random_uuid(), title text, model text, category text, price numeric default 0,
  seller_name text, seller_id uuid references auth.users(id), status text not null default 'pending_review',
  product_type text not null default 'playbook', configuration jsonb default '{}', description text,
  version integer not null default 1, created_at timestamptz default now());
alter table public.listings enable row level security;
grant select, insert, update, delete on public.listings to authenticated; grant select on public.listings to anon;
create policy "Live listings are publicly readable" on public.listings for select using (status = 'live');
create policy "Sellers read own" on public.listings for select to authenticated using (seller_id = (select auth.uid()));
create policy "Sellers insert own" on public.listings for insert to authenticated with check (seller_id = (select auth.uid()));
create policy "Sellers update own" on public.listings for update to authenticated using (seller_id = (select auth.uid()));
create policy "Admins all" on public.listings for all to authenticated using ((select private.is_admin()));

create table public.purchases (id uuid primary key default gen_random_uuid(), listing_id uuid references public.listings(id), user_id uuid, amount numeric, status text);
alter table public.purchases enable row level security;
create policy "Users read own purchases" on public.purchases for select to authenticated using (user_id = (select auth.uid()));
grant select on public.purchases to authenticated;

create table public.runs (id uuid primary key default gen_random_uuid(), user_id uuid, product_id uuid, product_version integer,
  status text not null default 'queued', cost numeric not null default 0, is_sandbox boolean not null default false,
  input jsonb, execution_config jsonb, error jsonb, created_at timestamptz not null default now());
create table public.run_steps (id uuid primary key default gen_random_uuid(), run_id uuid references public.runs(id) on delete cascade,
  step_index integer, status text, retry_count integer default 0, output jsonb);
alter table public.runs enable row level security;
create function private.owns_product(p uuid) returns boolean language sql stable security definer set search_path='' as
  $$ select exists (select 1 from public.listings l where l.id = p and l.seller_id = auth.uid()) $$;
create function private.can_view_run(check_run_id uuid) returns boolean language sql stable security definer set search_path='' as $$ select false $$;
create policy "Creators can view runs of their own products" on public.runs for select to authenticated using (private.owns_product(product_id));
grant select on public.runs to authenticated;

create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
grant select, insert, delete on storage.objects to authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;

-- stand-in for the pre-existing chat-export bucket + policies that A42-S06/S07 assert are left untouched
insert into storage.buckets (id, name, public) values ('listing-files', 'listing-files', false);
create policy "Sellers can upload their own listing files" on storage.objects for insert to authenticated with check (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can view their own listing files" on storage.objects for select to authenticated using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can delete their own listing files" on storage.objects for delete to authenticated using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Admins can view any listing file" on storage.objects for select to authenticated using (bucket_id = 'listing-files' and (select private.is_admin()));
create policy "Buyers can download files for purchases they made" on storage.objects for select to authenticated using (bucket_id = 'listing-files' and exists (select 1 from public.purchases p where p.listing_id::text = (storage.foldername(name))[2] and p.user_id = (select auth.uid()) and p.status = 'paid'));
