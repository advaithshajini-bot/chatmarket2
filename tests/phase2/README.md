# Phase 2 zero-cost validation tests

Same convention as tests/phase1/ -- plain Node scripts, no test runner
dependency, self-contained, exit non-zero on failure. None touch a real
database or network; `workflow-agent-data-contract.test.mjs` exercises the
real Phase 1 Zod schemas and `toProduct()` against safe, in-memory mock
data only (never inserted into the database, per Guardrail 9).

Run from the repository root:

    node tests/phase2/product-types.test.mjs             # 12 assertions — product-type display metadata
    node tests/phase2/sort-control.test.mjs               # 7 assertions — sortProducts() comparator
    node tests/phase2/guardrails.test.mjs                 # 7 assertions — static regression guards (no execution, admin-nav gating, server-side validation)
    node tests/phase2/domain-layer-usage.test.mjs          # 4 assertions — Browse/Homepage/Detail actually call lib/domain
    node tests/phase2/workflow-agent-data-contract.test.mjs # 12 assertions — mock Workflow/Agent products through real Phase 1 validation + toProduct()

All 42 passing as of the Phase 2 completion round, alongside the still-passing
Phase 1 suite (tests/phase1/, 41 assertions) -- 83 total, 0 failed.
