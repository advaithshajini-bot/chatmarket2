-- Migration: create_usage_events_table
--
-- Billable usage ledger (PRD S24): executions, documents processed, tool
-- calls, etc. Table + RLS only in Phase 1 -- nothing generates usage
-- events yet (that requires the execution engine, Phase 3) and no billing
-- logic reads this table yet (Phase 7).
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.listings(id) on delete cascade,
  run_id uuid references public.runs(id) on delete set null,
  metric text not null,
  quantity numeric not null default 1 check (quantity >= 0),
  unit_price numeric check (unit_price >= 0),
  currency text not null default 'INR',
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

create index usage_events_user_id_idx on public.usage_events (user_id);
create index usage_events_product_id_idx on public.usage_events (product_id);
create index usage_events_run_id_idx on public.usage_events (run_id);

create policy "Users can view their own usage events" on public.usage_events
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Creators can view usage events on their own products" on public.usage_events
  for select to authenticated using ((select private.owns_product(usage_events.product_id)));

create policy "Admins can view all usage events" on public.usage_events
  for select to authenticated using ((select private.is_admin()));

-- No write policy for `authenticated` -- usage events are recorded by the
-- (future) execution engine only, never claimed by a client directly.
