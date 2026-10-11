# Part 3 — Worker Implementation Plan

## Headline finding: there is no dispatch mechanism at all, and installing one is a real decision, not a formality

`20260920100400`'s own comment lists what it deliberately left out: *"T1/T2/T3
dispatch triggers (pg_net is not installed)."* Checked live, today: **neither
`pg_net` nor `pg_cron` is installed** on this project. So beyond "the worker
isn't deployed," there is currently no way for anything in the database to
*tell* a worker a step is ready — no trigger, no queue, no cron. This is the
actual first fork in this plan, and I'm laying out the choice rather than
picking one silently, because installing `pg_net` is itself production DDL
(`create extension`) requiring the same explicit approval as everything else
in this project, not something to bundle into "just building the worker."

### Option A — install `pg_net`, add DB-triggered dispatch (T1/T2)
A trigger on `run_steps` (`AFTER INSERT WHEN status='pending'`) and on
`approvals` (`AFTER UPDATE WHEN status: pending->approved`) calls
`net.http_post` to invoke the Edge Function immediately. Fastest step
pickup. Costs: a new extension (its own review), a new trigger (more
surface area on the hot `run_steps` table), and `pg_net`'s own async
delivery semantics (it queues an HTTP call, doesn't guarantee delivery
order or timing) need to be understood before relying on it.

### Option B — client-kick + recovery-on-read only, no new extension
The route that creates a run (`POST /api/runs`, from Part 2) fires the
first invocation itself, right after `start_run` returns successfully —
a plain `fetch()` to the Edge Function's URL, fire-and-forget, not awaited
by the HTTP response. Every subsequent step's pickup relies on
**recovery-on-read**: any authenticated read of a run's status (a new
`GET /api/runs/[id]` route, not yet designed in Part 2 — noted below)
opportunistically calls `worker_recover_stale_run` if the current step
looks stale. No new extension, no new trigger. Cost: a run can stall if
nobody happens to read its status and the client-kick fetch fails
silently (network blip, cold start) — bounded by
`staleStepThresholdSeconds` (120s) rather than being instant, but never
literally stuck forever, since a poll will eventually kick it.

**This plan proceeds with Option B** as the one to spec out in detail,
because it needs no new extension and no new trigger — smaller blast
radius, consistent with "do not perform unrelated upgrades." But this is
a real tradeoff (slower recovery vs. no new extension), not an obviously
correct choice, and Option A remains available if you'd rather have
near-instant dispatch and are fine reviewing `pg_net` separately.

## New route needed, not in Part 2: `GET /api/runs/[id]`

Part 2 only designed the write paths (create, cancel). Recovery-on-read
needs a read path that does more than a plain `select` — it needs to
detect staleness and trigger recovery before returning status. Spec:

```
GET /api/runs/[id]
1. getVerifiedUser -> 401
2. supabase.rpc('worker_recover_stale_run', { p_run_id: params.id })
   -- safe to call unconditionally: the function itself is a no-op
   -- (`outcome: 'noop'`) if the run isn't in 'running' status or nothing
   -- is actually stale (read directly from its body in the migration
   -- file -- it only acts if it finds a run_steps row past the
   -- threshold). Calling it on every read is not free (it takes a row
   -- lock briefly) but is bounded and safe.
3. supabase.from('runs').select(...).eq('id', params.id).single()
   -- RLS already restricts this to the run's own owner or the product's
   -- owner or an admin (Part 1's L3-06/L3-11 tests already cover this)
4. 200 { run } or 404 if RLS returns nothing
```

This route needs `worker_recover_stale_run` granted to `authenticated`,
**not** `service_role`-only like the other worker wrappers in Part 2 --
a genuine, deliberate exception to that pattern, because here the
*trigger* for recovery is a user's own read, not the worker itself. Noting
this explicitly so it isn't merged into Part 2's table by copy-paste
without the reasoning behind the different grant.

## The Edge Function itself

```
supabase/functions/execution-worker/index.ts   (NOT deployed -- spec/skeleton only)

Auth boundary: verify_jwt = false at the function-config level (per the
v10-agreed "secret key" worker model already decided earlier in this
project -- the function checks a bearer secret itself, matching the
`auth: 'secret:worker'` design, not Supabase's normal JWT verification).
The function then uses SUPABASE_SERVICE_ROLE_KEY to call the
`service_role`-granted wrappers.

1. Receive { runId } (from the client-kick POST, or invoked directly for
   a manual/testing dispatch).
2. Call worker_claim_next_step(runId).
   - outcome 'rejected' (any reason) -> log and exit 200 (nothing to do,
     not an error -- e.g. execution_disabled if the flag got flipped off
     mid-run, or step_already_running if another invocation beat this one
     to it -- the claim itself is the idempotency boundary, see below)
   - outcome 'failed' -> the ceiling re-check inside claim_next_step
     already called fail_run_closed; log and exit 200
   - outcome 'claimed' (with step details) -> continue
3. Call the AI provider via plain fetch (per the earlier-agreed
   Deno/Node-portable design) -- MOCKED/STUBBED for all Gate 7 work,
   never a real call, per the brief's own Step 9 instruction.
4. On success: call worker_checkpoint_step(runId, stepId,
   expectedRetryCount, output, costDelta).
   - outcome 'checkpointed' -> optionally re-invoke itself for the next
     step (fire-and-forget, same as the initial client-kick) rather than
     looping in-process -- keeps each invocation short, well under the
     150s Free-tier wall-clock ceiling already confirmed in an earlier
     gate of this project.
   - outcome 'succeeded' -> done.
   - outcome 'failed' (a ceiling was hit mid-step) -> done, already
     recorded.
5. On provider failure: call worker_retry_or_fail_step(runId, stepId,
   expectedRetryCount, errorText) -- the SAME function W1's tests in
   Part 1 already exercise directly. No separate retry logic in the
   worker itself; the worker's only job on failure is to report it and
   let the one authoritative retry policy decide.
6. Internal budget: hard-cut at 90s wall-clock inside the function
   (matching the ceiling already established), calling
   worker_retry_or_fail_step with a timeout reason if execution is still
   running past that -- never let the platform's own timeout be the
   thing that cuts it off uncleanly.
```

**Idempotency, stated precisely**: the claim in step 2 (a conditional
UPDATE inside `claim_next_step`, already deployed and covered by Part 1's
L2/W1 tests) is the single idempotency primitive. Two invocations racing
for the same step: one gets `'claimed'`, the other gets a rejection
(`step_already_running` or similar) from the same atomic operation. This
was already the architecture's stated design from much earlier in this
project ("atomic claim-via-conditional-UPDATE as the single idempotency
primitive") — Part 3 isn't introducing a new mechanism, just wiring the
worker to actually use the one already built and tested.

## What Part 3 would still need explicit approval for, before any of it is real

- Deciding Option A vs B (pg_net or not) -- flagged above, not decided unilaterally
- Creating the 6 wrapper functions from Part 2 (new migration)
- Granting `worker_recover_stale_run` to `authenticated` (a genuine
  exception to the service_role-only pattern, worth a second look before
  it's real)
- Actually deploying the Edge Function
- Setting `SUPABASE_SERVICE_ROLE_KEY` as a Function secret (credential handling -- not something to do casually even in a plan)
- Building the real AI-provider integration (out of scope for Gate 7 entirely, per the brief's Step 9)

None of this was created or deployed. This is a plan, same as Parts 1 and 2.
