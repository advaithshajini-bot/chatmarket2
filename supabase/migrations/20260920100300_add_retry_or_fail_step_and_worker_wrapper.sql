-- Migration: add_retry_or_fail_step_and_worker_wrapper
--
-- Chatmarket 2.0 Phase 3.1 (architecture v8 §1-§3, v9 §2, v10 §2 = W1).
--
-- 1) private.retry_or_fail_step()  -- THE single authoritative retry/failure
--    transition. Called by BOTH a live worker (through the wrapper below) and
--    by stale recovery (private.recover_stale_run), so there is exactly one
--    retry policy.
-- 2) public.worker_retry_or_fail_step()  -- the thin W1 wrapper: the only
--    Data API entry point to (1).
--
-- ---------------------------------------------------------------------------
-- (1) private.retry_or_fail_step
--
-- * PL/pgSQL FUNCTION (not a procedure), no transaction-control statements.
--   It executes atomically inside whatever transaction invoked it (v8 §1).
-- * SECURITY DEFINER, function-level `SET search_path = ''`, every relation
--   and function schema-qualified, no dynamic SQL.
-- * Sequence (v8 §1), unchanged:
--     lock runs FIRST
--     -> verify run.status = 'running'
--     -> verify step ownership (step.run_id = run_id)
--     -> verify step.status = 'running'
--     -> verify retry_count = expected_retry_count      (the fence)
--     -> evaluate frozen max_retries via
--        execution_config -> 'steps' -> step_index       (v8 §2; never step_id)
--        v10: if the frozen retryLimit EXCEEDS the system ceiling (only
--        possible through a defect / direct privileged write) the step takes
--        the FAILURE branch with config_exceeds_system_ceiling. It is never
--        retried and NEVER clamped to 1.
--     -> running->pending (retry_count + 1)  OR  running->failed
--     -> finalize the run when the terminal branch is taken
-- * Lock order: runs -> (approvals: not touched here) -> run_steps.
-- * Returns jsonb {outcome: 'retried'|'failed'|'rejected', ...}. A rejected
--   call changes nothing.
--
-- Privileges (v9 §2.2 / v10 §2.3): EXECUTE is held by the OWNER ONLY. It is
-- explicitly revoked from PUBLIC, anon, authenticated AND service_role. In
-- Supabase, `service_role` is also the role a secret key authenticates as, so
-- it must not be able to call this function directly.
-- ---------------------------------------------------------------------------

create function private.retry_or_fail_step(
  p_run_id                uuid,
  p_step_id               uuid,
  p_expected_retry_count  integer,
  p_error                 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c          jsonb := private.system_ceilings();
  v_run      public.runs%rowtype;
  v_step     public.run_steps%rowtype;
  v_step_cfg jsonb;
  v_limit    numeric;
  v_fail_err text;
  v_new_ct   integer;
begin
  -- 1. lock runs first (global lock order: runs -> approvals -> run_steps)
  select r.* into v_run
    from public.runs r
   where r.id = p_run_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;

  -- 2. run must be running (a cancelled / finished run is never mutated)
  if v_run.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_running');
  end if;

  -- 3. step ownership: the step must belong to THIS run
  select s.* into v_step
    from public.run_steps s
   where s.id = p_step_id
     and s.run_id = p_run_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_in_run');
  end if;

  -- 4. step must be running
  if v_step.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_running');
  end if;

  -- 5. the fence: retry_count must still be what the caller claimed with
  if v_step.retry_count is distinct from p_expected_retry_count then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'fencing_mismatch');
  end if;

  -- 6. frozen retry policy, looked up by step_index (never step_id)
  v_step_cfg := v_run.execution_config -> 'steps' -> v_step.step_index;
  if jsonb_typeof(v_step_cfg) is distinct from 'object'
     or jsonb_typeof(v_step_cfg -> 'retryLimit') is distinct from 'number' then
    v_fail_err := 'config_invalid_for_execution:retryLimit';
  else
    v_limit := (v_step_cfg ->> 'retryLimit')::numeric;
    if v_limit <> trunc(v_limit) or v_limit < 0 then
      v_fail_err := 'config_invalid_for_execution:retryLimit';
    elsif v_limit > (c ->> 'maxRetriesPerStep')::numeric then
      -- v10: fail closed. Do NOT clamp to the ceiling.
      v_fail_err := 'config_exceeds_system_ceiling:retryLimit';
    end if;
  end if;

  -- 7a. retry: running -> pending, retry_count + 1 (invalidates the old fence)
  if v_fail_err is null and v_step.retry_count < v_limit then
    v_new_ct := v_step.retry_count + 1;
    update public.run_steps s
       set status       = 'pending',
           retry_count  = v_new_ct,
           error        = left(p_error, 2000),
           started_at   = null,
           completed_at = null
     where s.id = v_step.id
       and s.run_id = p_run_id;
    return jsonb_build_object(
      'outcome', 'retried',
      'step_id', v_step.id,
      'step_index', v_step.step_index,
      'retry_count', v_new_ct
    );
  end if;

  -- 7b. terminal: running -> failed, then finalize the run in the same
  --     transaction (never separately)
  update public.run_steps s
     set status       = 'failed',
         error        = left(coalesce(v_fail_err, p_error), 2000),
         completed_at = now()
   where s.id = v_step.id
     and s.run_id = p_run_id;

  update public.runs r
     set status       = 'failed',
         error        = left(coalesce(v_fail_err, p_error), 2000),
         completed_at = now()
   where r.id = p_run_id;

  return jsonb_build_object(
    'outcome', 'failed',
    'step_id', v_step.id,
    'step_index', v_step.step_index,
    'reason', coalesce(v_fail_err, 'retry_limit_reached')
  );
end;
$$;

revoke execute on function private.retry_or_fail_step(uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (2) public.worker_retry_or_fail_step  -- W1 wrapper (v10 §2)
--
-- The credential boundary is possession of the server-side Supabase secret
-- key, which authenticates as service_role. The database does NOT distinguish
-- the worker from any other trusted backend holding that key. This is not a
-- "worker role".
--
-- * Thin: one top-level statement that delegates; no logic of its own
--   (preserves v8 §1's single-statement atomicity).
-- * SECURITY DEFINER, owner = the same migration owner as the private
--   function, `SET search_path = ''`, fully qualified.
-- * EXECUTE: service_role and the owner ONLY. Explicitly revoked from PUBLIC,
--   anon, authenticated -- essential because Supabase's default privileges on
--   schema `public` otherwise grant EXECUTE on new functions to anon and
--   authenticated (measured on the live project).
-- * service_role needs neither EXECUTE on the private function nor USAGE on
--   schema `private`; the wrapper runs as its owner.
-- ---------------------------------------------------------------------------

create function public.worker_retry_or_fail_step(
  p_run_id                uuid,
  p_step_id               uuid,
  p_expected_retry_count  integer,
  p_error                 text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.retry_or_fail_step(p_run_id, p_step_id, p_expected_retry_count, p_error);
$$;

revoke execute on function public.worker_retry_or_fail_step(uuid, uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.worker_retry_or_fail_step(uuid, uuid, integer, text)
  to service_role;
