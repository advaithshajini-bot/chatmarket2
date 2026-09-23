-- Migration: create_private_feature_flags
--
-- Chatmarket 2.0 Phase 3.1 (architecture v10, "Preserved": fail-closed
-- private.feature_flags check; feature OFF after 3.1).
--
-- Additive: one new table in the `private` schema and one helper function.
-- Nothing existing is modified.
--
-- Why a table and not `ALTER DATABASE ... SET`: verified against the real
-- hosted project in the v5 round -- ALTER DATABASE SET for a custom GUC is
-- permission-denied there.
--
-- Fail-closed: the check returns true ONLY when the row exists AND is
-- explicitly enabled. A missing row, a NULL, or any lookup problem yields
-- false (COALESCE(..., false) IS TRUE -- never NULL, so a NULL can never be
-- mistaken for "enabled" in a caller's boolean logic).
--
-- The seeded row is OFF. This migration does NOT enable execution and no
-- code path in the repository turns the flag on; activation is a manual,
-- explicitly approved step (v10 §6 known limitation).

create table private.feature_flags (
  name text primary key,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table private.feature_flags enable row level security;

-- No policies (RLS denies everything to non-owner roles) AND no table
-- privileges for any client or service role. Only the owner role can read
-- or change a flag.
revoke all on table private.feature_flags from public, anon, authenticated, service_role;

insert into private.feature_flags (name, enabled) values ('phase3_execution', false);

create function private.is_execution_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select f.enabled from private.feature_flags f where f.name = 'phase3_execution'),
    false
  ) is true;
$$;

-- Internal function: not callable by any client role, and not granted to
-- service_role either. It is reached only from other owner-context
-- (SECURITY DEFINER) functions.
revoke execute on function private.is_execution_enabled() from public, anon, authenticated, service_role;
