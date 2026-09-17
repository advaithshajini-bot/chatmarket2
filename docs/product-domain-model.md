# Chatmarket 2.0 — Product Domain Model (Phase 1)

This document describes the database and application-layer foundation added in
Phase 1 of the Chatmarket 2.0 transformation. It does **not** describe execution,
billing, or tool integrations — those are later phases, and nothing described
here performs an AI call, a tool call, or moves money.

## Status of the older `docs/data-model.md`

**`docs/data-model.md` is historical and deprecated.** It was an early planning
document (Stripe, `password_hash`, an `transactions`/escrow table) that was never
implemented. It actively conflicts with the real schema below and should not be
used as a reference. `docs/supabase-schema.sql` (as updated by this phase's
migrations) remains the authoritative schema reference.

## What existed before Phase 1

Chatmarket V1 sells exactly one kind of thing: a `listings` row representing an
exported AI conversation, optionally with an output zip. One-time Razorpay
purchase, real RLS-backed marketplace/admin/KYC/dispute flows, zero AI
integration of any kind. See the Phase 0 audit document for the full picture.

## What Phase 1 adds

### 1. `listings` becomes the physical Product table

Per explicit instruction, **`listings` is not renamed or migrated into a new
`products` table.** Three columns were added, additively, with safe defaults:

| Column | Type | Default | Meaning |
|---|---|---|---|
| `product_type` | text, constrained | `'playbook'` | `playbook` \| `workflow` \| `agent` |
| `version` | integer | `1` | Product versioning (PRD FR-13) |
| `configuration` | jsonb | `{}` | Type-specific structure for workflow/agent products |

Every existing row became `product_type = 'playbook'` automatically via the
column default — no backfill script, no risk of miscategorization. Existing
playbook-specific columns (`thread`, `preview`, `output_zip_path`,
`zip_contents`, `messages`, `completion`, `model`) are **untouched** and keep
being used exactly as before for these rows. `configuration` is only meaningful
for `workflow`/`agent` products going forward.

### 2. New tables (all additive, all RLS-enabled from creation)

| Table | Purpose | Who can write (Phase 1) |
|---|---|---|
| `tools` | Registry of available tools (WhatsApp, Sheets, etc.) | Admin only |
| `product_tools` | Which tools a product declares it may use | Product owner (creator), admin |
| `product_permissions` | A product's declared permission scope | Product owner (creator), admin |
| `entitlements` | Generalized access grant (purchase / subscription / usage) | **Nobody yet** — service role only (see below) |
| `runs` | Execution record | **Nobody yet** — no INSERT policy exists |
| `run_steps` | Per-step trace inside a run | **Nobody yet** |
| `usage_events` | Billable usage ledger | **Nobody yet** |
| `approvals` | Human-approval gate for high-risk run steps | **Nobody yet** |
| `payouts` | Real creator payout ledger | **Nobody yet** |
| `audit_log` | Immutable audit trail | Nobody directly — only via `private.write_audit_log()`, which nothing calls yet |

"Nobody yet" is deliberate, not an oversight: these tables' write paths require
the execution engine (Phase 3), the tool/permission runtime (Phase 4), or billing
(Phase 7) to exist first, so that a write can be validated (entitlement checked,
usage limit enforced, configuration validated) before it happens. Creating an
INSERT policy without that logic behind it would let a client create rows
(`runs` in particular) that nothing would ever process — so those policies are
intentionally deferred to the phase that can safely add them.

`entitlements` is the one exception worth calling out: it was **backfilled**
from existing paid `purchases` rows (one `entitlements` row per paid purchase,
`kind = 'purchase'`), so it's consistent with reality from the moment it exists,
without a single row of `purchases` being read into via a write, modified, or
depended upon changing shape.

### 3. New helper functions

- `private.owns_product(product_id)` — thin wrapper around the existing
  `private.owns_listing()`. New tables reference this, not `owns_listing`
  directly, so that if Product ever becomes a separate physical table, only
  this one function needs to change.
