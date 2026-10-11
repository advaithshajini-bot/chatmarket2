-- Migration: add_update_dispatch_trigger   (Phase 4 / Milestone 4.0, item 1)
--
-- WHY: t1_dispatch_pending_step fires on INSERT only. A step that returns to
-- 'pending' by UPDATE (private.retry_or_fail_step: running -> pending, and
-- later the approval-resume path) was never dispatched, so nothing woke the
-- worker for it. This adds dispatch on running/waiting -> pending transitions.
--
-- WHY TWO TRIGGERS, NOT ONE "INSERT OR UPDATE OF status":
--   Postgres rejects a single trigger that covers INSERT and references OLD in
--   its WHEN clause:
--       ERROR: INSERT trigger's WHEN condition cannot reference OLD values
--   (verified against PostgreSQL 16). The equivalent, without a window in
--   which no dispatch trigger exists, is to leave t1 exactly as it is
--   (INSERT, new.status = 'pending') and add t2 for UPDATE OF status.
--   Both call the same private.dispatch_run_step(), which only needs
--   new.run_id, so the function is NOT modified.
--
-- BEHAVIOUR:
--   t1 (unchanged) : INSERT with status 'pending'                -> dispatch
--   t2 (new)       : UPDATE OF status where status changed
--                    to 'pending' (old.status IS DISTINCT FROM)   -> dispatch
--   No dispatch for: pending->running (claim), running->succeeded/failed,
--   updates that don't touch status, or status "updated" to the same value.
--
-- SAFETY: a duplicate or late dispatch is harmless. private.claim_next_step
-- returns step_already_running / no_pending_step / run_not_claimable, and the
-- worker exits without doing anything. The retry_count fence rejects a stale
-- worker's checkpoint after a retry. The dispatch function keeps its
-- fail-safe: if the Vault secrets are missing it returns without dispatching.
-- Note: a retry is dispatched immediately (no backoff). Acceptable while
-- maxRetriesPerStep = 1; revisit if that ceiling is raised.

create trigger t2_dispatch_pending_step_on_update
  after update of status on public.run_steps
  for each row
  when (new.status = 'pending' and old.status is distinct from new.status)
  execute function private.dispatch_run_step();
