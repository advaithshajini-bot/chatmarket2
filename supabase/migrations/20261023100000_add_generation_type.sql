-- Listing "Generation type" (what the playbook produces): Images | Text | Videos | Others (+ free text for Others).
-- Additive only: two nullable columns, no backfill, no data change. Existing listings keep NULL (shown as "not set").
-- Sellers insert listings directly under the existing RLS policy, so the rules live in CHECK constraints, not just in the form.

alter table public.listings
  add column if not exists generation_type text,
  add column if not exists generation_type_other text;

alter table public.listings
  add constraint listings_generation_type_check
    check (generation_type is null or generation_type in ('images', 'text', 'videos', 'others')),
  add constraint listings_generation_type_other_check
    check (
      (generation_type is not distinct from 'others' and generation_type_other is not null
         and length(btrim(generation_type_other)) between 1 and 60)
      or (generation_type is distinct from 'others' and generation_type_other is null)
    );

comment on column public.listings.generation_type is
  'What the playbook generates: images | text | videos | others. NULL on listings created before this field existed.';
comment on column public.listings.generation_type_other is
  'Seller-typed description (1-60 chars) when generation_type = ''others''; NULL otherwise.';
