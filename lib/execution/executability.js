// lib/execution/executability.js
//
// L1 -- application-layer executability validation (architecture v10 §B).
//
// Runs AFTER the existing Phase 1 Zod validation and BEFORE a run is
// created. It decides whether an already-schema-valid Workflow/Agent
// configuration is *executable* under the system ceilings. It mirrors the
// database assertion (private.assert_execution_config_within_ceilings) so a
// buyer gets a precise, early error -- but it is NOT the authority: the
// database enforces the same invariants itself (L2) and again at runtime
// (L3). Neither side trusts the other.
//
// REJECT, NEVER CLAMP: this function never returns a modified configuration.
// It returns ok:true with the configuration untouched, or ok:false with the
// list of violations.
//
// Only the declared fields are ever read: steps[].retryLimit,
// steps[].timeoutSeconds, steps.length, limits.maxSteps, limits.maxCostInr,
// limits.timeoutSeconds. Nothing inside a step's free-form `config` object is
// ever interpreted as a limit or a limit override.

import { SYSTEM_CEILINGS, EXECUTION_ERROR_CODES } from "./ceilings.js";
import { validateProductConfiguration } from "../validation/product-configuration.js";

const EXECUTABLE_PRODUCT_TYPES = ["workflow", "agent"];

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);

function exceeds(field, value, ceiling) {
  return { code: EXECUTION_ERROR_CODES.EXCEEDS_CEILING, field, value, ceiling };
}
function invalid(field, value) {
  return { code: EXECUTION_ERROR_CODES.INVALID_FOR_EXECUTION, field, value };
}

/**
 * @param {unknown} config - a validated (Zod-parsed) Workflow/Agent configuration
 * @returns {{ ok: true } | { ok: false, code: string, violations: object[] }}
 */
export function checkExecutionCeilings(config) {
  const violations = [];
  const c = SYSTEM_CEILINGS;

  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      code: EXECUTION_ERROR_CODES.INVALID_FOR_EXECUTION,
      violations: [invalid("execution_config", config)],
    };
  }

  const steps = config.steps;
  const limits = config.limits;

  if (!Array.isArray(steps) || steps.length < 1) {
    violations.push(invalid("steps", steps));
  }
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    violations.push(invalid("limits", limits));
  }
  if (violations.length) return finish(violations);

  // limits.maxSteps ----------------------------------------------------------
  if (!isInt(limits.maxSteps) || limits.maxSteps < 1) {
    violations.push(invalid("limits.maxSteps", limits.maxSteps));
  } else {
    if (limits.maxSteps > c.maxStepsPerRun) {
      violations.push(exceeds("limits.maxSteps", limits.maxSteps, c.maxStepsPerRun));
    }
    if (steps.length > c.maxStepsPerRun) {
      violations.push(exceeds("steps.length", steps.length, c.maxStepsPerRun));
    }
    // A plan longer than its own declared limit is inconsistent: rejected,
    // never truncated.
    if (steps.length > limits.maxSteps) {
      violations.push(exceeds("steps.length>limits.maxSteps", steps.length, limits.maxSteps));
    }
  }

  // limits.maxCostInr --------------------------------------------------------
  if (!isNum(limits.maxCostInr) || limits.maxCostInr <= 0) {
    violations.push(invalid("limits.maxCostInr", limits.maxCostInr));
  } else if (limits.maxCostInr > c.maxCostInrPerRun) {
    violations.push(exceeds("limits.maxCostInr", limits.maxCostInr, c.maxCostInrPerRun));
  }

  // limits.timeoutSeconds (active-processing budget) -------------------------
  if (!isInt(limits.timeoutSeconds) || limits.timeoutSeconds < 1) {
    violations.push(invalid("limits.timeoutSeconds", limits.timeoutSeconds));
  } else if (limits.timeoutSeconds > c.maxRunActiveSeconds) {
    violations.push(exceeds("limits.timeoutSeconds", limits.timeoutSeconds, c.maxRunActiveSeconds));
  }

  // per-step -----------------------------------------------------------------
  steps.forEach((step, i) => {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      violations.push(invalid(`steps[${i}]`, step));
      return;
    }
    if (!isInt(step.retryLimit) || step.retryLimit < 0) {
      violations.push(invalid(`steps[${i}].retryLimit`, step.retryLimit));
    } else if (step.retryLimit > c.maxRetriesPerStep) {
      violations.push(exceeds(`steps[${i}].retryLimit`, step.retryLimit, c.maxRetriesPerStep));
    }
    if (!isInt(step.timeoutSeconds) || step.timeoutSeconds < 1) {
      violations.push(invalid(`steps[${i}].timeoutSeconds`, step.timeoutSeconds));
    } else if (step.timeoutSeconds > c.maxStepTimeoutSeconds) {
      violations.push(
        exceeds(`steps[${i}].timeoutSeconds`, step.timeoutSeconds, c.maxStepTimeoutSeconds)
      );
    }
  });

  return finish(violations);
}

function finish(violations) {
  if (violations.length === 0) return { ok: true };
  // If anything exceeds a ceiling, that is the headline reason; otherwise the
  // configuration is malformed for execution.
  const anyExceeds = violations.some((v) => v.code === EXECUTION_ERROR_CODES.EXCEEDS_CEILING);
  return {
    ok: false,
    code: anyExceeds
      ? EXECUTION_ERROR_CODES.EXCEEDS_CEILING
      : EXECUTION_ERROR_CODES.INVALID_FOR_EXECUTION,
    violations,
  };
}

/**
 * The full L1 gate a run-creation caller must pass before the database is
 * asked to create a run:
 *   1. only workflow/agent products are executable
 *   2. the configuration is re-validated with the Phase 1 Zod schema
 *      ("every configuration must be validated again before execution")
 *   3. the parsed configuration is checked against the system ceilings
 *
 * Returns the *parsed, unmodified* configuration on success. The database
 * still reads listings.configuration itself and re-asserts (L2); this result
 * exists so the caller can fail early and precisely.
 *
 * @returns {{ ok: true, executionConfig: object } | { ok: false, code: string, violations?: object[], issues?: unknown }}
 */
export function prepareRunCreation(productType, configuration) {
  if (!EXECUTABLE_PRODUCT_TYPES.includes(productType)) {
    return { ok: false, code: "product_not_executable" };
  }
  const parsed = validateProductConfiguration(productType, configuration);
  if (!parsed.success) {
    return { ok: false, code: "invalid_configuration", issues: parsed.error.issues };
  }
  const ceiling = checkExecutionCeilings(parsed.data);
  if (!ceiling.ok) return ceiling;
  return { ok: true, executionConfig: parsed.data };
}
