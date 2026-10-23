-- REHEARSAL SEED for the monthly settlement flow.  SCRATCH / LOCAL / BRANCH DATABASE ONLY.  Never run this on production.
-- (It is deliberately NOT a migration: it lives in supabase/manual and is never applied automatically.)
--
-- Run it as the database owner (the SQL editor of a scratch project, or `psql` as postgres) AFTER every migration up to
-- 20261021100000_add_upi_cooldown.sql is applied. Safe to re-run: it first removes what an earlier run created, then recreates it.
--
-- SAFETY: it refuses to do anything if the database holds a purchase that is not a rehearsal purchase (payment id 'rehearsal_pay_...').
-- A production database always has real purchases, so this check stops you there. It also refuses if the settlement tables are missing.
--
-- What it creates (all names and ids are fake; e-mails end in @rehearsal.invalid):
--   Seller A  "Rehearsal A (payable)"        UPI saved, 3 sales last month, total Rs 817.54          -> PAYABLE
--   Seller B  "Rehearsal B (below minimum)"  UPI saved, 1 sale of Rs 40.18                           -> rolls over (below_minimum)
--   Seller C  "Rehearsal C (UPI in cooldown)" UPI CHANGED 5 hours ago, 1 sale of Rs 409.18           -> rolls over (upi_in_cooldown, matures in ~67h)
--   Seller D  "Rehearsal D (no UPI)"         no UPI ID saved, 1 sale of Rs 245.18                    -> rolls over (no_upi_id)
--   Seller E  "Rehearsal E (has a refund)"   UPI saved, 1 paid sale Rs 327.18 + 1 REFUNDED sale      -> PAYABLE for the paid sale only
-- It also sets the minimum payout to Rs 100 (private.settlement_config.min_payout_paise = 10000) so seller B is below it.
-- All sales are dated in the middle of LAST month (IST), so the default cut-off "the 1st of this month" includes them.
--
-- Expected preview (cut-off = 1st of this month): payable = A + E = 2 sellers, 4 purchases, Rs 1,144.72 (114472 paise);
-- not included = B (Rs 40.18 below_minimum), C (Rs 409.18 upi_in_cooldown), D (Rs 245.18 no_upi_id). The refunded sale is in none of them.
--
-- To try other cases by hand afterwards:
--   * make C payable:      update public.seller_payout_accounts set vpa_changed_at = now() - interval '80 hours' where user_id = '00000000-0000-4000-8000-0000000c0003';
--   * give D a UPI ID:     insert into public.seller_payout_accounts (user_id, vpa_address, status) values ('00000000-0000-4000-8000-0000000c0004', 'dave.rehearsal@okaxis', 'active');
--   * change the minimum:  update private.settlement_config set min_payout_paise = 50000 where id;      -- Rs 500
--   * change the cooldown: update private.settlement_config set upi_cooldown_hours = 168 where id;     -- 7 days
-- You sign in to the admin desk with YOUR OWN admin account (with its second factor); this script creates no admin and no password.

do $guard$
declare
  v_real integer;
begin
  if to_regclass('public.settlement_batches') is null or to_regclass('private.settlement_config') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'seller_payout_accounts' and column_name = 'vpa_changed_at') then
    raise exception 'REFUSING: the settlement migrations (up to 20261021100000_add_upi_cooldown.sql) are not all applied here.';
  end if;
  select count(*) into v_real from public.purchases p where p.razorpay_payment_id is distinct from null and p.razorpay_payment_id not like 'rehearsal\_pay\_%'
     or p.razorpay_payment_id is null;
  if v_real > 0 then
    raise exception 'REFUSING: this database holds % purchase(s) that are not rehearsal purchases. This script is for an empty scratch database only. Nothing was changed.', v_real;
  end if;
end
$guard$;

-- ---------------------------------------------------------------- reset: remove an earlier rehearsal run (rehearsal sellers and buyers only)
do $reset$
declare
  v_ids uuid[] := array[
    '00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000c0002', '00000000-0000-4000-8000-0000000c0003',
    '00000000-0000-4000-8000-0000000c0004', '00000000-0000-4000-8000-0000000c0005',
    '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000b0002']::uuid[];
begin
  delete from public.purchase_settlements where seller_id = any (v_ids);
  delete from public.settlement_items where seller_id = any (v_ids);
  delete from public.settlement_batches b where not exists (select 1 from public.settlement_items i where i.batch_id = b.id);
  delete from public.purchases where razorpay_payment_id like 'rehearsal\_pay\_%';
  delete from public.listings where seller_id = any (v_ids);
  delete from public.seller_payout_accounts where user_id = any (v_ids);
  delete from public.audit_log where actor_id = any (v_ids) or target_id = any (v_ids);
  delete from auth.users where id = any (v_ids);
end
$reset$;

