-- 20260926100000_add_client_facing_wrappers.sql
--
-- Phase 3.2, Step 1 -- DRAFT FOR REVIEW ONLY. NOT APPLIED.
--
-- Adds the 6 client/worker-facing wrapper functions identified as missing
-- in Part 2 of the Gate 7 process: every lifecycle function in
-- 20260920100400 is owner-only, with zero callable entry point for any
-- client role, including service_role. This migration is purely additive
-- -- it changes NOTHING about the already-deployed, Gate-6/7-verified
-- private functions. Each wrapper is a single delegating statement,
-- matching the exact pattern already proven for
-- public.worker_retry_or_fail_step (20260920100300).
--
-- CORRECTION carried into this design (see conversation): the 3 ceilings
-- (maxRunsPerUserPerDay, maxStepOutputBytes, maxRunOutputBytes) reported
-- as "unenforced" during Gate 7 testing are actually already enforced --
-- inside private.create_run and private.checkpoint_step respectively,
-- confirmed by re-reading those functions' full bodies. This migration
-- does NOT re-implement those checks. Adding a second, independent check
-- in the wrapper layer would risk drifting out of sync with the
-- already-tested logic (different window definitions, different error
-- codes) for no safety benefit -- the wrappers below simply delegate,
-- and the existing private functions' own checks are what actually run.
--
-- USER-SCOPING, per this round's explicit architectural decision: runs
-- and approvals are strictly user-scoped. cancel_my_run, decide_my_approval,
-- and worker_recover_stale_run (below) each verify auth.uid() against the
-- run's own user_id BEFORE delegating -- none of the private functions
-- they call do this themselves (by design -- v9 §2.5 left authorization to
-- "the exposure layer", which is what this migration is).
--
-- All 6 functions: SECURITY DEFINER, `set search_path = ''`, fully
-- schema-qualified, no dynamic SQL.

-- ---------------------------------------------------------------------------
-- public.start_run -- user-facing. No user id parameter at all, by design:
-- the caller can never create a run "as" someone else, because there is
-- nothing to spoof. This IS the IDOR guard, not an added check.
-- ---------------------------------------------------------------------------
create function public.start_run(
  p_product_id  uuid,
  p_input       jsonb   default '{}'::jsonb,
  p_is_sandbox  boolean default false
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  select private.create_run(auth.uid(), p_product_id, p_input, p_is_sandbox);
$$;

revoke all on function public.start_run(uuid, jsonb, boolean) from public, anon, service_role;
grant execute on function public.start_run(uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- public.cancel_my_run -- user-scoped. Deliberately returns the same
-- 'not_found'-shaped rejection for "doesn't exist" and "exists but isn't
-- yours", so a non-owner can't distinguish the two (matches
-- PART2_ROUTE_DESIGN.md's route-level design for the same reason).
-- ---------------------------------------------------------------------------
create function public.cancel_my_run(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.runs r where r.id = p_run_id and r.user_id = auth.uid()
  ) then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'not_found');
  end if;
  return private.cancel_run(p_run_id);
end;
$$;

revoke all on function public.cancel_my_run(uuid) from public, anon, service_role;
grant execute on function public.cancel_my_run(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- public.decide_my_approval -- user-scoped, per this round's explicit
-- decision: auth.uid() must match the run's own user_id (the run's
-- CREATOR), not the product's seller and not an admin -- if approvals
-- should also be decidable by a seller or an admin, that's a further,
-- separate decision to make explicitly, not something folded in here
-- silently. p_decided_by is set to auth.uid() itself, never
-- caller-supplied, for the same spoofing reason as start_run above.
-- ---------------------------------------------------------------------------
create function public.decide_my_approval(p_approval_id uuid, p_decision text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.approvals a
      join public.runs r on r.id = a.run_id
     where a.id = p_approval_id
       and r.user_id = auth.uid()
  ) then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'not_found');
  end if;
  return private.decide_approval(p_approval_id, p_decision, auth.uid());
end;
$$;

revoke all on function public.decide_my_approval(uuid, text) from public, anon, service_role;
grant execute on function public.decide_my_approval(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- public.worker_claim_next_step -- worker-only, matches the
-- worker_retry_or_fail_step pattern exactly.
-- ---------------------------------------------------------------------------
create function public.worker_claim_next_step(p_run_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.claim_next_step(p_run_id);
$$;

revoke all on function public.worker_claim_next_step(uuid) from public, anon, authenticated;
grant execute on function public.worker_claim_next_step(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- public.worker_checkpoint_step -- worker-only. Ceiling checks (output
-- size, cost) happen inside private.checkpoint_step itself, already
-- deployed and tested -- nothing duplicated here.
-- ---------------------------------------------------------------------------
create function public.worker_checkpoint_step(
  p_run_id                uuid,
  p_step_id               uuid,
  p_expected_retry_count  integer,
  p_output                jsonb,
  p_cost_delta            numeric default 0
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.checkpoint_step(p_run_id, p_step_id, p_expected_retry_count, p_output, p_cost_delta);
$$;

revoke all on function public.worker_checkpoint_step(uuid, uuid, integer, jsonb, numeric) from public, anon, authenticated;
grant execute on function public.worker_checkpoint_step(uuid, uuid, integer, jsonb, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- public.worker_recover_stale_run -- the one deliberate exception to the
-- worker_*-means-service_role-only naming pattern (see PART3_WORKER_PLAN.md):
-- this is invoked by a USER'S OWN status read (recovery-on-read), not by
-- the worker itself, so it's granted to `authenticated`, not
-- `service_role`. Because of that, it needs the same user-scoping as
-- cancel_my_run -- the private function itself has no ownership check
-- (it only takes a run id), so without this guard any logged-in user
-- could force stale-recovery processing against an arbitrary run they
-- don't own. Silently returns 'noop' rather than an error for a
-- non-owned run id, same not_found-shaped non-disclosure as the others.
-- ---------------------------------------------------------------------------
create function public.worker_recover_stale_run(p_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.runs r where r.id = p_run_id and r.user_id = auth.uid()
  ) then
    return jsonb_build_object('outcome', 'noop', 'reason', 'not_found');
  end if;
  return private.recover_stale_run(p_run_id);
end;
$$;

revoke all on function public.worker_recover_stale_run(uuid) from public, anon, service_role;
grant execute on function public.worker_recover_stale_run(uuid) to authenticated;
