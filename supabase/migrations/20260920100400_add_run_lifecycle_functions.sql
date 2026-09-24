-- Migration: add_run_lifecycle_functions
--
-- Chatmarket 2.0 Phase 3.1 (architecture v8 §2-§3, v10 §B-§G).
--
-- The minimal database-side state-transition functions needed so that the
-- ceilings (L1/L2/L3), the frozen configuration, the retry fence, the
-- cancellation fence, the lock order and stale recovery are real, testable
-- behaviour rather than isolated definitions.
--
-- EXPOSURE (deliberately NOT decided here): v9 §2.5 left open whether the
-- W1 wrapper pattern applies to other internal functions, and v10 leaves it
-- open. So EVERY function below is private and OWNER-ONLY: EXECUTE is
-- revoked from PUBLIC, anon, authenticated and service_role, exactly like
-- private.write_audit_log. No client-callable create/cancel/claim/checkpoint/
-- approval entry point exists yet. The only wrapper is
-- public.worker_retry_or_fail_step (previous migration).
--
-- Every function is SECURITY DEFINER with `SET search_path = ''`, is fully
-- schema-qualified, uses no dynamic SQL, and acquires locks in the canonical
-- order  runs -> approvals -> run_steps  (never reversed; unused levels are
-- skipped).
--
-- NOT implemented (spec absent from the handoff or another phase): T1/T2/T3
-- dispatch triggers (pg_net is not installed), the Edge Function worker, the
-- idempotent "matching run" lookup, usage_events writes, approval pausing /
-- resume / recovery's approval-mismatch check, active-processing time
-- accounting for the 300 s budget.

