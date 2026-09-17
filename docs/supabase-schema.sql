-- Schema applied to the chatmarket Supabase project, via migrations run in
-- order: init_chatmarket_schema, add_admin_role_and_policies,
-- harden_rls_and_indexes, fix_is_admin_execute_grant,
-- buyer_access_and_reviews, seller_can_view_own_sales,
-- fix_purchases_listings_rls_recursion, add_admin_user_management,
-- fix_protect_is_admin_column_bypass, add_disputes_table,
-- add_listing_screenshots_storage, add_48h_review_gate,
-- remove_48h_gate_and_public_reviews, allow_reviews_without_purchase,
-- add_public_platform_stats_rpc, extend_platform_stats_with_reviews,
-- add_seller_kyc.
--
-- The final result — not the intermediate steps — is what's below.
-- Re-run this against a fresh project to reproduce the database this app expects.
--
-- NOTE (Chatmarket 2.0 Phase 1 audit): the live project has DRIFTED further
-- from this file than the migration list above shows. `list_migrations`
-- against the live project returns 31 migrations, not the 18 named here --
-- missing from this file: add_razorpay_route_columns,
-- restrict_set_seller_payout_account_to_authenticated,
-- add_listing_screening_findings, harden_admin_writes_with_mfa,
-- require_mfa_for_resolve_dispute, sync_listing_rating_rollup,
-- require_aal2_for_admin_with_mfa, add_listing_removal_reason,
-- seller_kyc_admin_review_workflow, seed_listings, and others. This means
-- `profiles`, `listings`, `purchases`, and `seller_kyc` already have columns
-- (e.g. profiles.razorpay_linked_account_id/razorpay_account_status,
-- purchases.razorpay_transfer_id/transfer_status,
-- listings.screening_findings/removal_reason/removed_at,
-- seller_kyc.admin_note/reviewed_at and an expanded status enum) not shown
-- below. This file was NOT rewritten to close that gap as part of Phase 1 --
-- doing so accurately requires re-deriving 10 migrations' worth of DDL from
-- the live database, which is a larger, separate documentation-hygiene task.
-- Treat the LIVE Supabase project (via list_tables/list_migrations) as the
-- true source of truth until that reconciliation happens; this file is
-- reliable for everything through add_seller_kyc, plus the Phase 1 additions
-- appended at the bottom of this file below.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  model text not null,
  category text not null,
  messages int not null default 0,
  completion int not null default 100,
  price numeric not null,
  rating numeric,
  reviews int not null default 0,
  seller_name text not null,
  seller_id uuid references auth.users(id) on delete set null,
  description text not null default '',
  status text not null default 'pending_review'
    check (status in ('pending_review', 'live', 'flagged', 'removed')),
  preview jsonb not null default '[]'::jsonb,
  thread jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  amount numeric not null,
  payment_method text not null default 'upi',
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  purchased_at timestamptz not null default now(),
  unique (user_id, listing_id)
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Private helper for admin checks: SECURITY DEFINER so it can read
-- profiles.is_admin without RLS recursion. Only `authenticated` may call it —
-- policies evaluate in the caller's role, so this grant is required even
-- though the function itself runs with elevated privileges internally.
create schema if not exists private;

create function private.is_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

revoke execute on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.purchases enable row level security;

create policy "Profiles are publicly readable" on public.profiles
  for select to anon, authenticated using (true);

create policy "Users can update their own profile" on public.profiles
  for update to authenticated using ((select auth.uid()) = id);

create policy "Live listings are publicly readable" on public.listings
  for select to anon, authenticated using (status = 'live');

create policy "Sellers can view their own listings regardless of status" on public.listings
  for select to authenticated using ((select auth.uid()) = seller_id);

create policy "Admins can view all listings" on public.listings
  for select to authenticated using ((select private.is_admin()));

create policy "Authenticated users can create their own listings" on public.listings
  for insert to authenticated with check ((select auth.uid()) = seller_id);

create policy "Admins can update any listing" on public.listings
  for update to authenticated using ((select private.is_admin()));

create policy "Users can view their own purchases" on public.purchases
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Users can create their own purchases" on public.purchases
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Postgres doesn't auto-index foreign key columns; these are read on every
-- RLS check above.
create index listings_seller_id_idx on public.listings (seller_id);
create index listings_status_idx on public.listings (status);
create index purchases_user_id_idx on public.purchases (user_id);
create index purchases_listing_id_idx on public.purchases (listing_id);

