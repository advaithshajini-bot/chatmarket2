-- Migration: add_approval_lifecycle   (Phase 4 / Milestone 4.1, part 2 of 2)
--
-- The approval-resume engine. Requires 20260930100200 (schema + flag).
--
-- WHAT IS GATED (reuses the product-configuration model that already exists
-- in lib/validation/{shared,agent,workflow}.js -- no new config key):
--   A step needs approval when it declares  steps[i].tool.permission = P  and
--     * P is high-risk (SEND, PUBLISH, DELETE, FINANCIAL_ACTION): ALWAYS.
--       Mirrors the DB's high_risk_permissions_require_approval rule; a
--       frozen config that says otherwise cannot waive it.
--     * P is READ / WRITE: unless EVERY grant for P in the frozen config's
--       permissions[] explicitly has requiresApproval = false.
--   Everything else defaults to "needs approval" (fail closed), including a
--   permission that was never declared. A malformed value fails the run
--   closed (CM002) rather than being guessed at.
--
-- FLOW
--   claim_next_step  -> step gated, no approval yet:
--                         [phase4_approvals off] fail run 'approvals_disabled'
--                         [on] claim the step, then request_approval(): approval
--                         row inserted, step AND run -> waiting_for_approval,
--                         claim released. All in the claim's own transaction, so
--                         the step is never observable as 'running'. Returns
--                         {outcome:'waiting_for_approval', ...}. The worker
--                         already treats any non-'claimed' outcome as "nothing
--                         to do", so NO worker redeploy is needed.
--   decide_approval  -> approve: approval 'approved', resume_after_approval():
--                         step -> pending (fires t2 dispatch), run -> running.
--                       reject : approval 'rejected', run FAILED 'approval_rejected'.
--                       lapsed : approval 'expired',  run FAILED 'approval_expired'.
--   expire_pending_approvals (cron) does the same for lapsed approvals nobody
--                       decided.
--   claim_next_step  -> step with an APPROVED approval: claimed normally, and
--                       never asks again (one approval per step, even across retries).
--
-- AUTHORIZATION is unchanged: public.decide_my_approval (previous migrations)
-- already requires auth.uid() = the run's creator and calls
-- private.decide_approval, which this migration replaces. The wrapper needs no
-- change. Seller / admin approval remains a separate, explicit decision.
--
-- FLAGS
--   * approving requires BOTH phase4_approvals and phase3_execution. Otherwise
--     the resume would create a pending step no worker will claim (stranded).
--   * rejecting and expiring work with the flags OFF: they only fail runs closed.
--
-- LOCK ORDER stays  runs -> approvals -> run_steps. Every function here takes
-- the runs row lock FIRST, which serializes all work on one run. The only
-- exception to the nominal order is request_approval, called from the claim,
-- which INSERTS a brand-new approvals row after the step lock: a row nobody
-- else can yet see or wait on, so no cycle is possible.
--
-- NOT DONE HERE (deliberately): maxRunActiveSeconds is only validated in the
-- config today, never enforced at runtime, so there is no active-time clock to
-- pause while waiting. When one is added, wait time = approvals.decided_at -
-- approvals.created_at.
--
-- All functions: SECURITY DEFINER, search_path = '', OWNER ONLY.

-- ---------------------------------------------------------------------------
-- private.step_approval_permission: which permission (if any) gates this step.
-- Pure function of the frozen config. Raises CM002 on malformed input.
-- ---------------------------------------------------------------------------
create function private.step_approval_permission(p_cfg jsonb, p_step_index integer)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_valid   constant text[] := array['READ','WRITE','SEND','PUBLISH','DELETE','FINANCIAL_ACTION'];
  v_high    constant text[] := array['SEND','PUBLISH','DELETE','FINANCIAL_ACTION'];
  v_step    jsonb;
  v_tool    jsonb;
  v_perm    text;
  v_grant   jsonb;
  v_waived  boolean := false;
  v_demands boolean := false;
