-- Migration: create_product_tools_table
--
-- Which tools (from the registry) a given product (listings row) declares
-- it may use. Empty until Phase 4/5 (Creator Studio + tool system) start
-- writing to it -- this migration only creates the table and its RLS.
create table public.product_tools (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.listings(id) on delete cascade,
  tool_id uuid not null references public.tools(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, tool_id)
);

alter table public.product_tools enable row level security;

create index product_tools_product_id_idx on public.product_tools (product_id);
create index product_tools_tool_id_idx on public.product_tools (tool_id);

-- Readable by anyone for a live product (so a future listing page can show
-- "this agent uses: WhatsApp, Google Sheets"), by the owning creator
-- regardless of listing status, and by admins.
create policy "Anyone can view tools of live products" on public.product_tools
  for select to anon, authenticated
  using (exists (select 1 from public.listings l where l.id = product_tools.product_id and l.status = 'live'));

create policy "Creators can view their own product tools" on public.product_tools
  for select to authenticated using ((select private.owns_product(product_tools.product_id)));

create policy "Admins can view all product tools" on public.product_tools
  for select to authenticated using ((select private.is_admin()));

-- Creators can declare tool usage on their own products; admin review of
-- the resulting permission surface happens through the existing
-- listing-approval flow (product_type = workflow/agent goes through the
-- same pending_review -> live gate playbooks already use).
create policy "Creators can add tools to their own products" on public.product_tools
  for insert to authenticated with check ((select private.owns_product(product_tools.product_id)));

create policy "Creators can remove tools from their own products" on public.product_tools
  for delete to authenticated using ((select private.owns_product(product_tools.product_id)));

create policy "Admins can manage any product tools" on public.product_tools
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
