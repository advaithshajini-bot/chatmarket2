-- Pre-launch waitlist (public launch January 2027). Additive: one new table, nothing existing is touched.
-- Written only by the server route /api/waitlist with the service-role key; anon and authenticated users get no access at all.
-- Rollback: drop table public.waitlist_signups;
create table if not exists public.waitlist_signups (
  id            uuid primary key default gen_random_uuid(),
  email         text not null check (length(email) between 5 and 254 and email = lower(email)),
  role_interest text not null default 'buyer' check (role_interest in ('buyer', 'seller', 'both')),
  created_at    timestamptz not null default now()
);
create unique index if not exists waitlist_signups_email_key on public.waitlist_signups (email);
alter table public.waitlist_signups enable row level security;   -- no policies on purpose: only service_role can read or write
revoke all on public.waitlist_signups from public, anon, authenticated;
grant select, insert on public.waitlist_signups to service_role;
