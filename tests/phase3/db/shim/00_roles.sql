-- Local Supabase-equivalent role setup (cluster level). Mirrors live-measured attributes:
--   postgres(non-super, bypassrls) -> here named mig_owner; service_role bypassrls; anon/authenticated plain.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon')          then create role anon login; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated login; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')  then create role service_role login bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='mig_owner')     then create role mig_owner login bypassrls createrole createdb; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
drop database if exists cm;
create database cm owner mig_owner;