begin
  v_step := p_cfg -> 'steps' -> p_step_index;
  if jsonb_typeof(v_step) is distinct from 'object' then
    raise exception using errcode = 'CM002',
      message = format('config_invalid_for_execution:steps[%s]', p_step_index);
  end if;

  if not (v_step ? 'tool') or jsonb_typeof(v_step -> 'tool') = 'null' then
    return null;
  end if;
  v_tool := v_step -> 'tool';
  if jsonb_typeof(v_tool) is distinct from 'object' then
    raise exception using errcode = 'CM002',
      message = format('config_invalid_for_execution:steps[%s].tool', p_step_index);
  end if;

  if not (v_tool ? 'permission') or jsonb_typeof(v_tool -> 'permission') = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_tool -> 'permission') is distinct from 'string'
     or not ((v_tool ->> 'permission') = any (v_valid)) then
    raise exception using errcode = 'CM002',
      message = format('config_invalid_for_execution:steps[%s].tool.permission', p_step_index);
  end if;
  v_perm := v_tool ->> 'permission';

  -- high-risk permissions can never be waived
  if v_perm = any (v_high) then
    return v_perm;
  end if;

  -- READ / WRITE: waived only if EVERY matching grant says requiresApproval = false
  if jsonb_typeof(p_cfg -> 'permissions') = 'array' then
    for v_grant in select e.value from jsonb_array_elements(p_cfg -> 'permissions') as e loop
      if jsonb_typeof(v_grant) = 'object' and (v_grant ->> 'permission') = v_perm then
        if (v_grant -> 'requiresApproval') = 'false'::jsonb then
          v_waived := true;
        else
          v_demands := true;
        end if;
      end if;
    end loop;
  end if;

  if v_waived and not v_demands then
    return null;
  end if;
  return v_perm;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.fail_run_closed (REPLACED): now also terminates a step that is
