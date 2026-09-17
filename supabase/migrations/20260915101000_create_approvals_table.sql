-- Migration: create_approvals_table
--
-- Human-approval gate records for high-risk run steps (PRD S13: agents
-- must be able to produce "approval required" rather than silently
-- executing). Table + RLS only in Phase 1 -- the runtime logic that
-- actually pauses a run at 'waiting_for_approval' and creates/decides
-- these rows is Phase 4 (tool/permission system).
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  requested_permission text not null
    check (requested_permission in ('READ', 'WRITE', 'SEND', 'PUBLISH', 'DELETE', 'FINANCIAL_ACTION')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.approvals enable row level security;

create index approvals_run_id_idx on public.approvals (run_id);
create index approvals_status_idx on public.approvals (status);

create policy "Users can view approvals on runs they can view" on public.approvals
  for select to authenticated using ((select private.can_view_run(approvals.run_id)));

-- No write policy for `authenticated` yet -- deciding an approval (buyer
-- approving their own run's high-risk step, or an admin override) needs a
-- checked RPC that also resumes/cancels the underlying run atomically,
-- the same pattern `resolve_dispute()` already uses for disputes. That RPC
-- is part of the execution engine (Phase 4), not Phase 1.
