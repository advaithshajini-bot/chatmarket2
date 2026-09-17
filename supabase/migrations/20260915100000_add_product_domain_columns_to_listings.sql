-- Migration: add_product_domain_columns_to_listings
--
-- Chatmarket 2.0 Phase 1. Purely additive: three new nullable-safe columns
-- on the existing `listings` table, each with a default, so every existing
-- row (currently 15 live rows) gets a valid value automatically and no
-- existing query, RLS policy, or application code path changes behavior.
--
-- `listings` remains the physical table for the Product domain per explicit
-- instruction -- this is NOT a rename/migration into a new `products` table.
--
-- - product_type: discriminates Playbook / Workflow / Agent. Existing rows
--   default to 'playbook', matching the PRD's own instruction that existing
--   conversation listings become the Playbook product type.
-- - version: product versioning (PRD FR-13). Existing rows start at 1.
-- - configuration: jsonb bag for type-specific structure (workflow steps,
--   agent tools/permissions/model policy). Existing playbook rows leave
--   this empty and keep using their existing columns
--   (thread/preview/output_zip_path/zip_contents) -- configuration is only
--   consumed by workflow/agent products going forward.

alter table public.listings
  add column product_type text not null default 'playbook'
    check (product_type in ('playbook', 'workflow', 'agent'));

alter table public.listings
  add column version integer not null default 1
    check (version >= 1);

alter table public.listings
  add column configuration jsonb not null default '{}'::jsonb;

-- Read-heavy filter (Browse will filter/group by product_type once the
-- marketplace UI is updated in a later phase) -- added now while the
-- column is new, same convention as other listings indexes.
create index listings_product_type_idx on public.listings (product_type);

comment on column public.listings.product_type is
  'Chatmarket 2.0 product domain: playbook | workflow | agent. Existing rows are playbook.';
comment on column public.listings.version is
  'Chatmarket 2.0 product versioning. Existing rows start at 1.';
comment on column public.listings.configuration is
  'Chatmarket 2.0 type-specific config (workflow steps / agent tools+permissions+model policy). Validated server-side by lib/validation before being written -- see docs.';
