-- Migration: add_approval_schema_and_flag   (Phase 4 / Milestone 4.1, part 1 of 2)
--
-- Schema + flag for the approval-resume engine. NO behaviour changes here:
-- the lifecycle functions that use these columns are in the next migration,
-- and nothing creates an approval until phase4_approvals is switched on.
--
-- DECISIONS (from the Phase 4 kickoff):
--   * approval TTL = 24 hours (private.approval_ttl()).
--   * a rejected / expired approval FAILS the run ('approval_rejected' /
--     'approval_expired'), it does not cancel it.
--   * one approval per step, ever ("one-shot"): a retry of an approved step
--     does not ask again. Enforced by a unique index.
--
-- public.approvals
--   step_id     the step the approval gates. ON DELETE CASCADE (spec).
--   expires_at  when a pending approval lapses.
--   Both are NULL on legacy/manual rows and set together on every gate-created
--   row (check constraint), so a step-linked pending approval can never be
--   un-expiring.
--
-- INDEX: the spec asks for an index on (step_id). The unique partial index
-- below IS that index for every non-null step_id (it serves the same lookups),
-- so a second plain index would only add write cost; it is not created.
--
-- STATUS CHECKS
--   run_steps.status  += 'waiting_for_approval'
--   approvals.status  += 'expired'   (TTL lapsed)
--                     += 'cancelled' (the run was cancelled while pending)
--   Both constraints keep their auto-generated names (verified against the
--   baseline: run_steps_status_check, approvals_status_check).

alter table public.approvals
  add column step_id    uuid references public.run_steps(id) on delete cascade,
  add column expires_at timestamptz;

alter table public.approvals
  add constraint approvals_step_expiry_consistency
  check ((step_id is null) = (expires_at is null));

create unique index approvals_one_per_step_idx
  on public.approvals (step_id)
  where step_id is not null;

-- expiry sweep scan
create index approvals_pending_expiry_idx
  on public.approvals (expires_at)
  where status = 'pending';

alter table public.run_steps
  drop constraint run_steps_status_check,
  add  constraint run_steps_status_check
    check (status in ('pending','running','waiting_for_approval','succeeded','failed','skipped'));

alter table public.approvals
  drop constraint approvals_status_check,
  add  constraint approvals_status_check
    check (status in ('pending','approved','rejected','expired','cancelled'));

-- Feature flag: seeded OFF. No code path turns it on; activation is manual.
insert into private.feature_flags (name, enabled)
values ('phase4_approvals', false)
on conflict (name) do nothing;

-- Same fail-closed shape as private.is_execution_enabled(): true ONLY when
-- the row exists AND is explicitly enabled.
create function private.is_approvals_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select f.enabled from private.feature_flags f where f.name = 'phase4_approvals'),
    false
  ) is true;
$$;

create function private.approval_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$
  select interval '24 hours';
$$;

revoke execute on function private.is_approvals_enabled() from public, anon, authenticated, service_role;
revoke execute on function private.approval_ttl()        from public, anon, authenticated, service_role;