-- ---------------------------------------------------------------- users (the profile rows are created by the project's own trigger)
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000c0001', 'seller.a@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000c0002', 'seller.b@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000c0003', 'seller.c@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000c0004', 'seller.d@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000c0005', 'seller.e@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000b0001', 'buyer.one@rehearsal.invalid'),
  ('00000000-0000-4000-8000-0000000b0002', 'buyer.two@rehearsal.invalid');

update public.profiles p set display_name = n.name
  from (values
    ('00000000-0000-4000-8000-0000000c0001'::uuid, 'Rehearsal A (payable)'),
    ('00000000-0000-4000-8000-0000000c0002'::uuid, 'Rehearsal B (below minimum)'),
    ('00000000-0000-4000-8000-0000000c0003'::uuid, 'Rehearsal C (UPI in cooldown)'),
    ('00000000-0000-4000-8000-0000000c0004'::uuid, 'Rehearsal D (no UPI)'),
    ('00000000-0000-4000-8000-0000000c0005'::uuid, 'Rehearsal E (has a refund)')) as n(id, name)
 where p.id = n.id;

-- ---------------------------------------------------------------- payout accounts (D deliberately has none)
insert into public.seller_payout_accounts (user_id, vpa_address, status) values
  ('00000000-0000-4000-8000-0000000c0001', 'alice.rehearsal@okhdfcbank', 'active'),
  ('00000000-0000-4000-8000-0000000c0002', 'bob.rehearsal@ybl',          'active'),
  ('00000000-0000-4000-8000-0000000c0003', 'carol.new@paytm',            'active'),
  ('00000000-0000-4000-8000-0000000c0005', 'erin.rehearsal@oksbi',       'active');
-- C changed their UPI ID 5 hours ago: inside the cooldown window (default 72h)
update public.seller_payout_accounts set vpa_changed_at = now() - interval '5 hours' where user_id = '00000000-0000-4000-8000-0000000c0003';

-- ---------------------------------------------------------------- the settings the rehearsal assumes
update private.settlement_config set min_payout_paise = 10000;      -- Rs 100: seller B (Rs 40.18) is below it
update private.settlement_config set start_at = '-infinity';        -- every paid sale counts (the default)

-- ---------------------------------------------------------------- listings and purchases (platform fee 18%; money is integer paise inside the database)
do $sales$
declare
  v_mid   timestamptz := (date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '15 days') at time zone 'Asia/Kolkata';   -- mid last month, IST
  v_buyer1 uuid := '00000000-0000-4000-8000-0000000b0001';
  v_buyer2 uuid := '00000000-0000-4000-8000-0000000b0002';
  r record;
  v_listing uuid;
  n integer := 0;
begin
  for r in
    select * from (values
      -- seller,                                   tag, price, purchase status, buyer, days after the mid-month mark
      ('00000000-0000-4000-8000-0000000c0001'::uuid, 'A1', 499::numeric, 'paid',     1, 0),
      ('00000000-0000-4000-8000-0000000c0001'::uuid, 'A2', 299::numeric, 'paid',     2, 1),
      ('00000000-0000-4000-8000-0000000c0001'::uuid, 'A3', 199::numeric, 'paid',     1, 2),
      ('00000000-0000-4000-8000-0000000c0002'::uuid, 'B1',  49::numeric, 'paid',     2, 0),
      ('00000000-0000-4000-8000-0000000c0003'::uuid, 'C1', 499::numeric, 'paid',     1, 3),
      ('00000000-0000-4000-8000-0000000c0004'::uuid, 'D1', 299::numeric, 'paid',     2, 1),
      ('00000000-0000-4000-8000-0000000c0005'::uuid, 'E1', 399::numeric, 'paid',     1, 0),
      ('00000000-0000-4000-8000-0000000c0005'::uuid, 'E2', 299::numeric, 'refunded', 2, 2)
    ) as t(seller, tag, price, pstatus, buyer, dayoff)
  loop
    n := n + 1;
    insert into public.listings (title, model, category, price, seller_name, seller_id, status)
    values ('Rehearsal listing ' || r.tag, 'Claude', 'Rehearsal', r.price, 'Rehearsal seller', r.seller, 'live')
    returning id into v_listing;
    insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at)
    values (case r.buyer when 1 then v_buyer1 else v_buyer2 end, v_listing, r.price, r.pstatus, 'rehearsal_pay_' || r.tag,
            round(r.price * 0.18, 2), v_mid + (r.dayoff || ' days')::interval);
  end loop;
  raise notice 'Rehearsal seed: % sales created for 5 sellers.', n;
end
$sales$;

-- ---------------------------------------------------------------- what the database will treat as payable (read-only check; same rules the admin desk uses)
select s.display_name as seller,
       count(*) as sales,
       sum(e.amount_paise) as owed_paise,
       a.vpa_address,
       case when a.user_id is null or a.vpa_address is null then 'no_upi_id'
            when a.status <> 'active' then 'account_' || a.status
            when a.vpa_changed_at is not null and a.vpa_changed_at + make_interval(hours => c.upi_cooldown_hours) > now() then 'upi_in_cooldown'
            when sum(e.amount_paise) < c.min_payout_paise then 'below_minimum'
            else 'PAYABLE' end as expected_outcome
  from private.settlement_eligible(now()) e
  join public.profiles s on s.id = e.seller_id
  left join public.seller_payout_accounts a on a.user_id = e.seller_id
  cross join private.settlement_config c
 where e.seller_id::text like '00000000-0000-4000-8000-0000000c000%'
 group by s.display_name, a.user_id, a.vpa_address, a.status, a.vpa_changed_at, c.upi_cooldown_hours, c.min_payout_paise
 order by 1;
