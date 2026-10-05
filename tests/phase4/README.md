# Phase 4 tests (Milestones 4.0 - 4.3)

    DATABASE_URL=<owner connection> node tests/phase4/run-all.mjs        # needs `deno` on PATH
    PHASE4_DESTRUCTIVE_TESTS=1 ...                                        # + M40-S07/S08, scratch DB only

| Suite | File | Covers |
|---|---|---|
| M40-D | m40-dispatch-sweep.test.mjs | t1 unchanged; t2 fires only on status -> pending changes; retry path dispatches once; claim/complete/no-op updates don't |
| M40-S | same | sweep privileges (owner only, SECURITY DEFINER, search_path=''), stale/fresh/non-running runs, batch limit + clamping, SKIP LOCKED (S07), per-run exception isolation (S08) |
| M40-F | same | committed RPC fixtures (payload keys + function signatures) still equal what the live DB returns |
| WC-* | worker-contract/worker-contract.test.ts | the unmodified execution-worker/index.ts against a mock client that enforces the real RPC signatures; WC-13 proves the pre-fix camelCase worker is rejected |

Fixtures: `worker-contract/fixtures/rpc-payloads.json` is generated from the live DB by
`gen-fixtures.mjs` (rolled-back transaction). Regenerate after any change to `public.worker_*`.

Assumption to verify on your project: dispatch counting reads `net.http_request_queue`
(pg_net's queue table). If your pg_net version names it differently, the M40-D/S02c checks
will error with "relation does not exist" -- adjust `maxQ()`/`dispatchesSince()` only.

## Milestone 4.1 (approval-resume engine)

| Suite | File | Covers |
|---|---|---|
| A41-SC | m41-approvals.test.mjs | new columns/FK cascade, one-approval-per-step index, widened status checks, consistency check, flag row OFF and fail-closed |
| A41-PR | same | every new/replaced private function is owner-only, SECURITY DEFINER, search_path=''; public wrapper grants unchanged |
| A41-G  | same | which steps gate (tool.permission rules, waiver rules, malformed input fails closed) |
| A41-C / R | same | claim parks gated steps (payload, TTL, flags, no dispatch), request_approval fencing/validation |
| A41-D  | same | approve/reject/expire via public.decide_my_approval, authorization, flags, one-shot across retries, stale recovery |
| A41-X / E / F | same | cancel while waiting, expiry sweep, full lifecycle through private.create_run |
| A41-K  | same (PHASE4_DESTRUCTIVE_TESTS=1) | two-connection races: double approve, approve vs cancel, SKIP LOCKED, per-row exception isolation |
| WC-04b | worker-contract | the worker treats a parked step as "nothing to do" |

Regenerate fixtures after applying 4.1 migrations: `node tests/phase4/worker-contract/gen-fixtures.mjs`.

## Milestone 4.2 (demo engine, Anthropic adapter, blueprint storage)

| Suite | File | Covers |
|---|---|---|
| A42-P / PR | m42-demo.test.mjs | model_pricing seed + derived INR, allowlist, cost function = exact integer math, every new function owner-only, flags fail closed |
| A42-C | same | demo config validation (strict, no tools, caps), prompt-free frozen run config, runs trigger (L2 for demos) |
| A42-L | same | listing_demos RLS, column grants (sellers cannot self-approve), admin+MFA approval, any config change withdraws approval |
| A42-D / B | same | start_demo_run gates (flags, input, listing, approval, per-user limit, platform budget reservations + IST day, settings bounds) |
| A42-X / F | same | worker step context (fencing, frozen snapshot, kill switch, stub for non-demo), prompt secrecy via RLS, end-to-end demo run, cost backstop |
| A42-S | m42-blueprints.test.mjs | blueprint metadata constraints, private bucket config, storage policies (seller / paid buyer / refunded / stranger / admin), cast safety, listing-files unchanged |
| A42-R | m42-routes.test.mjs | POST /api/demo/runs handler and blueprint download handler (mocked client, no DB) |
| WP-* | worker-contract/worker-contract.test.ts | Anthropic adapter: request shape, pre-flight, cost from usage, failure modes, secret hygiene, DB cost-vector parity |

Scratch databases must enable RLS on storage.objects (Supabase already does) for the A42-S policy checks.
Regenerate fixtures after applying the 4.2 migrations: `node tests/phase4/worker-contract/gen-fixtures.mjs`.

## Milestone 4.3 (Try Demo UI, polling, blueprint download)

| Suite | File | Covers |
|---|---|---|
| A43-I / V | m43-db.test.mjs | public.listing_demo_info (availability, public payload, per-user counter, budget parity with create_demo_run) and the PRIVACY fix: sellers can no longer read demo runs |
| A43-F / H / P | m43-logic.test.mjs | failure classification + copy, GET /api/demo/runs/[id] handler (sanitised view), the poll loop with a fake clock |
| A43-R / V / W / B / D | m43-state.test.mjs | the Try Demo reducer, input validation, step viewer labels, blueprint helpers, domain normaliser |
| A43-G | m43-guardrails.test.mjs | static scans of the UI boundary (run from the repo root); the Phase 2 guardrail still passes unchanged |
| A43-C | m43-components.test.mjs | renders every Try Demo state and the blueprint card with react-dom/server; asserts escaping of model output. Needs `npm i -D esbuild` |

Run the guardrail and component tests from the REPO ROOT (they read components/ and app/). `next build` also compiles clean.
