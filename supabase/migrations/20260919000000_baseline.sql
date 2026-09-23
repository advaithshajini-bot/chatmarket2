-- ============================================================================
-- 20260919000000_baseline.sql
-- Clean current-state baseline for chatmarket (uolfnbheigxnzelqtodw), Strategy C.
--
-- Generated via live pg_catalog/information_schema introspection against
-- production on 2026-09-23, NOT via pg_dump (no CLI available in this
-- environment) and NOT by replaying the 45 historical migration files.
-- Represents the FINAL current state of every object (e.g. private.is_admin()
-- reflects its last CREATE OR REPLACE, not its original 2026-08-14 version).
--
-- This file is being marked `applied` in supabase_migrations.schema_migrations
-- WITHOUT being executed, per Strategy C. It is not run by this migration
-- process itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions (already present; idempotent)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
-- Already exists in production as an empty schema (confirmed live before
-- writing this file). IF NOT EXISTS makes this a safe no-op against that.
create schema if not exists private;

-- ============================================================================
-- TABLES
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now(),
  is_admin boolean not null default false,
  razorpay_linked_account_id text,
  razorpay_account_status text not null default 'not_started'
    check (razorpay_account_status in ('not_started','pending','needs_clarification','active'))
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
    check (status in ('pending_review','live','flagged','removed')),
  preview jsonb not null default '[]'::jsonb,
  thread jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  screenshots jsonb not null default '[]'::jsonb,
  screening_findings jsonb not null default '[]'::jsonb,
  removal_reason text,
  removed_at timestamptz,
  output_zip_path text,
  zip_contents text,
  product_type text not null default 'playbook'
    check (product_type in ('playbook','workflow','agent')),
  version integer not null default 1 check (version >= 1),
  configuration jsonb not null default '{}'::jsonb
);
comment on column public.listings.product_type is
  'Chatmarket 2.0 product domain: playbook | workflow | agent. Existing rows are playbook.';
comment on column public.listings.version is
  'Chatmarket 2.0 product versioning. Existing rows start at 1.';
comment on column public.listings.configuration is
  'Chatmarket 2.0 type-specific config (workflow steps / agent tools+permissions+model policy). Validated server-side by lib/validation before being written -- see docs.';

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  amount numeric not null,
  payment_method text not null default 'upi',
  status text not null default 'paid' check (status in ('paid','refunded')),
  purchased_at timestamptz not null default now(),
  razorpay_order_id text,
  razorpay_payment_id text,
  razorpay_signature text,
  razorpay_transfer_id text,
  platform_fee numeric,
  transfer_status text not null default 'pending'
    check (transfer_status in ('pending','held','released','reversed')),
  unique (user_id, listing_id)
);
comment on column public.purchases.transfer_status is
  'pending = no Route transfer created yet (seller has not finished payout onboarding); '
  'held = transfer created with on_hold=true, inside the 48hr dispute window; '
  'released = transfer.processed webhook confirmed funds reached the seller; '
  'reversed = transfer or payment was refunded/reversed.';