-- ---------------------------------------------------------------------------
-- private.fail_run_closed: terminal failure of a run. PRECONDITION: the caller
-- already holds the runs row lock (lock order). Marks the running step failed,
-- every other unfinished step skipped, then the run failed -- one transaction.
-- ---------------------------------------------------------------------------
create function private.fail_run_closed(p_run_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.run_steps s
     set status       = case when s.status = 'running' then 'failed' else 'skipped' end,
         error        = left(p_reason, 2000),
         completed_at = now()
   where s.run_id = p_run_id
     and s.status in ('pending', 'running');

  update public.runs r
     set status       = 'failed',
         error        = left(p_reason, 2000),
         completed_at = now()
   where r.id = p_run_id
     and r.status in ('queued', 'running', 'waiting_for_approval');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.create_run: run creation + freezing (v8 §2, v10 §C).
-- * fail-closed feature flag
-- * per-user advisory lock so the 20/day quota is race-safe
-- * only workflow/agent products; entitlement required (or owner sandbox)
-- * execution_config := listings.configuration at THIS instant; the L2
--   trigger then asserts it against the ceilings inside the same statement,
--   so an over-ceiling configuration can never become a run row.
-- * creates the FIRST pending step only (subsequent steps are created one at
--   a time at checkpoint, per v8 §2)
-- ---------------------------------------------------------------------------
create function private.create_run(
  p_user_id     uuid,
  p_product_id  uuid,
  p_input       jsonb   default '{}'::jsonb,
  p_is_sandbox  boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c          jsonb := private.system_ceilings();
  v_listing  public.listings%rowtype;
  v_owner_sb boolean;
  v_entitled boolean;
  v_recent   integer;
  v_run_id   uuid;
begin
  if not private.is_execution_enabled() then
    raise exception using errcode = 'CM010', message = 'execution_disabled';
  end if;

  -- serialize this user's creations so the daily quota cannot be raced
  perform pg_advisory_xact_lock(hashtextextended('chatmarket:run_quota:' || p_user_id::text, 0));

  select l.* into v_listing from public.listings l where l.id = p_product_id;
  if not found then
    raise exception using errcode = 'CM011', message = 'product_not_found';
  end if;
  if v_listing.product_type not in ('workflow', 'agent') then
    raise exception using errcode = 'CM012', message = 'product_not_executable';
  end if;

  v_owner_sb := coalesce(p_is_sandbox, false) and v_listing.seller_id = p_user_id;

  select exists (
    select 1
      from public.entitlements e
     where e.user_id = p_user_id
       and e.product_id = p_product_id
       and e.status = 'active'
       and (e.current_period_end is null or e.current_period_end > now())
  ) into v_entitled;
  if not v_entitled and not v_owner_sb then
    raise exception using errcode = 'CM013', message = 'not_entitled';
  end if;
  if v_listing.status <> 'live' and not v_owner_sb then
    raise exception using errcode = 'CM014', message = 'product_not_live';
  end if;

  -- 20 runs / user / rolling 24 hours (system ceiling)
  select count(*) into v_recent
    from public.runs r
   where r.user_id = p_user_id
     and r.created_at > now() - interval '24 hours';
  if v_recent >= (c ->> 'maxRunsPerUserPerDay')::integer then
    raise exception using errcode = 'CM015', message = 'daily_run_quota_exceeded';
  end if;

  insert into public.runs (user_id, product_id, product_version, is_sandbox, input, execution_config)
  values (p_user_id, p_product_id, v_listing.version, coalesce(p_is_sandbox, false),
          coalesce(p_input, '{}'::jsonb), v_listing.configuration)
  returning id into v_run_id;                        -- L2 trigger fires here

  insert into public.run_steps (run_id, step_index, status)
  values (v_run_id, 0, 'pending');

  return v_run_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- private.claim_next_step: transactional claim (first claim and re-claim
-- after a retry). Lock path: runs -> run_steps.
-- L3: the frozen configuration is re-checked against the ceilings on every
-- claim; a violation fails the run CLOSED (no clamp, nothing executes).
-- ---------------------------------------------------------------------------
create function private.claim_next_step(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run  public.runs%rowtype;
  v_step public.run_steps%rowtype;
  v_msg  text;
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

  if v_run.status = 'queued' then
    update public.runs r set status = 'running', started_at = now() where r.id = p_run_id;
  end if;

  update public.run_steps s set status = 'running', started_at = now() where s.id = v_step.id;

  return jsonb_build_object(
    'outcome', 'claimed',
    'step_id', v_step.id,
    'step_index', v_step.step_index,
    'retry_count', v_step.retry_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- private.checkpoint_step: worker checkpoint (v5/v6). Lock path runs ->
-- run_steps. Verification order (user's task §5):
--   runs lock -> verify running -> verify step ownership -> verify running
--   step -> verify expected retry_count -> fenced writes.
-- A stale worker (fence invalidated by a retry, or run cancelled/finished)
-- is rejected and writes nothing.
-- L3 (independent of L1/L2): configuration re-check, 50 KiB/step and
-- 200 KiB/run output ceilings, and cost -- checked twice, independently,
-- against the frozen maxCostInr AND the constant ₹50 ceiling.
-- ---------------------------------------------------------------------------
create function private.checkpoint_step(
  p_run_id                uuid,
  p_step_id               uuid,
  p_expected_retry_count  integer,
  p_output                jsonb,
  p_cost_delta            numeric default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c           jsonb := private.system_ceilings();
  v_run       public.runs%rowtype;
  v_step      public.run_steps%rowtype;
  v_out       jsonb := coalesce(p_output, 'null'::jsonb);
  v_size      integer;
  v_prev_out  bigint;
  v_new_cost  numeric;
  v_frozen    numeric;
  v_total     integer;
  v_msg       text;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found');
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_running');
  end if;

  select s.* into v_step
    from public.run_steps s
   where s.id = p_step_id and s.run_id = p_run_id
     for update;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_in_run');
  end if;
  if v_step.status <> 'running' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_running');
  end if;
  if v_step.retry_count is distinct from p_expected_retry_count then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'fencing_mismatch');
  end if;
  if p_cost_delta is null or p_cost_delta < 0 then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'invalid_cost_delta');
  end if;

  -- L3: frozen configuration must still be within the ceilings
  begin
    perform private.assert_execution_config_within_ceilings(v_run.execution_config);
  exception when sqlstate 'CM001' or sqlstate 'CM002' then
    get stacked diagnostics v_msg = message_text;
    perform private.fail_run_closed(p_run_id, v_msg);
    return jsonb_build_object('outcome', 'failed', 'reason', v_msg);
  end;

  -- L3: output ceilings (system constants only; no product field can raise them)
  v_size := octet_length(v_out::text);
  if v_size > (c ->> 'maxStepOutputBytes')::integer then
    perform private.fail_run_closed(p_run_id, 'output_limit_exceeded:step');
    return jsonb_build_object('outcome', 'failed', 'reason', 'output_limit_exceeded:step');
  end if;
  select coalesce(sum(octet_length(s.output::text)), 0) into v_prev_out
    from public.run_steps s
   where s.run_id = p_run_id and s.status = 'succeeded' and s.id <> v_step.id;
  if v_prev_out + v_size > (c ->> 'maxRunOutputBytes')::bigint then
    perform private.fail_run_closed(p_run_id, 'output_limit_exceeded:run');
    return jsonb_build_object('outcome', 'failed', 'reason', 'output_limit_exceeded:run');
  end if;

  -- L3: cost, two independent checks (frozen product limit, then the constant ceiling)
  v_new_cost := v_run.cost + p_cost_delta;
  v_frozen   := (v_run.execution_config -> 'limits' ->> 'maxCostInr')::numeric;
  if v_new_cost > v_frozen or v_new_cost > (c ->> 'maxCostInrPerRun')::numeric then
    update public.runs r set cost = v_new_cost where r.id = p_run_id;   -- record what was incurred
    perform private.fail_run_closed(p_run_id, 'cost_limit_exceeded');
    return jsonb_build_object('outcome', 'failed', 'reason', 'cost_limit_exceeded');
  end if;

  -- fenced writes
  update public.run_steps s
     set status = 'succeeded', output = v_out, error = null, completed_at = now()
   where s.id = v_step.id and s.run_id = p_run_id;

  v_total := jsonb_array_length(v_run.execution_config -> 'steps');
  if v_step.step_index + 1 < v_total then
    insert into public.run_steps (run_id, step_index, status)
    values (p_run_id, v_step.step_index + 1, 'pending');
    update public.runs r set cost = v_new_cost where r.id = p_run_id;
    return jsonb_build_object('outcome', 'checkpointed', 'next_step_index', v_step.step_index + 1);
  end if;

  update public.runs r
     set status = 'succeeded', output = v_out, cost = v_new_cost, completed_at = now()
   where r.id = p_run_id;
  return jsonb_build_object('outcome', 'succeeded');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.cancel_run: cancellation (lock path: runs only, then the run's own
-- unfinished steps). Because a worker's checkpoint must first take the same
-- runs row lock and re-verify status = 'running', a cancelled run can never
-- be checkpointed, and a checkpoint that won the lock first is never
-- half-overwritten. AUTHORIZATION of who may cancel belongs to the (not yet
-- built) exposure layer, per the decision left open in v9 §2.5.
-- ---------------------------------------------------------------------------
create function private.cancel_run(p_run_id uuid)
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

  update public.run_steps s
     set status = 'skipped', error = 'run_cancelled', completed_at = now()
   where s.run_id = p_run_id and s.status in ('pending', 'running');

  update public.runs r
     set status = 'cancelled', completed_at = now()
   where r.id = p_run_id;

  return jsonb_build_object('outcome', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- private.decide_approval: DECISION ONLY (lock path runs -> approvals).
-- Records approved/rejected on a pending approval of a run that is waiting
-- for approval. It does NOT resume or cancel the run and does NOT touch
-- run_steps: the approval runtime is Phase 4 per the Phase 1 documentation
-- and `approvals` has no step reference, so resume semantics are an open
-- decision (reported), not something to invent here.
-- ---------------------------------------------------------------------------
create function private.decide_approval(p_approval_id uuid, p_decision text, p_decided_by uuid)
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
    return jsonb_build_object('outcome', 'noop', 'reason', 'already_decided');
  end if;
  if v_run.status <> 'waiting_for_approval' then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_waiting_for_approval');
  end if;

  update public.approvals a
     set status = p_decision, decided_by = p_decided_by, decided_at = now()
   where a.id = p_approval_id;

  return jsonb_build_object('outcome', 'decided', 'decision', p_decision);
end;
$$;

-- ---------------------------------------------------------------------------
-- private.recover_stale_run: recovery (v3-v8). Every input is derived from
-- database state; the only caller-supplied value is the run id. Lock path
-- runs -> run_steps (inside retry_or_fail_step). It hands the stale step to
-- the SAME private.retry_or_fail_step() a live worker uses, so there is one
-- retry policy. The stale threshold is a system constant (120 s: > 90 s
-- worker cutoff, < 150 s platform ceiling).
-- ---------------------------------------------------------------------------
create function private.recover_stale_run(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  c      jsonb := private.system_ceilings();
  v_run  public.runs%rowtype;
  v_step public.run_steps%rowtype;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id for update;
  if not found then
    return jsonb_build_object('outcome', 'noop', 'reason', 'run_not_found');
  end if;
  if v_run.status <> 'running' then
    return jsonb_build_object('outcome', 'noop', 'reason', 'run_not_running');
  end if;

  select s.* into v_step
    from public.run_steps s
   where s.run_id = p_run_id
     and s.status = 'running'
     and s.started_at < now() - make_interval(secs => (c ->> 'staleStepThresholdSeconds')::double precision)
   order by s.step_index
   limit 1
     for update;
  if not found then
    return jsonb_build_object('outcome', 'noop', 'reason', 'nothing_stale');
  end if;

  return private.retry_or_fail_step(p_run_id, v_step.id, v_step.retry_count, 'stale_worker_recovered');
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: OWNER ONLY for every function in this migration.
-- ---------------------------------------------------------------------------
revoke execute on function private.fail_run_closed(uuid, text)                          from public, anon, authenticated, service_role;
revoke execute on function private.create_run(uuid, uuid, jsonb, boolean)              from public, anon, authenticated, service_role;
revoke execute on function private.claim_next_step(uuid)                                from public, anon, authenticated, service_role;
revoke execute on function private.checkpoint_step(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated, service_role;
revoke execute on function private.cancel_run(uuid)                                     from public, anon, authenticated, service_role;
revoke execute on function private.decide_approval(uuid, text, uuid)                    from public, anon, authenticated, service_role;
revoke execute on function private.recover_stale_run(uuid)                              from public, anon, authenticated, service_role;