-- Added in a later migration (buyer_access_and_reviews): a buyer keeps read
-- access to a listing's full content even if it's later flagged/removed by
-- moderation, since they already paid for it.
create policy "Buyers can view listings they've purchased" on public.listings
  for select to authenticated
  using (
    exists (
      select 1 from public.purchases pu
      where pu.listing_id = listings.id
        and pu.user_id = (select auth.uid())
    )
  );

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  -- Nullable as of allow_reviews_without_purchase: a review no longer
  -- requires a real purchase. Still linked to one when the reviewer
  -- genuinely has it (powers a "Verified buyer" badge); RLS below prevents
  -- linking someone else's purchase to spoof that badge.
  purchase_id uuid unique references public.purchases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  -- Added in allow_reviews_without_purchase: without the purchase
  -- requirement, the old natural one-review-per-purchase limit disappears
  -- too. This replaces it with an explicit one-review-per-listing limit
  -- per user, purchased or not.
  constraint reviews_listing_user_unique unique (listing_id, user_id)
);

alter table public.reviews enable row level security;

create policy "Users can view their own reviews" on public.reviews
  for select to authenticated using ((select auth.uid()) = user_id);

-- Added in a later migration (remove_48h_gate_and_public_reviews): reviews
-- are product info meant to be seen by anyone browsing a listing, not just
-- the person who wrote them -- without this, a random visitor can't see
-- anyone else's review at all, which the listing page's public reviews
-- section needs.
create policy "Anyone can view reviews on live listings" on public.reviews
  for select to public
  using (exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live'));

-- Superseded by "Users can review any live listing" below
-- (allow_reviews_without_purchase) -- kept only as history of how this
-- table's trust model evolved:
--   1. add_admin_role_and_policies-era: a review required a real purchase
--      (the 48h-gated version further required pu.purchased_at <= now() - 48h)
--   2. allow_reviews_without_purchase: purchase requirement dropped
--      entirely -- see the README's "Row Level Security" section for the
--      trust trade-off this makes, and why a "Verified buyer" badge exists
--      to partially compensate for it.
create policy "Users can review any live listing" on public.reviews
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live')
    and (
      purchase_id is null
      or exists (
        select 1 from public.purchases pu
        where pu.id = purchase_id
          and pu.user_id = (select auth.uid())
          and pu.listing_id = reviews.listing_id
      )
    )
  );

create index reviews_user_id_idx on public.reviews (user_id);
create index reviews_listing_id_idx on public.reviews (listing_id);

-- Added in later migrations (seller_can_view_own_sales, then
-- fix_purchases_listings_rls_recursion): sellers need to see purchases of
-- listings they own, to compute earnings. The naive version of this policy
-- (a plain subquery on public.listings) caused infinite recursion, because
-- listings' own "Buyers can view listings they've purchased" policy queries
-- purchases right back. Fixed with a SECURITY DEFINER helper that bypasses
-- RLS for just this internal ownership check.
create function private.owns_listing(check_listing_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.listings l
    where l.id = check_listing_id
      and l.seller_id = (select auth.uid())
  );
$$;

revoke execute on function private.owns_listing(uuid) from public, anon, authenticated;
grant execute on function private.owns_listing(uuid) to authenticated;

create policy "Sellers can view purchases of their own listings" on public.purchases
  for select to authenticated
  using ((select private.owns_listing(purchases.listing_id)));

-- Added for the admin "user management" UI (grant/revoke is_admin from the
-- app instead of only via the SQL editor). Two parts, added together:
--
-- 1. A policy letting admins update any profile (the existing
--    "Users can update their own profile" policy is scoped to auth.uid() = id).
-- 2. A trigger closing a real privilege-escalation hole: without it, that
--    self-update policy has no column restriction, so any logged-in user
--    could run `update profiles set is_admin = true where id = auth.uid()`
--    from the client and grant themselves admin. A trigger is needed (not a
--    WITH CHECK) because WITH CHECK only sees the new row, not the old one,
--    so it can't tell whether is_admin actually changed on its own.
--
-- The trigger only intervenes for requests carrying an end-user JWT
-- (auth.uid() is not null); direct SQL-editor / service-role updates (no
-- JWT context) are left alone, so the original "grant admin via SQL editor"
-- workflow still works.
create function private.protect_is_admin_column()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_admin is distinct from old.is_admin
     and (select auth.uid()) is not null
     and not (select private.is_admin())
  then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

