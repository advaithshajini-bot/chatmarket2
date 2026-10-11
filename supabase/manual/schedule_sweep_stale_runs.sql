-- MANUAL STEP (deliberately NOT a migration -- apply only after
-- 20260930100100_add_sweep_stale_runs.sql is in and you have run it by hand once).
-- NOT TESTED in my scratch environment (pg_cron isn't available there).
-- The function it calls IS tested.

-- 0. Dry run by hand first. Expect {"scanned":0,"recovered":0,"noop":0,"errors":0} when nothing is stale.
select private.sweep_stale_runs();

-- 1. Enable pg_cron (Dashboard > Database > Extensions, or:)
create extension if not exists pg_cron;

-- 2. Schedule: every minute (stale threshold is 120 s, so worst-case recovery latency is about 3 min).
--    Re-running this with the same job name updates the existing job.
select cron.schedule('sweep-stale-runs', '* * * * *', $$select private.sweep_stale_runs()$$);

-- 3. Verify after a couple of minutes: status should be 'succeeded'
select jobid, jobname, schedule, active from cron.job where jobname = 'sweep-stale-runs';
select status, return_message, start_time, end_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'sweep-stale-runs')
 order by start_time desc limit 5;

-- EMERGENCY STOP for the sweep (independent of the phase3_execution flag):
-- select cron.unschedule('sweep-stale-runs');
