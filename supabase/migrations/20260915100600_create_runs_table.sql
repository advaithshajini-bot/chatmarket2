-- Migration: create_runs_table
--
-- The execution record for a product (Playbook/Workflow/Agent). Phase 1
-- creates the table, status lifecycle, and RLS ONLY -- no worker, no
-- queue, no AI/tool calls exist yet (Phase 3). Nothing currently writes to
-- this table; it exists so the domain model and validation layer have a
-- real destination to target when the execution engine is built.
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.listings(id) on delete cascade,
  -- Snapshot of listings.version at run creation time, so a run's behavior
  -- stays interpretable even if the product is edited/republished later.
  product_version integer not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  is_sandbox boolean not null default false,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  cost numeric not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.runs enable row level security;

create index runs_user_id_idx on public.runs (user_id);
create index runs_product_id_idx on public.runs (product_id);
create index runs_status_idx on public.runs (status);

create policy "Users can view their own runs" on public.runs
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Creators can view runs of their own products" on public.runs
  for select to authenticated using ((select private.owns_product(runs.product_id)));

create policy "Admins can view all runs" on public.runs
  for select to authenticated using ((select private.is_admin()));

-- No INSERT/UPDATE policy for `authenticated` yet, deliberately -- the
-- execution engine (Phase 3) is what will validate entitlement, usage
-- limits, and configuration before a run is ever allowed to exist, and it
-- alone should be able to create/advance run rows. Building that check now
-- without the engine behind it would let a client create orphaned
-- 'queued' runs nothing ever processes.
