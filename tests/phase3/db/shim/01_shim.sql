-- Run as postgres superuser inside db cm: auth schema + public/private schemas + default privileges.
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
-- Like Supabase's auth.uid(): reads the JSON claims set by PostgREST (request.jwt.claims) or the legacy single-claim GUC.
create function auth.uid() returns uuid language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                     nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

alter schema public owner to mig_owner;
grant usage on schema public to anon, authenticated, service_role;
create schema private authorization mig_owner;      -- NO usage granted to client roles (matches live)

-- Live default privileges (measured): postgres in schema public grants ALL on tables/functions/sequences
-- to anon, authenticated, service_role. Nothing for schema private.
alter default privileges for role mig_owner in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role mig_owner in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role mig_owner in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema auth to mig_owner; grant references, select on auth.users to mig_owner; grant execute on function auth.uid(), auth.role() to mig_owner;