create unique index purchases_razorpay_payment_id_key
  on public.purchases (razorpay_payment_id) where razorpay_payment_id is not null;

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references public.purchases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (purchase_id),
  unique (listing_id, user_id)
);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null unique references public.purchases(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  seller_id uuid references auth.users(id) on delete set null,
  reason text not null,
  status text not null default 'open'
    check (status in ('open','resolved_refunded','resolved_denied')),
  resolution_note text,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

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
  occupation_type text check (occupation_type in ('self_employed','professional','homemaker','student','serviceman')),
  education_qualification text,
  education_qualification_other text,
  date_of_birth date,
  pan_number text,
  pan_attachment_path text,
  has_aadhaar boolean,
  aadhaar_last4 text,
  aadhaar_attachment_path text,
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
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','rejected','needs_changes')),
  admin_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tools (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null default '',
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  required_permission text
    check (required_permission in ('READ','WRITE','SEND','PUBLISH','DELETE','FINANCIAL_ACTION')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_tools (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.listings(id) on delete cascade,
  tool_id uuid not null references public.tools(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (product_id, tool_id)
);

create table public.product_permissions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.listings(id) on delete cascade,
  permission text not null
    check (permission in ('READ','WRITE','SEND','PUBLISH','DELETE','FINANCIAL_ACTION')),
  requires_approval boolean not null default true,
  created_at timestamptz not null default now(),
  unique (product_id, permission),
  constraint high_risk_permissions_require_approval check (
    requires_approval = true or permission not in ('SEND','PUBLISH','DELETE','FINANCIAL_ACTION')
  )
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.listings(id) on delete cascade,
  kind text not null check (kind in ('purchase','subscription','usage')),
  status text not null default 'active' check (status in ('active','canceled','expired')),
  source_purchase_id uuid references public.purchases(id) on delete set null,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, product_id)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id uuid not null references public.listings(id) on delete cascade,
  product_version integer not null,
  status text not null default 'queued'
    check (status in ('queued','running','waiting_for_approval','succeeded','failed','cancelled','timed_out')),
  is_sandbox boolean not null default false,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error text,
  cost numeric not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  tool_id uuid references public.tools(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','running','succeeded','failed','skipped')),
  input jsonb,
  output jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, step_index)
);

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

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  requested_permission text not null
    check (requested_permission in ('READ','WRITE','SEND','PUBLISH','DELETE','FINANCIAL_ACTION')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending','processing','paid','failed')),
  related_purchase_id uuid references public.purchases(id) on delete set null,
  related_run_id uuid references public.runs(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- INDEXES (non-constraint-backed only; PK/UNIQUE indexes are implicit above)
-- ============================================================================
create index listings_seller_id_idx on public.listings (seller_id);
create index listings_status_idx on public.listings (status);
create index listings_product_type_idx on public.listings (product_type);
create index purchases_user_id_idx on public.purchases (user_id);
create index purchases_listing_id_idx on public.purchases (listing_id);
create index reviews_user_id_idx on public.reviews (user_id);
create index reviews_listing_id_idx on public.reviews (listing_id);
create index disputes_buyer_id_idx on public.disputes (buyer_id);
create index disputes_listing_id_idx on public.disputes (listing_id);
create index disputes_status_idx on public.disputes (status);
create index product_tools_product_id_idx on public.product_tools (product_id);
create index product_tools_tool_id_idx on public.product_tools (tool_id);
create index product_permissions_product_id_idx on public.product_permissions (product_id);
create index entitlements_user_id_idx on public.entitlements (user_id);
create index entitlements_product_id_idx on public.entitlements (product_id);
create index entitlements_source_purchase_id_idx on public.entitlements (source_purchase_id);
create index runs_user_id_idx on public.runs (user_id);
create index runs_product_id_idx on public.runs (product_id);
create index runs_status_idx on public.runs (status);
create index run_steps_run_id_idx on public.run_steps (run_id);
create index run_steps_tool_id_idx on public.run_steps (tool_id);
create index usage_events_user_id_idx on public.usage_events (user_id);
create index usage_events_product_id_idx on public.usage_events (product_id);
create index usage_events_run_id_idx on public.usage_events (run_id);
create index approvals_run_id_idx on public.approvals (run_id);
create index approvals_status_idx on public.approvals (status);
create index approvals_decided_by_idx on public.approvals (decided_by);
create index payouts_creator_id_idx on public.payouts (creator_id);
create index payouts_status_idx on public.payouts (status);
create index payouts_related_purchase_id_idx on public.payouts (related_purchase_id);
create index payouts_related_run_id_idx on public.payouts (related_run_id);
create index audit_log_actor_id_idx on public.audit_log (actor_id);
create index audit_log_target_idx on public.audit_log (target_type, target_id);
create index audit_log_created_at_idx on public.audit_log (created_at);

-- ============================================================================
-- FUNCTIONS (final live definitions, exact security context)
-- ============================================================================

create function private.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = (select auth.uid()))
    and (
      not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = (select auth.uid()) and f.status = 'verified'
      )
      or coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
    ),
    false
  );
$$;
revoke execute on function private.is_admin() from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;

create function private.is_admin_mfa()
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.is_admin() and coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2';
$$;
-- NOTE: production leaves this at the Postgres default (EXECUTE granted to
-- PUBLIC, never explicitly revoked) -- confirmed live via
-- information_schema.role_routine_grants before writing this file. Not
-- revoking here intentionally preserves that exact current state.

create function private.owns_listing(check_listing_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.listings l
    where l.id = check_listing_id and l.seller_id = (select auth.uid())
  );
$$;
revoke execute on function private.owns_listing(uuid) from public, anon, authenticated;
grant execute on function private.owns_listing(uuid) to authenticated;

create function private.owns_product(check_product_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select private.owns_listing(check_product_id);
$$;
revoke execute on function private.owns_product(uuid) from public, anon, authenticated;
grant execute on function private.owns_product(uuid) to authenticated;

create function private.can_view_run(check_run_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.runs r
    where r.id = check_run_id
      and (r.user_id = (select auth.uid()) or private.owns_product(r.product_id) or private.is_admin())
  );
$$;
revoke execute on function private.can_view_run(uuid) from public, anon, authenticated;
grant execute on function private.can_view_run(uuid) to authenticated;

create function private.protect_is_admin_column()
returns trigger language plpgsql security definer set search_path = ''
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
-- Left at PUBLIC-default execute, matching confirmed live state (trigger
-- functions are invoked by the trigger mechanism, not directly by role).

create function private.protect_kyc_review_fields()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    if new.status is distinct from old.status and new.status <> 'submitted' then
      new.status := old.status;
    end if;
    new.admin_note := old.admin_note;
    new.reviewed_at := old.reviewed_at;
  end if;
  return new;
end;
$$;

create function private.set_updated_at()
returns trigger language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
-- Not SECURITY DEFINER in production (confirmed live) -- matches original.

create function private.sync_listing_rating()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  target_listing_id uuid := coalesce(new.listing_id, old.listing_id);
begin
  update public.listings l
  set
    rating = (select round(avg(r.rating)::numeric, 1) from public.reviews r where r.listing_id = target_listing_id),
    reviews = (select count(*) from public.reviews r where r.listing_id = target_listing_id)
  where l.id = target_listing_id;
  return null;
end;
$$;
revoke execute on function private.sync_listing_rating() from public, anon, authenticated;

create function private.write_audit_log(
  p_actor_id uuid, p_action text, p_target_type text, p_target_id uuid, p_metadata jsonb default '{}'::jsonb
)
returns void language sql security definer set search_path = ''
as $$
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, p_action, p_target_type, p_target_id, p_metadata);
$$;
revoke execute on function private.write_audit_log(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

create function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = 'public'
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create function public.get_platform_stats()
returns table(threads_sold bigint, gross_paid numeric, review_count bigint, avg_rating numeric)
language sql stable security definer set search_path = ''
as $$
  select
    (select count(*) from public.purchases),
    (select coalesce(sum(amount), 0) from public.purchases where status = 'paid'),
    (select count(*) from public.reviews),
    (select coalesce(avg(rating), 0) from public.reviews)
$$;
revoke all on function public.get_platform_stats() from public;
grant execute on function public.get_platform_stats() to anon, authenticated;

create function public.resolve_dispute(p_dispute_id uuid, p_outcome text, p_note text default null)
returns public.disputes language plpgsql security definer set search_path = ''
as $$
declare
  v_dispute public.disputes;
begin
  if not (select private.is_admin_mfa()) then
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
  set status = p_outcome, resolution_note = p_note, resolved_by = (select auth.uid()), resolved_at = now()
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

create function public.set_seller_payout_account(p_linked_account_id text, p_status text)
returns void language plpgsql security definer set search_path = 'public'
as $$
begin
  if p_status not in ('not_started', 'pending', 'needs_clarification', 'active') then
    raise exception 'invalid razorpay_account_status: %', p_status;
  end if;
  update public.profiles
  set razorpay_linked_account_id = p_linked_account_id, razorpay_account_status = p_status
  where id = auth.uid();
end;
$$;
revoke all on function public.set_seller_payout_account(text, text) from public;
revoke all on function public.set_seller_payout_account(text, text) from anon;
grant execute on function public.set_seller_payout_account(text, text) to authenticated;

-- ============================================================================
-- TRIGGERS
-- ============================================================================
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create trigger protect_is_admin_column
  before update on public.profiles
  for each row execute procedure private.protect_is_admin_column();

create trigger reviews_sync_listing_rating
  after insert or update or delete on public.reviews
  for each row execute procedure private.sync_listing_rating();

create trigger seller_kyc_set_updated_at
  before update on public.seller_kyc
  for each row execute procedure private.set_updated_at();

create trigger seller_kyc_protect_review_fields
  before update on public.seller_kyc
  for each row execute procedure private.protect_kyc_review_fields();

create trigger tools_set_updated_at
  before update on public.tools
  for each row execute procedure private.set_updated_at();

create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute procedure private.set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY + POLICIES
-- ============================================================================
alter table public.profiles enable row level security;
alter table public.listings enable row level security;
alter table public.purchases enable row level security;
alter table public.reviews enable row level security;
alter table public.disputes enable row level security;
alter table public.seller_kyc enable row level security;
alter table public.tools enable row level security;
alter table public.product_tools enable row level security;
alter table public.product_permissions enable row level security;
alter table public.entitlements enable row level security;
alter table public.runs enable row level security;
alter table public.run_steps enable row level security;
alter table public.usage_events enable row level security;
alter table public.approvals enable row level security;
alter table public.payouts enable row level security;
alter table public.audit_log enable row level security;

-- profiles
create policy "Profiles are publicly readable" on public.profiles for select to anon, authenticated using (true);
create policy "Users can update their own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id);
create policy "Admins can update any profile" on public.profiles for update to authenticated
  using ((select private.is_admin_mfa())) with check ((select private.is_admin_mfa()));

-- listings
create policy "Live listings are publicly readable" on public.listings for select to anon, authenticated using (status = 'live');
create policy "Sellers can view their own listings regardless of status" on public.listings for select to authenticated using ((select auth.uid()) = seller_id);
create policy "Authenticated users can create their own listings" on public.listings for insert to authenticated with check ((select auth.uid()) = seller_id);
create policy "Admins can view all listings" on public.listings for select to authenticated using ((select private.is_admin()));
create policy "Admins can update any listing" on public.listings for update to authenticated using ((select private.is_admin_mfa()));
create policy "Buyers can view listings they've purchased" on public.listings for select to authenticated
  using (exists (select 1 from public.purchases pu where pu.listing_id = listings.id and pu.user_id = (select auth.uid())));

-- purchases
create policy "Users can view their own purchases" on public.purchases for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their own purchases" on public.purchases for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Sellers can view purchases of their own listings" on public.purchases for select to authenticated using ((select private.owns_listing(purchases.listing_id)));

-- reviews
create policy "Users can view their own reviews" on public.reviews for select to authenticated using ((select auth.uid()) = user_id);
create policy "Anyone can view reviews on live listings" on public.reviews for select to public
  using (exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live'));
create policy "Users can review any live listing" on public.reviews for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.listings l where l.id = reviews.listing_id and l.status = 'live')
    and (purchase_id is null or exists (
      select 1 from public.purchases pu where pu.id = purchase_id and pu.user_id = (select auth.uid()) and pu.listing_id = reviews.listing_id
    ))
  );

-- disputes
create policy "Buyers can view their own disputes" on public.disputes for select to authenticated using ((select auth.uid()) = buyer_id);
create policy "Buyers can file a dispute on their own paid purchase" on public.disputes for insert to authenticated
  with check (
    (select auth.uid()) = buyer_id
    and exists (select 1 from public.purchases pu where pu.id = purchase_id and pu.user_id = (select auth.uid()) and pu.status = 'paid' and pu.purchased_at > now() - interval '48 hours')
  );
create policy "Sellers can view disputes on their own listings" on public.disputes for select to authenticated using ((select private.owns_listing(disputes.listing_id)));
create policy "Admins can view all disputes" on public.disputes for select to authenticated using ((select private.is_admin()));

-- seller_kyc
create policy "Sellers can view their own KYC record" on public.seller_kyc for select to authenticated using ((select auth.uid()) = user_id);
create policy "Sellers can create their own KYC record" on public.seller_kyc for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Sellers can update their own KYC record" on public.seller_kyc for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Admins can view any KYC record" on public.seller_kyc for select to authenticated using ((select private.is_admin()));
create policy "Admins can update any KYC record" on public.seller_kyc for update to authenticated using ((select private.is_admin_mfa())) with check ((select private.is_admin_mfa()));

-- tools
create policy "Anyone can view enabled tools" on public.tools for select to anon, authenticated using (enabled = true);
create policy "Admins can view all tools" on public.tools for select to authenticated using ((select private.is_admin()));
create policy "Admins can manage tools" on public.tools for insert to authenticated with check ((select private.is_admin()));
create policy "Admins can update tools" on public.tools for update to authenticated using ((select private.is_admin()));
create policy "Admins can delete tools" on public.tools for delete to authenticated using ((select private.is_admin()));

-- product_tools
create policy "Anyone can view tools of live products" on public.product_tools for select to anon, authenticated
  using (exists (select 1 from public.listings l where l.id = product_tools.product_id and l.status = 'live'));
create policy "Creators can view their own product tools" on public.product_tools for select to authenticated using ((select private.owns_product(product_tools.product_id)));
create policy "Admins can view all product tools" on public.product_tools for select to authenticated using ((select private.is_admin()));
create policy "Creators can add tools to their own products" on public.product_tools for insert to authenticated with check ((select private.owns_product(product_tools.product_id)));
create policy "Creators can remove tools from their own products" on public.product_tools for delete to authenticated using ((select private.owns_product(product_tools.product_id)));
create policy "Admins can manage any product tools" on public.product_tools for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- product_permissions
create policy "Anyone can view permissions of live products" on public.product_permissions for select to anon, authenticated
  using (exists (select 1 from public.listings l where l.id = product_permissions.product_id and l.status = 'live'));
create policy "Creators can view their own product permissions" on public.product_permissions for select to authenticated using ((select private.owns_product(product_permissions.product_id)));
create policy "Admins can view all product permissions" on public.product_permissions for select to authenticated using ((select private.is_admin()));
create policy "Creators can declare permissions on their own products" on public.product_permissions for insert to authenticated with check ((select private.owns_product(product_permissions.product_id)));
create policy "Creators can remove permissions from their own products" on public.product_permissions for delete to authenticated using ((select private.owns_product(product_permissions.product_id)));
create policy "Admins can manage any product permissions" on public.product_permissions for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- entitlements
create policy "Users can view their own entitlements" on public.entitlements for select to authenticated using ((select auth.uid()) = user_id);
create policy "Creators can view entitlements to their own products" on public.entitlements for select to authenticated using ((select private.owns_product(entitlements.product_id)));
create policy "Admins can view all entitlements" on public.entitlements for select to authenticated using ((select private.is_admin()));

-- runs
create policy "Users can view their own runs" on public.runs for select to authenticated using ((select auth.uid()) = user_id);
create policy "Creators can view runs of their own products" on public.runs for select to authenticated using ((select private.owns_product(runs.product_id)));
create policy "Admins can view all runs" on public.runs for select to authenticated using ((select private.is_admin()));

-- run_steps
create policy "Users can view steps of runs they can view" on public.run_steps for select to authenticated using ((select private.can_view_run(run_steps.run_id)));

-- usage_events
create policy "Users can view their own usage events" on public.usage_events for select to authenticated using ((select auth.uid()) = user_id);
create policy "Creators can view usage events on their own products" on public.usage_events for select to authenticated using ((select private.owns_product(usage_events.product_id)));
create policy "Admins can view all usage events" on public.usage_events for select to authenticated using ((select private.is_admin()));

-- approvals
create policy "Users can view approvals on runs they can view" on public.approvals for select to authenticated using ((select private.can_view_run(approvals.run_id)));

-- payouts
create policy "Creators can view their own payouts" on public.payouts for select to authenticated using ((select auth.uid()) = creator_id);
create policy "Admins can view all payouts" on public.payouts for select to authenticated using ((select private.is_admin()));

-- audit_log
create policy "Admins can view the audit log" on public.audit_log for select to authenticated using ((select private.is_admin()));

-- ============================================================================
-- STORAGE BUCKETS + POLICIES
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-screenshots', 'listing-screenshots', true, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seller-kyc-documents', 'seller-kyc-documents', false, 10485760, array['image/png','image/jpeg','application/pdf'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('listing-files', 'listing-files', false)
on conflict (id) do nothing;

create policy "Listing screenshots are publicly readable" on storage.objects for select to public using (bucket_id = 'listing-screenshots');
create policy "Sellers can upload screenshots into their own folder" on storage.objects for insert to authenticated with check (bucket_id = 'listing-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can delete their own screenshots" on storage.objects for delete to authenticated using (bucket_id = 'listing-screenshots' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Admins can delete any screenshot" on storage.objects for delete to authenticated using (bucket_id = 'listing-screenshots' and (select private.is_admin()));

create policy "Sellers can upload their own KYC documents" on storage.objects for insert to authenticated with check (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can view their own KYC documents" on storage.objects for select to authenticated using (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can delete their own KYC documents" on storage.objects for delete to authenticated using (bucket_id = 'seller-kyc-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Admins can view any KYC document" on storage.objects for select to authenticated using (bucket_id = 'seller-kyc-documents' and (select private.is_admin()));

create policy "Sellers can upload their own listing files" on storage.objects for insert to authenticated with check (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can view their own listing files" on storage.objects for select to authenticated using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Sellers can delete their own listing files" on storage.objects for delete to authenticated using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Admins can view any listing file" on storage.objects for select to authenticated using (bucket_id = 'listing-files' and (select private.is_admin()));
create policy "Buyers can download files for purchases they made" on storage.objects for select to authenticated
  using (bucket_id = 'listing-files' and exists (
    select 1 from public.purchases p
    where p.listing_id = ((storage.foldername(name))[2])::uuid and p.user_id = (select auth.uid()) and p.status = 'paid'
  ));

-- ============================================================================
-- END OF BASELINE
-- Explicitly NOT captured (documented, not fabricated):
--   - DML/data rows in any table (per squash/baseline convention)
--   - Actual file objects in the 3 storage buckets (rows in storage.objects)
--   - Vault secrets, pg_cron jobs (none currently exist in this project)
--   - auth.* / storage.* platform-owned schema internals themselves
-- ============================================================================
