// L1 — client/server input validation, mirroring the L2 database ceilings
// so bad configs are rejected before ever reaching a write.
//
// STATUS: ALL 12 TESTS BLOCKED. `lib/execution/validation.js` does not
// exist yet (confirmed: no lib/execution/ directory anywhere in the repo
// as of this writing). This file is written against the module Part 3
// needs to create — it is meant to fail with a module-not-found error
// today, and turn green once that module exists with this shape:
//
//   export function validateExecutionConfig(cfg) -> { success: boolean, error?: { code, path } }
//
// The reject-never-clamp rule applies here exactly as it does at L2: this
// validator must never silently lower a value to fit a ceiling.

import { validateExecutionConfig } from "../../lib/execution/validation.js";

let pass = 0, fail = 0, blocked = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

const CEILINGS = {
  maxStepsPerRun: 10,
  maxCostInrPerRun: 50,
  maxRunActiveSeconds: 300,
  maxRetriesPerStep: 1,
  maxStepTimeoutSeconds: 90,
};

function validStep(overrides = {}) {
  return { retryLimit: 0, timeoutSeconds: 30, ...overrides };
}
function validConfig(overrides = {}) {
  return {
    steps: [validStep()],
    limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 },
    ...overrides,
  };
}

check("L1-01 rejects missing steps", !validateExecutionConfig({ limits: validConfig().limits }).success);
check("L1-02 rejects non-array steps", !validateExecutionConfig(validConfig({ steps: "not-an-array" })).success);
check("L1-03 rejects empty steps array", !validateExecutionConfig(validConfig({ steps: [] })).success);
check("L1-04 rejects missing limits", !validateExecutionConfig({ steps: [validStep()] }).success);
check("L1-05 rejects limits.maxSteps < 1", !validateExecutionConfig(validConfig({ limits: { maxSteps: 0, maxCostInr: 10, timeoutSeconds: 60 } })).success);
check(
  "L1-06 rejects limits.maxSteps > ceiling (never clamps)",
  (() => {
    const r = validateExecutionConfig(validConfig({ limits: { maxSteps: CEILINGS.maxStepsPerRun + 1, maxCostInr: 10, timeoutSeconds: 60 } }));
    return !r.success; // and specifically NOT success:true with a silently-lowered value
  })()
);
check(
  "L1-07 rejects steps.length > limits.maxSteps",
  !validateExecutionConfig({ steps: [validStep(), validStep()], limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 } }).success
);
check(
  "L1-08 rejects limits.maxCostInr <= 0 or > ceiling",
  !validateExecutionConfig(validConfig({ limits: { maxSteps: 1, maxCostInr: CEILINGS.maxCostInrPerRun + 1, timeoutSeconds: 60 } })).success
);
check(
  "L1-09 rejects limits.timeoutSeconds > ceiling",
  !validateExecutionConfig(validConfig({ limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: CEILINGS.maxRunActiveSeconds + 1 } })).success
);
check(
  "L1-10 rejects any step.retryLimit > ceiling",
  !validateExecutionConfig(validConfig({ steps: [validStep({ retryLimit: CEILINGS.maxRetriesPerStep + 1 })] })).success
);
check(
  "L1-11 rejects any step.timeoutSeconds > ceiling",
  !validateExecutionConfig(validConfig({ steps: [validStep({ timeoutSeconds: CEILINGS.maxStepTimeoutSeconds + 1 })] })).success
);
check(
  "L1-12 accepts a minimal config at exactly-at-ceiling boundary values",
  validateExecutionConfig({
    steps: [validStep({ retryLimit: CEILINGS.maxRetriesPerStep, timeoutSeconds: CEILINGS.maxStepTimeoutSeconds })],
    limits: { maxSteps: CEILINGS.maxStepsPerRun, maxCostInr: CEILINGS.maxCostInrPerRun, timeoutSeconds: CEILINGS.maxRunActiveSeconds },
  }).success === true
);

console.log(`\nL1: ${pass} passed, ${fail} failed (expected: import error until lib/execution/validation.js exists)`);