- `private.can_view_run(run_id)` — single source of truth for "can this caller
  see this run" (its buyer, the product's creator, or an admin), reused by
  `run_steps` and `approvals` instead of each re-deriving the same 3-way check.
- `private.write_audit_log(...)` — `SECURITY DEFINER` insert helper for the
  audit log. Not granted to any role yet; a future migration will grant it once
  a real admin-action RPC calls it.

All three follow the exact pattern already established by `private.is_admin()` /
`private.owns_listing()`: `SECURITY DEFINER`, `set search_path = ''`, and an
explicit revoke-then-grant.

### 4. Referential integrity to `auth.users` (intentional deviation from house style)

**No existing table in this schema has a foreign key into `auth.users`** —
not `purchases.user_id`, not even `profiles.id` itself. This appears to be a
deliberate or at least consistent prior choice.

**Five Phase 1 tables intentionally break from that convention** and declare
a real `references auth.users(id)` foreign key:

| Table | Column | `ON DELETE` behavior |
|---|---|---|
| `entitlements` | `user_id` | `CASCADE` |
| `runs` | `user_id` | `CASCADE` |
| `usage_events` | `user_id` | `CASCADE` |
| `approvals` | `decided_by` | `SET NULL` |
| `payouts` | `creator_id` | `CASCADE` |

**Why:** these are exactly the tables where an orphaned row (one pointing at
a user account that no longer exists) would be a real correctness problem —
an entitlement, run, usage record, or payout with no valid owner is
meaningless data, not just untidy data. A real foreign key makes that state
unrepresentable at the database level, which is a stronger guarantee than
relying on application code to never let it happen. This was a deliberate
choice, made and flagged for review during the Phase 1 validation round, not
an oversight — and it has been kept, not walked back, because matching
existing style for its own sake would mean giving up a real integrity
guarantee for no correctness benefit.

**What this means for later phases:** `entitlements`, `runs`, and
`usage_events` currently cascade-delete their rows if the owning
`auth.users` row is deleted (e.g. account deletion), and `payouts` does the
same for `creator_id`. This is inert today — no write path exists yet on any
of these five tables, so no real row can currently be lost this way. It
stops being inert the moment Phase 7 (billing/subscriptions/usage) starts
writing real usage and payout records: at that point, `usage_events` and
`payouts` become genuine financial/audit ledgers, and silently losing that
history on account deletion is a real business/compliance concern (this
matters especially given the PRD's India-first GST/compliance-workflow
ambitions) that deserves its own explicit decision then — likely `RESTRICT`
or a soft-delete/anonymization pattern instead of `CASCADE`, so a payout or
usage record survives even if the account attached to it is later removed.
**This document is the flag for that future decision; the deletion behavior
itself is intentionally left unchanged in this phase, since changing it now
without a real defect to fix would be scope creep, not a correction.**

## Product types

```
playbook  — static reusable content, no execution, no tools/permissions
workflow  — deterministic multi-step process (inputs → steps → outputs)
agent     — a workflow + explicit tool access + a declared permission scope
```

## Permission model

Six permissions, matching the PRD exactly: `READ`, `WRITE`, `SEND`, `PUBLISH`,
`DELETE`, `FINANCIAL_ACTION`.

`SEND`, `PUBLISH`, `DELETE`, and `FINANCIAL_ACTION` are considered high-risk and
**cannot** be declared with `requires_approval = false` — enforced by a database
CHECK constraint (`high_risk_permissions_require_approval`), independent of
whatever the application layer does. This is deliberate defense in depth: even a
bug in the Zod validation layer can't produce a live high-risk permission that
skips human approval, because the database itself refuses the row.

## Server-side validation (`lib/validation/`)

Because this project is JavaScript, not TypeScript, `listings.configuration` has
no compile-time shape. `lib/validation/` is a Zod-based layer that validates it
explicitly, on every write path that will exist from Phase 5 onward, and again
before every execution in Phase 3+:

