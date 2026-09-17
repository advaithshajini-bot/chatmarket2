-- Migration: create_run_steps_table
--
-- Per-step trace inside a run (validate / ai_process / tool_call /
-- transform / output), for audit and debugging (PRD S16/S33). Table +
-- RLS only in Phase 1 -- the execution engine that actually writes rows
-- here is Phase 3.
create table public.run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  tool_id uuid references public.tools(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, step_index)
);

alter table public.run_steps enable row level security;

create index run_steps_run_id_idx on public.run_steps (run_id);
create index run_steps_tool_id_idx on public.run_steps (tool_id);

create policy "Users can view steps of runs they can view" on public.run_steps
  for select to authenticated using ((select private.can_view_run(run_steps.run_id)));

-- No write policy for `authenticated` -- only the (future) execution
-- engine writes step rows, same reasoning as `runs` above.
