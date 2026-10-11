# Part 2 — API Route Design

## Headline finding, found while designing this (not while planning it)

Every lifecycle function added in `20260920100400_add_run_lifecycle_functions.sql`
is **owner-only** — `revoke execute ... from public, anon, authenticated,
service_role` — explicitly, deliberately, per that file's own comment:
*"No client-callable create/cancel/claim/checkpoint/approval entry point
exists yet. The only wrapper is `public.worker_retry_or_fail_step`."*

That means: **a route cannot call `private.create_run` today, at all,
regardless of who's logged in** — not because of a bug, but because it was
never given a client-reachable entry point. The existing codebase's routes
(checked against `app/api/listings/create-workflow-agent/route.js`) use a
session-scoped client (`getVerifiedUser` + RLS), which authenticates as
`authenticated` — explicitly one of the four revoked roles.

**Consequence for this design**: Part 2 can't be routes alone. It has to
include the spec for new thin wrapper functions — exactly the pattern
already proven and verified live (Gate 6) for
`public.worker_retry_or_fail_step` — one per client-facing action. These
are specified below but **not created**; creating them is real DDL against
production and is Part 3's job, with its own explicit approval, not
something to slip in while "just designing routes."

## Wrapper functions needed (spec only — not created)

| Wrapper | Delegates to | Grant | Ownership check |
|---|---|---|---|
| `public.start_run(p_product_id uuid, p_input jsonb, p_is_sandbox boolean)` | `private.create_run(auth.uid(), p_product_id, p_input, p_is_sandbox)` | `authenticated` only | Implicit — always uses `auth.uid()`, never a client-supplied user id (this is the actual IDOR guard: a caller can never create a run "as" someone else, because the wrapper doesn't accept a user id argument at all) |
| `public.cancel_my_run(p_run_id uuid)` | `private.cancel_run(p_run_id)` | `authenticated` only | **Must check** `exists (select 1 from public.runs where id = p_run_id and user_id = auth.uid())` before delegating — `private.cancel_run` itself does NOT check ownership (confirmed: its own comment says authorization is deliberately left to "the exposure layer"). Getting this check right is the actual security-critical part of this wrapper. |
| `public.decide_my_approval(p_approval_id uuid, p_decision text)` | `private.decide_approval(p_approval_id, p_decision, auth.uid())` | `authenticated` only | **Open design decision, not invented here**: `private.decide_approval` takes a `p_decided_by` but enforces nothing about who's allowed to decide. The architecture doc never resolved who approves — product owner? Admin? Both? This wrapper cannot be written correctly until that's answered. Flagging it rather than guessing. |
| `public.worker_claim_next_step(p_run_id uuid)` | `private.claim_next_step(p_run_id)` | `service_role` only | None needed — service_role is the trusted worker boundary, same as the existing `worker_retry_or_fail_step` |
| `public.worker_checkpoint_step(p_run_id uuid, p_step_id uuid, p_expected_retry_count integer, p_output jsonb, p_cost_delta numeric)` | `private.checkpoint_step(...)` | `service_role` only | None needed, same reasoning |
| `public.worker_recover_stale_run(p_run_id uuid)` | `private.recover_stale_run(p_run_id)` | `service_role` only | None needed — likely called on a schedule/poll, not per-request |

Each of these, if built, should be `SECURITY DEFINER`, `set search_path = ''`,
fully qualified, one delegating statement, matching exactly how
`public.worker_retry_or_fail_step` is already built and verified. No new
pattern needed — just more instances of the one already proven.

## Routes, designed against those wrappers

All routes below use the existing `createClient()` / `getVerifiedUser()`
session pattern (not a service-role client) — matching every existing
route in the codebase. None of these are implemented yet; they're written
so L3-03/04/05 (from Part 1) have a real path to point at once they exist.

### `POST /api/runs` — start a run
```
Body: { productId: uuid, input?: object, isSandbox?: boolean }

1. getVerifiedUser -> 401 if not logged in
2. supabase.rpc('start_run', { p_product_id, p_input, p_is_sandbox })
3. Map RPC errors to HTTP status by errcode (see table below) -- NOT by
   string-matching the message, which is fragile
4. 201 { runId } on success
```

Error-code mapping (grounded in the actual `errcode`s `private.create_run`
raises, read directly from the migration file):

| errcode | Meaning | HTTP status |
|---|---|---|
| `CM010` | `execution_disabled` (flag off) | 503 |
| `CM011` | `product_not_found` | 404 |
| `CM012` | `product_not_executable` (not workflow/agent) | 400 |
| `CM013` | `not_entitled` | 403 |
| `CM014` | `product_not_live` | 403 |
| `CM015` | `daily_run_quota_exceeded` | 429 |
| `CM001`/`CM002` (surfaced via the L2 trigger, inside the same INSERT) | ceiling violation / invalid config | 500 — this would indicate `listings.configuration` itself is invalid, which L1/Phase-2 validation should have already prevented at listing-creation time; if this fires at run time it's a real bug, not a normal user-facing rejection |

This satisfies L3-03 (503 while flag is off) and L3-04 (the route never
reaches an INSERT when the flag check inside `create_run` fires first —
confirmed by reading the function: the flag check is the very first thing
it does, before the advisory lock, before anything is written) directly
from the real function body, not an assumption.

### `POST /api/runs/[id]/cancel`
```
1. getVerifiedUser -> 401
2. supabase.rpc('cancel_my_run', { p_run_id: params.id })
3. Wrapper's own ownership check handles the "someone else's run" case
   (RLS on `runs` already prevents even SEEING another user's run via
   normal select, but the RPC's explicit check is what actually stops the
   cancellation attempt, not RLS -- these are two different mechanisms
   and this design relies on both, deliberately)
4. 200 { outcome } on success/noop, 404 if the wrapper's ownership check
   fails (returned as "not found" rather than "forbidden" -- doesn't leak
   whether the run id exists at all to a non-owner)
```

### `POST /api/runs/[id]/approvals/[approvalId]/decide`
**Not specified beyond the shape** — blocked on the same open question as
`decide_my_approval` above (who's authorized to decide?). Writing this
route's authorization logic before that's answered would mean inventing a
security-relevant rule that was never actually decided.

## What this does NOT include

- The worker itself (Edge Function) — that's Part 3.
- The wrapper functions' actual SQL/migration — spec only, per the reasoning above.
- L1 validation module — still needed regardless (Part 3), and these
  routes should call it before ever hitting the RPC, exactly like
  `create-workflow-agent/route.js` calls `validateProductConfiguration`
  before its insert. Not written here since L1 doesn't exist yet either.
- Resolution of the approval-authorization question.