- `shared.js` — permission/tool/step primitives shared by every schema. This is
  the single source of truth for the permission and product-type vocabulary on
  the application side (kept in sync with, but independent of, the database's
  own CHECK constraints).
- `playbook.js`, `workflow.js`, `agent.js` — one schema per product type.
- `tool.js` — validates a `tools` registry row before it's written.
- `run.js` — validates a run request's `input` against a product's own declared
  `inputs[]`; unknown keys are rejected outright.
- `product-configuration.js` — the single entry point: given a `product_type`
  and a candidate configuration, dispatches to the right schema.

Cross-field invariants enforced by these schemas (not just per-field types):

- Every workflow/agent step id is unique.
- A `tool_call` step must reference a tool declared in the product's own
  `tools[]` list — it can't invoke something the product never declared.
- An agent step's tool permission must be a subset of the agent's own declared
  `permissions[]` — a step can't exercise a scope the product never asked for.
- A high-risk permission grant (`SEND`/`PUBLISH`/`DELETE`/`FINANCIAL_ACTION`)
  must have `requiresApproval: true` — mirrors the database CHECK constraint.

**Nothing calls these schemas yet.** No existing route writes `configuration`,
so there is no behavior change in Phase 1 from adding them. They exist now so
Phase 5 (Creator Studio) and Phase 3 (execution engine) can use them from day
one instead of validation being bolted on after the fact.

## Application domain layer (`lib/domain/`)

A thin, function-based (not class-based, matching this codebase's existing
style) abstraction over the new tables, so future code can work with `Product`,
`Entitlement`, `Run`, `Tool`, `Permission`, `Approval`, and `UsageEvent`
concepts without every call site re-deriving Supabase query shapes:

- `products.js` — `getProduct`, `listProducts`, `listProductsBySeller`,
  `toProduct` (normalizes a raw `listings` row into a Product shape, keeping
  legacy playbook-specific fields available under `legacyPlaybookFields`
  instead of renaming them).
- `productTools.js`, `productPermissions.js` — read + creator-scoped write
  helpers (RLS enforces ownership; these are convenience wrappers, not a
  second security layer).
- `entitlements.js`, `runs.js`, `usageEvents.js`, `approvals.js`, `payouts.js` —
  **read-only** in Phase 1, matching the "nobody can write yet" table above.
  Each file's header comment explains which later phase adds the write path and
  why it isn't safe to add yet.

Every function takes a Supabase client as its first argument (the same
`createClient()` from `lib/supabase/server.js` used everywhere else) and runs
under that client's session — **no service-role/bypass client appears anywhere
in this layer.** RLS applies to domain-layer calls exactly as it does to any
other query in the app.

## What is explicitly unchanged

- Existing checkout, payment verification, and Razorpay integration code.
- Existing authentication/session behavior.
- Existing Browse, listing detail, Library, seller dashboard, and admin pages —
  none of them read `product_type`/`version`/`configuration` yet, so their
  behavior for existing (now `product_type = 'playbook'`) listings is identical
  to before this migration.
- `purchases`, `reviews`, `disputes`, `seller_kyc` — no schema change, no data
  change, no RLS change.

## What is explicitly deferred (with the phase that adds it)

| Deferred | Phase |
|---|---|
| Any AI provider call | 3 |
| Any tool execution (WhatsApp, Sheets, email, etc.) | 3–4 |
| Creating/advancing a `runs` row | 3 |
| Approval decision RPC | 4 |
| Creator Studio UI for workflow/agent config | 5 |
| Marketplace UI surfacing `product_type` | 6 |
| Subscriptions, usage billing, entitlement writes from checkout | 7 |
| Real Razorpay refund call inside dispute resolution | 7 |
| Wiring `private.write_audit_log()` into existing admin/dispute/checkout flows | 8 |
