-- SCRATCH-ONLY minimal Supabase stand-ins (roles, auth, storage) so the REAL baseline migration can be applied.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
alter role service_role bypassrls;  -- as on Supabase
grant anon, authenticated, service_role to current_user;
create schema if not exists auth; create schema if not exists storage; create schema if not exists extensions;
-- Supabase's default privileges: every new table in public is granted to anon/authenticated/service_role (RLS is the gate).
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}');
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth, storage to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
-- Supabase grants the storage tables to the API roles (RLS is the gate)
alter default privileges in schema storage grant all on tables to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
create schema if not exists net; create schema if not exists vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
create table net.http_request_queue (id bigserial primary key, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$ insert into net.http_request_queue (url, body, headers) values (url, body, headers) returning id $$;
insert into vault.decrypted_secrets values ('execution_worker_url', 'https://worker.invalid/run'), ('execution_worker_shared_secret', 'scratch-secret');