create trigger protect_is_admin_column
  before update on public.profiles
  for each row execute procedure private.protect_is_admin_column();

create policy "Admins can update any profile" on public.profiles
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

-- Real disputes table, replacing lib/admin-data.js's mock INITIAL_DISPUTES
-- (that file has been deleted). One dispute per purchase. listing_id and
-- seller_id are denormalized from the purchase's listing at filing time so
-- admin/seller views don't need extra joins and keep working even if the
-- listing is later removed.
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid references auth.users(id) on delete set null,
  reason text not null,
  status text not null default 'open'
    check (status in ('open', 'resolved_refunded', 'resolved_denied')),
  resolution_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table public.disputes enable row level security;

create policy "Buyers can view their own disputes" on public.disputes
  for select to authenticated using ((select auth.uid()) = buyer_id);

create policy "Buyers can file a dispute on their own paid purchase" on public.disputes
  for insert to authenticated
  with check (
    (select auth.uid()) = buyer_id
    and exists (
      select 1 from public.purchases pu
      where pu.id = purchase_id
        and pu.user_id = (select auth.uid())
        and pu.status = 'paid'
    )
  );

-- Reuses the same SECURITY DEFINER ownership check already relied on by
-- purchases' seller policy, to avoid the recursion bug documented above.
create policy "Sellers can view disputes on their own listings" on public.disputes
  for select to authenticated using ((select private.owns_listing(disputes.listing_id)));

create policy "Admins can view all disputes" on public.disputes
  for select to authenticated using ((select private.is_admin()));

-- No direct client-side UPDATE policy: resolution goes through
-- resolve_dispute() below so the dispute row and the linked purchase's
-- refund status change together or not at all.

create index disputes_buyer_id_idx on public.disputes (buyer_id);
create index disputes_listing_id_idx on public.disputes (listing_id);
create index disputes_status_idx on public.disputes (status);

-- Admin resolution needs to touch two tables atomically: the dispute itself,
-- and (for a refund outcome) the purchase's status. A SECURITY DEFINER RPC
-- does both in one transaction and re-checks admin status server-side
-- (defense in depth beyond just gating the button in the UI).
create function public.resolve_dispute(p_dispute_id uuid, p_outcome text, p_note text default null)
returns public.disputes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dispute public.disputes;
begin
  if not (select private.is_admin()) then
    raise exception 'not authorized';
  end if;

  if p_outcome not in ('resolved_refunded', 'resolved_denied') then
    raise exception 'invalid outcome: %', p_outcome;
  end if;

  select * into v_dispute from public.disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'dispute not found';
  end if;
  if v_dispute.status <> 'open' then
    raise exception 'dispute is already resolved';
  end if;

  update public.disputes
  set status = p_outcome,
      resolution_note = p_note,
      resolved_by = (select auth.uid()),
      resolved_at = now()
  where id = p_dispute_id
  returning * into v_dispute;

  if p_outcome = 'resolved_refunded' then
    update public.purchases set status = 'refunded' where id = v_dispute.purchase_id;
  end if;

  return v_dispute;
end;
$$;

revoke execute on function public.resolve_dispute(uuid, text, text) from public, anon;
grant execute on function public.resolve_dispute(uuid, text, text) to authenticated;

-- Storage for the output-screenshot gallery on a listing (PDF screen s2/b3:
-- "Output images appear in the swipeable gallery buyers see on the thread page").
-- Public bucket: screenshots are marketing/preview material meant to be seen
-- once a listing is browsable, the same way listing rows themselves are
-- publicly readable. Path convention enforced by the upload policy is
-- <seller_id>/<listing_id>/<filename>, so ownership can be checked from the
-- path alone -- no listings-table lookup needed, since the listing row
-- doesn't exist yet at upload time (screenshots are attached during step 1
-- of the wizard, before the listing is created in step 3).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-screenshots', 'listing-screenshots', true, 5242880, array['image/png', 'image/jpeg', 'image/webp']);

