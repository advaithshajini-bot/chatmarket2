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