-- waiting for approval (-> 'failed', like a running one). Everything else is
-- unchanged. Precondition unchanged: caller holds the runs row lock.
-- ---------------------------------------------------------------------------
create or replace function private.fail_run_closed(p_run_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.run_steps s
     set status       = case when s.status in ('running', 'waiting_for_approval') then 'failed' else 'skipped' end,
         error        = left(p_reason, 2000),
         completed_at = now()
   where s.run_id = p_run_id
     and s.status in ('pending', 'running', 'waiting_for_approval');

  update public.runs r
     set status       = 'failed',
         error        = left(p_reason, 2000),
         completed_at = now()
   where r.id = p_run_id
     and r.status in ('queued', 'running', 'waiting_for_approval');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.cancel_run (REPLACED): a run waiting for approval can be cancelled.
-- Its pending approval is closed ('cancelled') and its waiting step skipped.
-- Order: runs -> approvals -> run_steps. Terminal runs are still a no-op.
-- ---------------------------------------------------------------------------
create or replace function private.cancel_run(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run public.runs%rowtype;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;
  if v_run.status in ('succeeded', 'failed', 'cancelled', 'timed_out') then
    return jsonb_build_object('outcome', 'noop', 'reason', 'already_terminal');
  end if;

  update public.approvals a
     set status = 'cancelled', decided_at = now()
   where a.run_id = p_run_id and a.status = 'pending';

  update public.run_steps s
     set status = 'skipped', error = 'run_cancelled', completed_at = now()
   where s.run_id = p_run_id and s.status in ('pending', 'running', 'waiting_for_approval');

  update public.runs r
     set status = 'cancelled', completed_at = now()
   where r.id = p_run_id;

  return jsonb_build_object('outcome', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.request_approval: insert the approval, park the step AND the run in
-- waiting_for_approval, release the claim. Fenced exactly like checkpoint /
-- retry: the step must be the caller's currently RUNNING step at the retry_count
-- it claimed with. One approval per step: a second request is rejected.
-- ---------------------------------------------------------------------------
create function private.request_approval(
  p_run_id                uuid,
  p_step_id               uuid,
  p_expected_retry_count  integer,
  p_permission            text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run     public.runs%rowtype;
  v_step    public.run_steps%rowtype;
  v_appr_id uuid;
  v_expires timestamptz;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;          -- 1. runs
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;
  if not private.is_approvals_enabled() then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approvals_disabled');
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_running');
  end if;
  if p_permission is null
     or p_permission not in ('READ','WRITE','SEND','PUBLISH','DELETE','FINANCIAL_ACTION') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_permission');
  end if;

  select s.* into v_step
    from public.run_steps s
   where s.id = p_step_id and s.run_id = p_run_id
     for update;                                                                      -- run_steps
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_in_run');
  end if;
  if v_step.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_running');
  end if;
  if v_step.retry_count is distinct from p_expected_retry_count then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'fencing_mismatch');
  end if;
  if exists (select 1 from public.approvals a where a.step_id = p_step_id) then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_already_exists');
  end if;

  v_expires := now() + private.approval_ttl();
  insert into public.approvals (run_id, step_id, requested_permission, status, expires_at)
  values (p_run_id, p_step_id, p_permission, 'pending', v_expires)
  returning id into v_appr_id;

  update public.run_steps s
     set status = 'waiting_for_approval', started_at = null     -- release the claim
   where s.id = p_step_id and s.run_id = p_run_id;

  update public.runs r set status = 'waiting_for_approval' where r.id = p_run_id;

  return jsonb_build_object(
    'outcome',     'waiting_for_approval',
    'approval_id', v_appr_id,
    'step_id',     p_step_id,
    'step_index',  v_step.step_index,
    'permission',  p_permission,
    'expires_at',  v_expires
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- private.resume_after_approval: step waiting_for_approval -> pending, run
-- waiting_for_approval -> running. retry_count is untouched. The
-- waiting -> pending UPDATE fires t2_dispatch_pending_step_on_update, which
-- wakes the worker. Called from decide_approval inside the decision's
-- transaction (caller already holds runs + approvals locks; they are re-taken
-- here, which is a no-op for the same transaction).
-- ---------------------------------------------------------------------------
create function private.resume_after_approval(p_run_id uuid, p_approval_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run  public.runs%rowtype;
  v_appr public.approvals%rowtype;
  v_step public.run_steps%rowtype;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;          -- 1. runs
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;
  if v_run.status <> 'waiting_for_approval' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_waiting_for_approval');
  end if;

  select a.* into v_appr
    from public.approvals a
   where a.id = p_approval_id and a.run_id = p_run_id
     for update;                                                                      -- 2. approvals
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_not_found');
  end if;
  if v_appr.status <> 'approved' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_not_approved');
  end if;
  if v_appr.step_id is null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_has_no_step');
  end if;

  select s.* into v_step
    from public.run_steps s
   where s.id = v_appr.step_id and s.run_id = p_run_id
     for update;                                                                      -- 3. run_steps
  if not found or v_step.status <> 'waiting_for_approval' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_waiting');
  end if;

  update public.run_steps s
     set status = 'pending', started_at = null
   where s.id = v_step.id and s.run_id = p_run_id;

  update public.runs r set status = 'running' where r.id = p_run_id;

  return jsonb_build_object('outcome', 'resumed', 'step_id', v_step.id, 'step_index', v_step.step_index);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.decide_approval (REPLACED). Was "decision only"; now it also acts.
-- Same signature, same (outcome, reason) vocabulary for the old cases.
-- ---------------------------------------------------------------------------
create or replace function private.decide_approval(p_approval_id uuid, p_decision text, p_decided_by uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_run    public.runs%rowtype;
  v_appr   public.approvals%rowtype;
  v_res    jsonb;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_decision');
  end if;

  -- unlocked read of the (immutable) parent run id, only to find which runs
  -- row to lock FIRST
  select a.run_id into v_run_id from public.approvals a where a.id = p_approval_id;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_not_found');
  end if;

  select r.* into v_run from public.runs r where r.id = v_run_id for update;          -- 1. runs
  select a.* into v_appr from public.approvals a
   where a.id = p_approval_id and a.run_id = v_run_id for update;                     -- 2. approvals
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_not_found');
  end if;

  if v_appr.status <> 'pending' then
    return jsonb_build_object('outcome', 'noop', 'reason',
      case when v_appr.status in ('approved', 'rejected') then 'already_decided'
           else 'approval_' || v_appr.status end);
  end if;
  if v_run.status <> 'waiting_for_approval' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_waiting_for_approval');
  end if;

  -- A lapsed approval can no longer be decided, whatever the decision was.
  -- (Returns normally -- raising would roll this expiry back.)
  if v_appr.expires_at is not null and v_appr.expires_at <= now() then
    update public.approvals a set status = 'expired', decided_at = now() where a.id = p_approval_id;
    perform private.fail_run_closed(v_run_id, 'approval_expired');
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_expired');
  end if;

  if p_decision = 'rejected' then
    update public.approvals a
       set status = 'rejected', decided_by = p_decided_by, decided_at = now()
     where a.id = p_approval_id;
    perform private.fail_run_closed(v_run_id, 'approval_rejected');
    return jsonb_build_object('outcome', 'decided', 'decision', 'rejected', 'run_status', 'failed');
  end if;

  -- approve: needs both flags (else the resumed step would never be claimed)
  if not private.is_approvals_enabled() then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approvals_disabled');
  end if;
  if not private.is_execution_enabled() then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'execution_disabled');
  end if;
  if v_appr.step_id is null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_has_no_step');
  end if;

  update public.approvals a
     set status = 'approved', decided_by = p_decided_by, decided_at = now()
   where a.id = p_approval_id;

  v_res := private.resume_after_approval(v_run_id, p_approval_id);
  if v_res ->> 'outcome' is distinct from 'resumed' then
    -- inconsistent state: abort the whole decision rather than leave an
    -- approved approval on a run that was not resumed
    raise exception using errcode = 'CM020',
      message = 'approval_resume_failed:' || coalesce(v_res ->> 'reason', 'unknown');
  end if;
  return jsonb_build_object('outcome', 'decided', 'decision', 'approved', 'run_status', 'running');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.expire_pending_approvals: batch sweep, for pg_cron. Same shape as
-- sweep_stale_runs: runs lock first with SKIP LOCKED (never queues behind live
-- traffic), per-run sub-transaction, bounded batch (1..200, default 50).
-- Not gated by any flag: it only ever fails runs closed.
-- Returns {scanned, expired, noop, errors}.
-- ---------------------------------------------------------------------------
create function private.expire_pending_approvals(p_batch_limit integer default 50)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_batch_limit, 50), 1), 200);
  v_run_id  uuid;
  v_appr_id uuid;
  v_appr    public.approvals%rowtype;
  v_scanned integer := 0;
  v_expired integer := 0;
  v_noop    integer := 0;
  v_errors  integer := 0;
begin
  for v_run_id, v_appr_id in
    select r.id, a.id
      from public.approvals a
      join public.runs r on r.id = a.run_id
     where a.status = 'pending'
       and a.expires_at is not null
       and a.expires_at <= now()
       and r.status = 'waiting_for_approval'
     order by a.expires_at, a.id
     limit v_limit
       for update of r skip locked                                                    -- 1. runs
  loop
    v_scanned := v_scanned + 1;
    begin
      select a.* into v_appr from public.approvals a where a.id = v_appr_id for update; -- 2. approvals
      if found and v_appr.status = 'pending' and v_appr.expires_at <= now() then
        update public.approvals a set status = 'expired', decided_at = now() where a.id = v_appr_id;
        perform private.fail_run_closed(v_run_id, 'approval_expired');
        v_expired := v_expired + 1;
      else
        v_noop := v_noop + 1;
      end if;
    exception when others then
      v_errors := v_errors + 1;
      raise warning 'expire_pending_approvals: failed for one approval (sqlstate %)', sqlstate;
    end;
  end loop;

  return jsonb_build_object('scanned', v_scanned, 'expired', v_expired, 'noop', v_noop, 'errors', v_errors);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.claim_next_step (REPLACED): original behaviour + the approval gate
-- (marked "4.1"). Return shape for every pre-existing outcome is unchanged.
-- New outcome: {outcome:'waiting_for_approval', approval_id, step_id,
--               step_index, permission, expires_at}.
-- The approvals lookup below is deliberately NOT locked: the runs row lock
-- already serializes every writer of this run's approvals.
-- ---------------------------------------------------------------------------
create or replace function private.claim_next_step(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run          public.runs%rowtype;
  v_step         public.run_steps%rowtype;
  v_appr         public.approvals%rowtype;
  v_perm         text;
  v_need_request boolean := false;
  v_req          jsonb;
  v_msg          text;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;

  if not private.is_execution_enabled() then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'execution_disabled');
  end if;

  if v_run.status not in ('queued', 'running') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_claimable');
  end if;

  begin
    perform private.assert_execution_config_within_ceilings(v_run.execution_config);
  exception when sqlstate 'CM001' or sqlstate 'CM002' then
    get stacked diagnostics v_msg = message_text;
    perform private.fail_run_closed(p_run_id, v_msg);
    return jsonb_build_object('outcome', 'failed', 'reason', v_msg);
  end;

  if exists (select 1 from public.run_steps s where s.run_id = p_run_id and s.status = 'running') then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_already_running');
  end if;

  select s.* into v_step
    from public.run_steps s
   where s.run_id = p_run_id
     and s.status = 'pending'
   order by s.step_index
   limit 1
     for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'no_pending_step');
  end if;

  -- 4.1: approval gate -------------------------------------------------------
  begin
    v_perm := private.step_approval_permission(v_run.execution_config, v_step.step_index);
  exception when sqlstate 'CM002' then
    get stacked diagnostics v_msg = message_text;
    perform private.fail_run_closed(p_run_id, v_msg);
    return jsonb_build_object('outcome', 'failed', 'reason', v_msg);
  end;

  if v_perm is not null then
    select a.* into v_appr from public.approvals a where a.step_id = v_step.id;
    if found then
      if v_appr.status = 'pending' then
        return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_pending');
      elsif v_appr.status <> 'approved' then
        return jsonb_build_object('outcome', 'rejected', 'reason', 'approval_not_granted');
      end if;
      -- approved: claim normally; one approval per step, never asked twice
    else
      if not private.is_approvals_enabled() then
        perform private.fail_run_closed(p_run_id, 'approvals_disabled');
        return jsonb_build_object('outcome', 'failed', 'reason', 'approvals_disabled');
      end if;
      v_need_request := true;
    end if;
  end if;
  -- end 4.1 gate ---------------------------------------------------------------

  if v_run.status = 'queued' then
    update public.runs r set status = 'running', started_at = now() where r.id = p_run_id;
  end if;

  update public.run_steps s set status = 'running', started_at = now() where s.id = v_step.id;

  if v_need_request then
    v_req := private.request_approval(p_run_id, v_step.id, v_step.retry_count, v_perm);
    if v_req ->> 'outcome' is distinct from 'waiting_for_approval' then
      perform private.fail_run_closed(p_run_id, 'approval_request_failed:' || coalesce(v_req ->> 'reason', 'unknown'));
      return jsonb_build_object('outcome', 'failed', 'reason', 'approval_request_failed');
    end if;
    return v_req;
  end if;

  return jsonb_build_object(
    'outcome', 'claimed',
    'step_id', v_step.id,
    'step_index', v_step.step_index,
    'retry_count', v_step.retry_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: OWNER ONLY for everything new; re-asserted for replaced
-- functions (CREATE OR REPLACE keeps the old ACL; this makes it explicit).
-- ---------------------------------------------------------------------------
revoke execute on function private.step_approval_permission(jsonb, integer)           from public, anon, authenticated, service_role;
revoke execute on function private.request_approval(uuid, uuid, integer, text)        from public, anon, authenticated, service_role;
revoke execute on function private.resume_after_approval(uuid, uuid)                  from public, anon, authenticated, service_role;
revoke execute on function private.expire_pending_approvals(integer)                  from public, anon, authenticated, service_role;
revoke execute on function private.fail_run_closed(uuid, text)                        from public, anon, authenticated, service_role;
revoke execute on function private.cancel_run(uuid)                                   from public, anon, authenticated, service_role;
revoke execute on function private.decide_approval(uuid, text, uuid)                  from public, anon, authenticated, service_role;
revoke execute on function private.claim_next_step(uuid)                              from public, anon, authenticated, service_role;
