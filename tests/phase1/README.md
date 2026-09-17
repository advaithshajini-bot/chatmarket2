# Phase 1 zero-cost validation tests

Plain Node scripts (no test runner dependency added — this project has none
yet, and adding one wasn't part of Phase 1's scope). Each is self-contained
and asserts/exits non-zero on failure.

Run from the repository root:

    node tests/phase1/validation.test.mjs   # 24 assertions against lib/validation
    node tests/phase1/domain.test.mjs       # 17 assertions against lib/domain (mocked Supabase client, no network)

Both were passing (24/24, 17/17) as of the Phase 1 validation round. Neither
test touches a real database or network -- domain.test.mjs uses a hand-built
mock Supabase client specifically so these can run with zero cost and zero
external dependency.
