// lib/execution/validation.js
//
// L1 -- client/server input validation, mirroring L2's actual deployed
// logic exactly (private.assert_execution_config_within_ceilings in
// 20260920100100_add_system_ceilings_and_config_assertion.sql), not a
// re-derivation from the architecture doc. Ceiling values are duplicated
// here deliberately (matching the project's own documented D-3 choice:
// "SQL constants, mirrored by lib/execution/ceilings.js; parity is
// tested" -- this file plus its test IS that parity check).
//
// reject-never-clamp: every failure returns success:false. Nothing here
// ever silently lowers a value to fit a ceiling.

export const CEILINGS = Object.freeze({
  maxStepsPerRun: 10,
  maxCostInrPerRun: 50,
  maxRunActiveSeconds: 300,
  maxRetriesPerStep: 1,
  maxStepTimeoutSeconds: 90,
});

function fail(code, path) {
  return { success: false, error: { code, path } };
}

export function validateExecutionConfig(cfg) {
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    return fail("CM002", "execution_config");
  }

  const steps = cfg.steps;
  if (!Array.isArray(steps) || steps.length < 1) {
    return fail("CM002", "steps");
  }

  const limits = cfg.limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    return fail("CM002", "limits");
  }

  // limits.maxSteps
  const maxSteps = limits.maxSteps;
  if (typeof maxSteps !== "number" || !Number.isInteger(maxSteps) || maxSteps < 1) {
    return fail("CM002", "limits.maxSteps");
  }
  if (maxSteps > CEILINGS.maxStepsPerRun) {
    return fail("CM001", "limits.maxSteps");
  }
  if (steps.length > CEILINGS.maxStepsPerRun) {
    return fail("CM001", "steps.length");
  }
  if (steps.length > maxSteps) {
    return fail("CM001", "steps.length>limits.maxSteps");
  }

  // limits.maxCostInr
  const maxCostInr = limits.maxCostInr;
  if (typeof maxCostInr !== "number" || maxCostInr <= 0) {
    return fail("CM002", "limits.maxCostInr");
  }
  if (maxCostInr > CEILINGS.maxCostInrPerRun) {
    return fail("CM001", "limits.maxCostInr");
  }

  // limits.timeoutSeconds (run-level active-processing budget)
  const runTimeout = limits.timeoutSeconds;
  if (typeof runTimeout !== "number" || !Number.isInteger(runTimeout) || runTimeout < 1) {
    return fail("CM002", "limits.timeoutSeconds");
  }
  if (runTimeout > CEILINGS.maxRunActiveSeconds) {
    return fail("CM001", "limits.timeoutSeconds");
  }

  // steps[]
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      return fail("CM002", `steps[${i}]`);
    }

    const retryLimit = step.retryLimit;
    if (typeof retryLimit !== "number" || !Number.isInteger(retryLimit) || retryLimit < 0) {
      return fail("CM002", `steps[${i}].retryLimit`);
    }
    if (retryLimit > CEILINGS.maxRetriesPerStep) {
      return fail("CM001", `steps[${i}].retryLimit`);
    }

    const stepTimeout = step.timeoutSeconds;
    if (typeof stepTimeout !== "number" || !Number.isInteger(stepTimeout) || stepTimeout < 1) {
      return fail("CM002", `steps[${i}].timeoutSeconds`);
    }
    if (stepTimeout > CEILINGS.maxStepTimeoutSeconds) {
      return fail("CM001", `steps[${i}].timeoutSeconds`);
    }
  }

  return { success: true };
}
