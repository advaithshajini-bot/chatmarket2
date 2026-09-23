-- Migration: add_execution_columns_and_l2_trigger
--
-- Chatmarket 2.0 Phase 3.1 (architecture v8 §2 frozen configuration; v9/v10
-- Correction A, layer L2).
--
-- Purely additive:
--   * runs.execution_config  jsonb, NULLable -- the frozen, validated
--     configuration snapshot taken at run creation. NULLable only so this
--     migration needs no backfill (the table is empty); the L2 trigger below
--     rejects any NEW row without one.
--   * run_steps.retry_count  integer NOT NULL DEFAULT 0 -- BOTH the retry
--     counter and the fencing token (v8). Every existing row (none) and every
--     new row starts at 0.
--
-- L2 MECHANISM (decision D-3, chosen here): a BEFORE INSERT / BEFORE UPDATE
-- OF execution_config trigger on public.runs that calls the single SQL
-- assertion. Reasons: it covers EVERY write path into `runs` (the run-creation
-- function, and any direct privileged insert) rather than only one function,
-- which is the "neither side trusts the other" principle already stated in
-- lib/validation/shared.js; and triggers are already the repository's
-- convention (set_updated_at). The invariants, not the mechanism, are the
-- architectural commitment.
--
-- The same trigger enforces immutability: once written, execution_config can
-- never be changed (v8 §2 "written once ... and never updated again").
--
-- The trigger function is SECURITY DEFINER so it works no matter which role
-- performs the write (service_role has no USAGE on schema `private`).

alter table public.runs
  add column execution_config jsonb;

alter table public.run_steps
  add column retry_count integer not null default 0
    check (retry_count >= 0);

comment on column public.runs.execution_config is
  'Frozen validated listing configuration snapshot taken at run creation. Written once, never updated (enforced by trigger). Execution reads this, never listings.configuration.';
comment on column public.run_steps.retry_count is
  'Retry counter AND fencing token. Incremented only by private.retry_or_fail_step().';

create function private.runs_enforce_execution_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- L2: reject (never clamp) any configuration that exceeds a system
    -- ceiling, or that is missing/ill-typed (fail closed).
    perform private.assert_execution_config_within_ceilings(new.execution_config);
  elsif new.execution_config is distinct from old.execution_config then
    raise exception using errcode = 'CM003', message = 'execution_config_immutable';
  end if;
  return new;
end;
$$;

revoke execute on function private.runs_enforce_execution_config()
  from public, anon, authenticated, service_role;

create trigger runs_enforce_execution_config
  before insert or update of execution_config on public.runs
  for each row execute function private.runs_enforce_execution_config();
