-- Migration: add_sweep_stale_runs   (Phase 4 / Milestone 4.0, item 2)
--
-- Recovery-on-read only runs when someone polls a run. This adds a batch
-- sweep so that unwatched runs whose worker died are still resolved. It is a
-- thin loop: every decision is made by private.recover_stale_run, the same
-- function recovery-on-read uses, so there is ONE retry/fail policy.
--
-- * The candidate query is only a hint. recover_stale_run re-locks the run
--   (runs -> run_steps) and re-checks that it is 'running' and that the step
--   is still stale, so a run that finished between the scan and the recovery
--   is a no-op, never a mutation.
-- * FOR UPDATE ... SKIP LOCKED: a run currently locked by a worker, a poll or
--   a cancel is skipped this tick and picked up on the next one, so the sweep
--   never queues behind (or deadlocks with) live traffic.
-- * Each run is recovered in its own sub-transaction: an exception on one run
--   is counted and logged (SQLSTATE only, no data) and the rest of the batch
--   still proceeds.
-- * Batch size is bounded (default 50, clamped to 1..200).
-- * Not gated on phase3_execution on purpose: with the flag off, a stale step
--   should still be resolved rather than left 'running'.
-- * A retried step returns to 'pending' by UPDATE, which fires
--   t2_dispatch_pending_step_on_update (previous migration) -> worker.
-- * OWNER ONLY. Revoked from PUBLIC, anon, authenticated and service_role.
--   The cron job runs as the job owner (postgres). It is deliberately NOT
--   reachable through PostgREST.
--
-- Returns {scanned, recovered, noop, errors}.
--   recovered = recover_stale_run returned 'retried' or 'failed'.

create function private.sweep_stale_runs(p_batch_limit integer default 50)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c           jsonb := private.system_ceilings();
  v_stale_s   double precision := (c ->> 'staleStepThresholdSeconds')::double precision;
  v_limit     integer := least(greatest(coalesce(p_batch_limit, 50), 1), 200);
  v_run_id    uuid;
  v_res       jsonb;
  v_scanned   integer := 0;
  v_recovered integer := 0;
  v_noop      integer := 0;
  v_errors    integer := 0;
begin
  for v_run_id in
    select r.id
      from public.runs r
     where r.status = 'running'
       and exists (
             select 1
               from public.run_steps s
              where s.run_id = r.id
                and s.status = 'running'
                and s.started_at < now() - make_interval(secs => v_stale_s)
           )
     order by r.started_at nulls last, r.id
     limit v_limit
       for update of r skip locked
  loop
    v_scanned := v_scanned + 1;
    begin
      v_res := private.recover_stale_run(v_run_id);
      if v_res ->> 'outcome' in ('retried', 'failed') then
        v_recovered := v_recovered + 1;
      else
        v_noop := v_noop + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'sweep_stale_runs: recovery failed for a run (sqlstate %)', sqlstate;
    end;
  end loop;

  return jsonb_build_object(
    'scanned',   v_scanned,
    'recovered', v_recovered,
    'noop',      v_noop,
    'errors',    v_errors
  );
end;
$$;

revoke execute on function private.sweep_stale_runs(integer)
  from public, anon, authenticated, service_role;
