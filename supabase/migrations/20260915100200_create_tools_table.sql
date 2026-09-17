-- Migration: create_tools_table
--
-- Registry of tools an Agent/Workflow product could be granted access to
-- (WhatsApp, Google Sheets, email, etc.). Phase 1 creates the registry
-- table only -- no rows are seeded and no execution_handler code exists
-- yet (that's Phase 4, per the approved roadmap). Kept genuinely empty and
-- inert: nothing in the existing app reads or writes this table.
create table public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  -- Nullable: a tool may require no elevated permission (e.g. a read-only
  -- lookup). Constrained to the same 6-value permission set used
  -- everywhere else in the product/permission domain.
  required_permission text
    check (required_permission in ('READ', 'WRITE', 'SEND', 'PUBLISH', 'DELETE', 'FINANCIAL_ACTION')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tools_set_updated_at
  before update on public.tools
  for each row execute procedure private.set_updated_at();

alter table public.tools enable row level security;

-- Tools themselves are not sensitive (name/description/schema of a
-- capability, not a credential) -- readable by anyone, same openness level
-- as `listings` for live products. Only enabled tools are shown; disabled
-- tools stay admin-only until turned on.
create policy "Anyone can view enabled tools" on public.tools
  for select to anon, authenticated using (enabled = true);

create policy "Admins can view all tools" on public.tools
  for select to authenticated using ((select private.is_admin()));

-- Tool registry management is admin-only -- creators declare which
-- existing tools a product uses (product_tools, next migration), they do
-- not define new tools themselves in Phase 1.
create policy "Admins can manage tools" on public.tools
  for insert to authenticated with check ((select private.is_admin()));

create policy "Admins can update tools" on public.tools
  for update to authenticated using ((select private.is_admin()));

create policy "Admins can delete tools" on public.tools
  for delete to authenticated using ((select private.is_admin()));
