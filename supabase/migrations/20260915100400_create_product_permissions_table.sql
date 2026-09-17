-- Migration: create_product_permissions_table
--
-- Declared permission scope of a product (PRD S12/S25): READ, WRITE, SEND,
-- PUBLISH, DELETE, FINANCIAL_ACTION. A Workflow/Agent product declares
-- which of these it needs; admin approval reviews this scope before the
-- product can go live (wiring that review UI is a later phase -- this
-- migration only creates the table and its RLS).
create table public.product_permissions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.listings(id) on delete cascade,
  permission text not null
    check (permission in ('READ', 'WRITE', 'SEND', 'PUBLISH', 'DELETE', 'FINANCIAL_ACTION')),
  -- High-risk permissions default to requiring human approval at execution
  -- time (PRD S13/S17: "financial and destructive actions should NOT be
  -- enabled by default"). A creator can only turn this off for lower-risk
  -- permissions -- enforced in the CHECK below, not just convention.
  requires_approval boolean not null default true,
  created_at timestamptz not null default now(),
  unique (product_id, permission),
  constraint high_risk_permissions_require_approval check (
    requires_approval = true
    or permission not in ('SEND', 'PUBLISH', 'DELETE', 'FINANCIAL_ACTION')
  )
);

alter table public.product_permissions enable row level security;

create index product_permissions_product_id_idx on public.product_permissions (product_id);

create policy "Anyone can view permissions of live products" on public.product_permissions
  for select to anon, authenticated
  using (exists (select 1 from public.listings l where l.id = product_permissions.product_id and l.status = 'live'));

create policy "Creators can view their own product permissions" on public.product_permissions
  for select to authenticated using ((select private.owns_product(product_permissions.product_id)));

create policy "Admins can view all product permissions" on public.product_permissions
  for select to authenticated using ((select private.is_admin()));

create policy "Creators can declare permissions on their own products" on public.product_permissions
  for insert to authenticated with check ((select private.owns_product(product_permissions.product_id)));

create policy "Creators can remove permissions from their own products" on public.product_permissions
  for delete to authenticated using ((select private.owns_product(product_permissions.product_id)));

create policy "Admins can manage any product permissions" on public.product_permissions
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
