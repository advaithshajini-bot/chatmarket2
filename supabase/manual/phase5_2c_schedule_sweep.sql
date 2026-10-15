-- MANUAL STEP (deliberately NOT a migration). NOT TESTED in my scratch environment (pg_cron / pg_net / vault are not available there).
-- Purpose: call the reconciliation sweep every minute so a dispute opened late in the 48h window is held promptly even if the browser's
-- immediate call failed. Do this only after you have called the sweep by hand once and seen {"ok":true,...}.
--
-- 0. By hand first:  curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/payments/transfers/sweep
-- 1. Store the two values in Supabase Vault (Dashboard > Project Settings > Vault), names: sweep_url and sweep_cron_secret
--    (sweep_url = https://<your-domain>/api/payments/transfers/sweep ; sweep_cron_secret = the same value as the CRON_SECRET env var).
-- 2. Extensions (Dashboard > Database > Extensions): pg_cron and pg_net.
-- 3. Schedule (re-running with the same job name updates it):
select cron.schedule(
  'route-reconciliation-sweep', '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_url'),
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_cron_secret'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
  $$
);
-- 4. Verify after a couple of minutes (net._http_response holds the HTTP status of each call: expect 200):
select jobid, jobname, schedule, active from cron.job where jobname = 'route-reconciliation-sweep';
select status_code, created from net._http_response order by created desc limit 5;
-- EMERGENCY STOP:  select cron.unschedule('route-reconciliation-sweep');
-- (The feature flags are the real kill switches; with both OFF the sweep still holds / reverses existing transfers but creates and refunds nothing.)
