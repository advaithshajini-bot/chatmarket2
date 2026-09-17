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
