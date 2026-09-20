// lib/execution/ceilings.js
//
// Chatmarket 2.0 Phase 3.1 -- the HARD SYSTEM CEILINGS (architecture v9 §1,
// v10). This module is the JS mirror of the SQL function
// private.system_ceilings() (supabase/migrations/
// 20260920100100_add_system_ceilings_and_config_assertion.sql). The two are
// kept in sync by tests/phase3/db/run_db_tests.py (test 41 -- parity).
//
// POLICY: REJECT, NEVER CLAMP.
//   * A product configuration may be MORE restrictive than a ceiling (and then
//     remains effective exactly as configured).
//   * It may NOT exceed a ceiling. If it does it is rejected -- nothing in
//     this codebase replaces a product-declared value with a ceiling value.
//   * A value EQUAL to a ceiling is valid.
//
// These are constants, not configuration: they are not read from any table,
// environment variable or product field, so no seller/buyer/admin write path
// can change them. Changing one requires a reviewed migration AND a change
// here (the parity test fails if they diverge).

export const SYSTEM_CEILINGS = Object.freeze({
  maxRetriesPerStep: 1,
  maxStepTimeoutSeconds: 90, // one bounded Edge Function invocation
  maxStepsPerRun: 10,
  maxCostInrPerRun: 50,
  maxRunActiveSeconds: 300, // cumulative active processing, excludes approval waits
  maxStepOutputBytes: 51200, // 50 KiB
  maxRunOutputBytes: 204800, // 200 KiB
  maxRunsPerUserPerDay: 20,
  staleStepThresholdSeconds: 120, // > 90 (worker cutoff) and < 150 (platform ceiling)
});

// Machine-readable reasons. Identical strings are produced by the database
// (L2/L3) so a caller can treat them uniformly.
export const EXECUTION_ERROR_CODES = Object.freeze({
  EXCEEDS_CEILING: "config_exceeds_system_ceiling",
  INVALID_FOR_EXECUTION: "config_invalid_for_execution",
});
