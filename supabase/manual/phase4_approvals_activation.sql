-- MANUAL, NOT A MIGRATION. Phase 4 / Milestone 4.1 activation reference.
-- Nothing in the repository turns phase4_approvals on. Run these by hand, in order.
-- The functions are tested against a scratch Postgres; the pg_cron parts (steps 3 and 6)
-- and everything on your real Supabase project are NOT tested by me.

-- 0. PRECONDITIONS ---------------------------------------------------------------
--    * migrations 20260930100200 and 20260930100300 applied and ledger-verified
--    * `node tests/phase4/run-all.mjs` green against a scratch DB
--    * the Phase 3 gate (tests/phase3/run-all.mjs) still green
select name, enabled from private.feature_flags order by name;
--    expect: phase3_execution | f     phase4_approvals | f

-- 1. WHO IS AFFECTED. A step gates on steps[i].tool.permission. List live listings that have one.
--    Once phase3_execution is ON, a run of any of these FAILS CLOSED ('approvals_disabled')
--    at that step until phase4_approvals is ON. Review this list before activating either flag.
select id, title, seller_id, status
  from public.listings
 where product_type in ('workflow', 'agent')
   and jsonb_typeof(configuration -> 'steps') = 'array'
   and exists (select 1 from jsonb_array_elements(configuration -> 'steps') s
                where s -> 'tool' ->> 'permission' is not null);

-- 2. Schedule the expiry sweep BEFORE activating, so approvals can never sit past their 24 h TTL
--    (pg_cron; same pattern as supabase/manual/schedule_sweep_stale_runs.sql)
create extension if not exists pg_cron;
select cron.schedule('expire-pending-approvals', '* * * * *', $$select private.expire_pending_approvals()$$);
select jobid, jobname, schedule, active from cron.job where jobname = 'expire-pending-approvals';

-- 3. ACTIVATE (phase3_execution must ALSO be on, or approving is refused 'execution_disabled')
update private.feature_flags set enabled = true, updated_at = now() where name = 'phase4_approvals';
select name, enabled from private.feature_flags order by name;

-- 4. ROLLBACK (instant; read fresh on every call)
update private.feature_flags set enabled = false, updated_at = now() where name = 'phase4_approvals';
--    What OFF means, so nothing surprises you:
--      * a gated step that has no approval yet  -> run FAILS closed 'approvals_disabled'
--      * pending approvals stay pending; APPROVING them is refused ('approvals_disabled')
--      * REJECTING them and the expiry sweep keep working (they only fail runs closed)
--      * a step that was already approved still runs normally

-- 5. WATCH WHILE ON
select r.id, r.status, r.created_at, a.requested_permission, a.expires_at
  from public.approvals a join public.runs r on r.id = a.run_id
 where a.status = 'pending' order by a.expires_at;                       -- who is waiting
select status, count(*) from public.approvals where created_at > now() - interval '7 days' group by status;
select status, return_message, start_time from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'expire-pending-approvals')
 order by start_time desc limit 5;                                       -- expiry job health

-- 6. EMERGENCY STOP for the expiry job only (flag-independent)
-- select cron.unschedule('expire-pending-approvals');
