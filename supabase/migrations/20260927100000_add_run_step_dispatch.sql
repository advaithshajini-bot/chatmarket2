-- 20260927100000_add_run_step_dispatch.sql
--
-- Phase 3.2, Step 3 -- DRAFT FOR REVIEW ONLY. NOT APPLIED.
--
-- Adds asynchronous dispatch: when a run_step becomes pending, fire the
-- deployed execution-worker Edge Function so it doesn't have to wait for
-- the next recovery-on-read poll. This is Option A from the earlier
-- dispatch-mechanism decision.
--
-- SCOPE, deliberately narrower than originally sketched in Part 3:
--   - Only ONE trigger (T1), on run_steps INSERT WHEN status='pending'.
--     Confirmed by re-reading 20260920100400: both private.create_run's
--     first-step insert AND private.checkpoint_step's next-step insert
--     use this exact same INSERT+pending pattern, so one trigger covers
--     the entire normal step sequence -- no separate trigger needed for
--     "continuing" steps.
--   - NOT included: a trigger on run_steps UPDATE for retries (retry_or_
--     fail_step sets a step back to pending via UPDATE, which this
--     trigger's INSERT-only condition does not catch) -- recovery-on-read
--     (already built) is the intended catch-all for that, not a gap
--     introduced here.
--   - NOT included: a trigger on approvals (the original "T2"). Per
--     private.decide_approval's own comment, resuming a run after
--     approval was never implemented anywhere -- there is no code path
--     that turns waiting_for_approval back into a claimable run. Adding a
--     dispatch trigger for that would fire, find nothing claimable
--     (run_not_claimable), and do nothing. Building it now would repeat
--     the same premature-dependency mistake flagged before choosing
--     Option A in the first place.
--
-- FAIL-SAFE: if the Vault secrets below aren't set, this trigger silently
-- does nothing (returns new without dispatching) rather than blocking the
-- INSERT that created the step. Recovery-on-read remains the real safety
-- net regardless of whether dispatch succeeds.

create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- private.dispatch_run_step: reads the worker URL and shared secret from
-- Vault (never hardcoded, never passed as a trigger argument -- keeping it
-- out of any repo/migration file entirely), then fires an async POST via
-- pg_net. net.http_post itself queues the request as part of the current
-- transaction, so if the transaction that created the step later rolls
-- back, the queued dispatch never actually sends -- consistent with only
-- dispatching for steps that really exist.
-- ---------------------------------------------------------------------------
create function private.dispatch_run_step()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'execution_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'execution_worker_shared_secret';

  if v_url is null or v_secret is null then
    return new; -- fail-safe: no dispatch config yet, don't block the insert
  end if;

  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('runId', new.run_id),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_secret, 'Content-Type', 'application/json')
  );

  return new;
end;
$$;

revoke execute on function private.dispatch_run_step() from public, anon, authenticated, service_role;

create trigger t1_dispatch_pending_step
  after insert on public.run_steps
  for each row
  when (new.status = 'pending')
  execute function private.dispatch_run_step();