create policy "Listing screenshots are publicly readable" on storage.objects
  for select to public
  using (bucket_id = 'listing-screenshots');

create policy "Sellers can upload screenshots into their own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'listing-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Sellers can delete their own screenshots" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'listing-screenshots'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Admins can delete any screenshot" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-screenshots' and (select private.is_admin()));

-- Where the uploaded URLs get attached once the listing is created.
alter table public.listings add column screenshots jsonb not null default '[]'::jsonb;

-- Added in add_public_platform_stats_rpc, extended in
-- extend_platform_stats_with_reviews: the homepage's "threads sold" / "paid
-- out to sellers" / "average rating" stats were computed by querying
-- purchases/reviews directly through the visitor's own session. purchases
-- has no public or platform-wide SELECT policy at all -- only "your own
-- purchases" and "sales of your own listings" -- so an anonymous visitor
-- saw zero and a logged-in non-admin buyer saw a count/sum computed from
-- only THEIR OWN purchases, not the platform's. Reviews had a milder
-- version of the same issue (an authenticated user's own review is visible
-- even off a live listing, on top of the public "any review on a live
-- listing" policy). Fixed with a SECURITY DEFINER function returning only
-- the four safe aggregate numbers -- never row-level buyer/amount/reviewer
-- data -- so it's identical for every visitor regardless of login state.
create function public.get_platform_stats()
returns table(threads_sold bigint, gross_paid numeric, review_count bigint, avg_rating numeric)
language sql
security definer
set search_path = ''
stable
as $$
  select
    (select count(*) from public.purchases),
    (select coalesce(sum(amount), 0) from public.purchases where status = 'paid'),
    (select count(*) from public.reviews),
    (select coalesce(avg(rating), 0) from public.reviews)
$$;

revoke all on function public.get_platform_stats() from public;
grant execute on function public.get_platform_stats() to anon, authenticated;

-- Added in add_seller_kyc: real seller KYC data collection, replacing the
-- old 4-step account-type/details/bank/verify UI-only mock's "details" step
-- with a full form matching a real government KYC form layout. PAN/Aadhaar
-- verification against the actual government database is NOT implemented
-- here -- that needs a licensed KYC provider (or Razorpay Route's own
-- stakeholder KYC once Route is approved), by explicit choice, not an
-- oversight. This table stores what a human reviewer would need in the
-- meantime.
--
-- Aadhaar: only the last 4 digits are stored (aadhaar_last4), never the
-- full number -- UIDAI has real restrictions on storing full Aadhaar
-- numbers, and the uploaded document image is what a reviewer actually
-- needs anyway.
create table public.seller_kyc (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,

  citizen_of_india boolean,
  first_name text,
  middle_name text,
  last_name text,
  father_first_name text,
  father_middle_name text,
  father_last_name text,
  nationality text,
  resident_in_india boolean,
  occupation_type text check (occupation_type in ('self_employed', 'professional', 'homemaker', 'student', 'serviceman')),
  education_qualification text,
  education_qualification_other text,
  date_of_birth date,

  pan_number text,
  pan_attachment_path text,

  has_aadhaar boolean,
  aadhaar_last4 text,
  aadhaar_attachment_path text,

  -- OTP fields: real generation/hashing/expiry/attempt-limiting, but
  -- delivery is a labeled stand-in -- see app/api/kyc/send-otp/route.js
  -- and the README's "Seller KYC" section for exactly what's real.
  mobile_country_code text,
  mobile_number text,
  mobile_verified boolean not null default false,
  mobile_otp_hash text,
  mobile_otp_expires_at timestamptz,
  mobile_otp_attempts int not null default 0,

  email text,
  email_verified boolean not null default false,
  email_otp_hash text,
  email_otp_expires_at timestamptz,
  email_otp_attempts int not null default 0,

  permanent_address jsonb not null default '{}'::jsonb,
  present_same_as_permanent boolean,
  present_address jsonb not null default '{}'::jsonb,

  status text not null default 'draft' check (status in ('draft', 'submitted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.seller_kyc enable row level security;

create policy "Sellers can view their own KYC record" on public.seller_kyc
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Sellers can create their own KYC record" on public.seller_kyc
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Sellers can update their own KYC record" on public.seller_kyc
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Admins can view any KYC record" on public.seller_kyc
  for select to authenticated using ((select private.is_admin()));

-- Auto-updates updated_at on every change, same convention as other
-- mutable tables in this schema.
create function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger seller_kyc_set_updated_at
  before update on public.seller_kyc
  for each row execute procedure private.set_updated_at();

-- Private bucket (unlike listing-screenshots) -- these are government ID
-- documents, never publicly readable. Path convention <user_id>/<file>,
-- same ownership-by-path pattern as listing-screenshots, plus an admin
-- read policy for future manual KYC review.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seller-kyc-documents', 'seller-kyc-documents', false, 10485760, array['image/png', 'image/jpeg', 'application/pdf']);

create policy "Sellers can upload their own KYC documents" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Sellers can view their own KYC documents" on storage.objects
  for select to authenticated
  using (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Sellers can delete their own KYC documents" on storage.objects
  for delete to authenticated
  using (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Admins can view any KYC document" on storage.objects
  for select to authenticated
  using (bucket_id = 'seller-kyc-documents' and (select private.is_admin()));

-- ---------------------------------------------------------------------
-- Migration: fix_disputes_status_default
-- The disputes.status column's default had somehow been stored as the
-- literal string "'open'::text" (quotes and cast baked in as characters)
-- instead of evaluating to "open". Since the app never sets status
-- explicitly on insert, every dispute filing hit disputes_status_check --
-- regardless of timing, always. Restored a real default.
alter table public.disputes alter column status set default 'open';

-- ---------------------------------------------------------------------
-- Migration: add_48h_dispute_filing_window
-- The checkout page already promises "funds held for 48 hrs after unlock
-- in case of a dispute" -- this was never actually enforced server-side.
-- Buyers can now only file a dispute within 48 hours of the purchase;
-- the UI mirrors this with a friendly message once the window closes.
drop policy "Buyers can file a dispute on their own paid purchase" on public.disputes;

create policy "Buyers can file a dispute on their own paid purchase" on public.disputes
  for insert to authenticated
  with check (
    (select auth.uid()) = buyer_id
    and exists (
      select 1 from public.purchases pu
      where pu.id = purchase_id
        and pu.user_id = (select auth.uid())
        and pu.status = 'paid'
        and pu.purchased_at > now() - interval '48 hours'
    )
  );

-- ---------------------------------------------------------------------
-- Migration: add_listing_files_zip_upload
-- Sellers now upload a single zip containing the conversation export plus
-- any generated outputs, instead of a bare .json/.txt file. The
-- conversation portion is still parsed client-side out of the zip for
-- preview/redaction/continue-in-AI-chat purposes (listings.thread/preview
-- unchanged), but the zip itself -- stored here, not as jsonb text -- is
-- the real deliverable a buyer downloads.
insert into storage.buckets (id, name, public)
values ('listing-files', 'listing-files', false);

alter table public.listings add column output_zip_path text;

create policy "Sellers can upload their own listing files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Sellers can view their own listing files" on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Sellers can delete their own listing files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Admins can view any listing file" on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-files' and (select private.is_admin()));

-- Path convention is {seller_id}/{listing_id}/{filename}, so the second
-- folder segment is the listing id -- check it against a paid purchase.
create policy "Buyers can download files for purchases they made" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'listing-files'
    and exists (
      select 1 from public.purchases p
      where p.listing_id = ((storage.foldername(name))[2])::uuid
        and p.user_id = (select auth.uid())
        and p.status = 'paid'
    )
  );

-- ---------------------------------------------------------------------
-- Migration: add_listing_zip_contents_note
-- Seller-written note describing what's actually inside the uploaded zip
-- (distinct from the description field), capped at 500 chars in the UI.
alter table public.listings add column zip_contents text;

-- ---------------------------------------------------------------------
-- Chatmarket 2.0 Phase 1 -- Product/Workflow/Agent domain foundation.
-- Applied as 13 separate migrations, listed in supabase/migrations/.
-- See docs/product-domain-model.md for the full explanation of each table
-- and why several of them intentionally have no write policy yet.
-- ---------------------------------------------------------------------
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
-- Migration: add_owns_product_helper_function
--
-- `listings` physically IS the Product table for now (see previous
-- migration), so this is a thin, semantically-named wrapper around the
-- existing `private.owns_listing()` -- not a duplicate implementation.
-- New Chatmarket 2.0 tables (product_tools, product_permissions, runs,
-- etc.) reference `owns_product` rather than `owns_listing` directly, so
-- that if Product ever becomes its own physical table later, only this one
-- function needs to change -- every RLS policy built on top of it does not.
--
-- SECURITY DEFINER + empty search_path + revoke-then-grant-to-authenticated,
-- matching the exact pattern already used by private.owns_listing() and
-- private.is_admin() elsewhere in this schema.
create function private.owns_product(check_product_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select private.owns_listing(check_product_id);
$$;

revoke execute on function private.owns_product(uuid) from public, anon, authenticated;
grant execute on function private.owns_product(uuid) to authenticated;
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
-- Migration: create_entitlements_table
--
-- Generalizes "does this user have access to this product" across
-- one-time purchase / subscription / usage-metered access, WITHOUT
-- touching the existing `purchases` table's shape, unique constraint, or
-- any historical row. `purchases` keeps meaning exactly what it means
-- today (a one-time Razorpay-paid purchase record); `entitlements` is a
-- new, additive layer that future code can check generically regardless
-- of how access was granted.
--
-- No application code reads or writes this table yet -- existing checkout,
-- library, and access-gating logic is untouched in Phase 1. This migration
-- also backfills one 'purchase'-kind entitlement per existing paid
-- purchase, so the new table is consistent with reality from the moment
-- it exists, without altering a single row of `purchases` itself.
create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.listings(id) on delete cascade,
  kind text not null check (kind in ('purchase', 'subscription', 'usage')),
  status text not null default 'active' check (status in ('active', 'canceled', 'expired')),
  -- Set only for kind='purchase' entitlements created from the existing
  -- purchases table (this migration's backfill, and future checkout code).
  source_purchase_id uuid references public.purchases(id) on delete set null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute procedure private.set_updated_at();

alter table public.entitlements enable row level security;

create index entitlements_user_id_idx on public.entitlements (user_id);
create index entitlements_product_id_idx on public.entitlements (product_id);
create index entitlements_source_purchase_id_idx on public.entitlements (source_purchase_id);

create policy "Users can view their own entitlements" on public.entitlements
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Creators can view entitlements to their own products" on public.entitlements
  for select to authenticated using ((select private.owns_product(entitlements.product_id)));

create policy "Admins can view all entitlements" on public.entitlements
  for select to authenticated using ((select private.is_admin()));

-- No INSERT/UPDATE/DELETE policy for `authenticated` yet, deliberately.
-- Granting entitlements must happen through a checked, server-verified
-- path (extending the existing Razorpay verify-payment flow, and later
-- subscription webhooks) -- that wiring is a Phase 7 (billing) change, not
-- Phase 1. Until then, only the service role (which bypasses RLS, used by
-- this migration's backfill below and by trusted server-side code) can
-- write to this table -- there is no way for a client to grant itself an
-- entitlement.

-- Backfill: one 'purchase' entitlement per existing paid purchase. Purely
-- additive (new entitlements rows only); does not modify `purchases` in
-- any way. Uses ON CONFLICT on the (user_id, product_id) unique
-- constraint so this is safe to re-run.
insert into public.entitlements (user_id, product_id, kind, status, source_purchase_id, created_at)
select p.user_id, p.listing_id, 'purchase', 'active', p.id, p.purchased_at
from public.purchases p
where p.status = 'paid'
on conflict (user_id, product_id) do nothing;
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
-- Migration: add_can_view_run_helper_function
--
-- Single source of truth for "can this caller see this run" (buyer who
-- ran it, creator who owns the product, or admin), reused by every run-
-- child table (run_steps, usage_events, approvals) instead of each
-- duplicating a 3-way OR against `runs` + `owns_product` + `is_admin`.
-- SECURITY DEFINER so it can read `runs` regardless of the caller's own
-- RLS visibility into that table (mirrors the owns_listing/owns_product
-- pattern already used to sidestep recursion elsewhere in this schema).
create function private.can_view_run(check_run_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.runs r
    where r.id = check_run_id
      and (
        r.user_id = (select auth.uid())
        or private.owns_product(r.product_id)
        or private.is_admin()
      )
  );
$$;

revoke execute on function private.can_view_run(uuid) from public, anon, authenticated;
grant execute on function private.can_view_run(uuid) to authenticated;
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
-- Migration: create_payouts_table
--
-- Real creator payout ledger. Table + RLS only in Phase 1 -- no money
-- moves through this table yet. The live database already has
-- `profiles.razorpay_linked_account_id` / `razorpay_account_status` and
-- `purchases.transfer_status` from prior Route-preparation work (see
-- Phase 1 report), so this table is scoped narrowly: it's a ledger of
-- payout *events* (one row per amount owed/paid to a creator, whether
-- sourced from a one-time purchase or, later, a subscription/usage
-- period), not a duplicate of those existing columns.
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending', 'processing', 'paid', 'failed')),
  related_purchase_id uuid references public.purchases(id) on delete set null,
  related_run_id uuid references public.runs(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.payouts enable row level security;

create index payouts_creator_id_idx on public.payouts (creator_id);
create index payouts_status_idx on public.payouts (status);

create policy "Creators can view their own payouts" on public.payouts
  for select to authenticated using ((select auth.uid()) = creator_id);

create policy "Admins can view all payouts" on public.payouts
  for select to authenticated using ((select private.is_admin()));

-- No write policy for `authenticated` -- payout rows are created/updated
-- only by trusted server-side code (Route webhook handling, Phase 7/2),
-- never by a client.
-- Migration: create_audit_log_table
--
-- Immutable audit trail for material actions (PRD S12/S17/S25). Phase 1
-- creates the table, admin-only read policy, and a SECURITY DEFINER write
-- helper -- it does NOT wire any existing route (checkout, dispute
-- resolution, KYC, admin moderation) to call it yet. Adding audit writes
-- to those flows would change existing behavior, which this phase is
-- explicitly scoped not to do; that wiring is a Phase 8 (trust & safety)
-- change once there's a real admin UI to view the log.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: some future entries may be system-initiated (e.g. an
  -- automatic timeout), not a specific user's action.
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

create index audit_log_actor_id_idx on public.audit_log (actor_id);
create index audit_log_target_idx on public.audit_log (target_type, target_id);
create index audit_log_created_at_idx on public.audit_log (created_at);

-- Audit log is admin-only to read -- it is not "your own activity
-- history" for a regular user, it's a moderation/security record.
create policy "Admins can view the audit log" on public.audit_log
  for select to authenticated using ((select private.is_admin()));

-- No INSERT policy for `authenticated` or `anon` at all -- rows can only
-- be written through `private.write_audit_log()` below (SECURITY DEFINER,
-- not directly callable by a client either), so entries can't be forged or
-- deleted by anyone, including a compromised client session.
create function private.write_audit_log(
  p_actor_id uuid,
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, p_action, p_target_type, p_target_id, p_metadata);
$$;

-- Not granted to anon/authenticated -- only other SECURITY DEFINER
-- functions (future admin-action RPCs, e.g. a later version of
-- resolve_dispute or a new approve_run RPC) call this internally. A
-- future migration will explicitly grant it once such an RPC exists;
-- granting it now with nothing calling it yet would be premature surface
-- area.
revoke execute on function private.write_audit_log(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Phase 1 correction (zero-cost validation round follow-up): 3 FK indexes
-- missed in the original 13 migrations. See
-- supabase/migrations/20260915101300_add_missing_phase1_fk_indexes.sql
-- and docs/product-domain-model.md.
-- ---------------------------------------------------------------------
-- Migration: add_missing_phase1_fk_indexes
--
-- Chatmarket 2.0 Phase 1 correction. Postgres does not auto-index foreign
-- key columns (same convention already noted elsewhere in this schema).
-- The Phase 1 zero-cost validation round found three FK columns created by
-- earlier Phase 1 migrations that were missed: approvals.decided_by,
-- payouts.related_purchase_id, payouts.related_run_id. All three are
-- nullable and unpopulated today (no write path exists yet for either
-- table), so this is purely precautionary -- additive, safe to run once,
-- non-destructive, and it changes no existing data or behavior.
create index approvals_decided_by_idx on public.approvals (decided_by);
create index payouts_related_purchase_id_idx on public.payouts (related_purchase_id);
create index payouts_related_run_id_idx on public.payouts (related_run_id);
