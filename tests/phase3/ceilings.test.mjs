// tests/phase3/ceilings.test.mjs
//
// Phase 3.1 -- L1 (application) tests for the hard system ceilings.
// Plain Node script in the same style as tests/phase1 and tests/phase2.
// Run from the repository root:   node tests/phase3/ceilings.test.mjs
//
// Covers the application-side half of v10 tests 34-39, 41 (constants) and 42,
// and the D-1 forward-looking default. The database halves (L2/L3) are in
// tests/phase3/db/run_db_tests.py.

import { readFileSync } from "node:fs";
import { SYSTEM_CEILINGS, EXECUTION_ERROR_CODES } from "../../lib/execution/ceilings.js";
import { checkExecutionCeilings, prepareRunCreation } from "../../lib/execution/executability.js";
import { validateWorkflowConfiguration } from "../../lib/validation/workflow.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name); }
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/meeting-minutes-workflow.fixture.json", import.meta.url), "utf8")
);
delete fixture._comment;

// A fully parsed (Zod-defaulted) config, i.e. what listings.configuration holds.
const parsed = (over = {}) => {
  const r = validateWorkflowConfiguration({ ...structuredClone(fixture), ...over });
  if (!r.success) throw new Error("fixture invalid: " + JSON.stringify(r.error.issues));
  return r.data;
};
const withStep = (i, patch) => {
  const c = parsed();
  c.steps[i] = { ...c.steps[i], ...patch };
  return c;
};
const withLimits = (patch) => {
  const c = parsed();
  c.limits = { ...c.limits, ...patch };
  return c;
};
const steps = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`, kind: "transform", config: {}, timeoutSeconds: 30, retryLimit: 0, ...extra,
}));
const rejects = (cfg, field) => {
  const r = checkExecutionCeilings(cfg);
  return !r.ok && r.code === EXECUTION_ERROR_CODES.EXCEEDS_CEILING &&
    (field === undefined || r.violations.some((v) => v.field === field));
};

// ---- ceilings themselves ---------------------------------------------------
check("ceilings are exactly the approved values", JSON.stringify(SYSTEM_CEILINGS) === JSON.stringify({
  maxRetriesPerStep: 1, maxStepTimeoutSeconds: 90, maxStepsPerRun: 10, maxCostInrPerRun: 50,
  maxRunActiveSeconds: 300, maxStepOutputBytes: 51200, maxRunOutputBytes: 204800,
  maxRunsPerUserPerDay: 20, staleStepThresholdSeconds: 120,
}));
check("ceilings object is frozen (cannot be mutated at runtime)", Object.isFrozen(SYSTEM_CEILINGS));
check("stale threshold sits inside (90, 150)", SYSTEM_CEILINGS.staleStepThresholdSeconds > 90 && SYSTEM_CEILINGS.staleStepThresholdSeconds < 150);

// ---- 34 retry ceiling ------------------------------------------------------
check("34: retryLimit 0 accepted", checkExecutionCeilings(withStep(1, { retryLimit: 0 })).ok);
check("34: retryLimit 1 (== ceiling) accepted", checkExecutionCeilings(withStep(1, { retryLimit: 1 })).ok);
check("34: retryLimit 2 rejected", rejects(withStep(1, { retryLimit: 2 }), "steps[1].retryLimit"));
check("34: retryLimit 5 (Zod max) rejected", rejects(withStep(1, { retryLimit: 5 }), "steps[1].retryLimit"));

// ---- 35 step timeout ceiling ----------------------------------------------
check("35: timeoutSeconds 30 accepted", checkExecutionCeilings(withStep(0, { timeoutSeconds: 30 })).ok);
check("35: timeoutSeconds 90 (== ceiling) accepted", checkExecutionCeilings(withStep(0, { timeoutSeconds: 90 })).ok);
check("35: timeoutSeconds 91 rejected", rejects(withStep(0, { timeoutSeconds: 91 }), "steps[0].timeoutSeconds"));
check("35: timeoutSeconds 120 rejected (never clamped to 90)", rejects(withStep(0, { timeoutSeconds: 120 })));
check("35: timeoutSeconds 3600 (Zod max) rejected", rejects(withStep(0, { timeoutSeconds: 3600 })));

// D-1: forward-looking default
const omitted = validateWorkflowConfiguration({
  ...structuredClone(fixture),
  steps: fixture.steps.map((s) => ({ id: s.id, kind: s.kind, config: {} })), // exactly what the Phase 2 form submits
});
check("D-1: Phase 2 form shape parses", omitted.success);
check("D-1: omitted step timeoutSeconds now defaults to 90 (not 120)", omitted.success && omitted.data.steps.every((s) => s.timeoutSeconds === 90));
check("D-1: a NEW form-shaped listing is executable at L1", omitted.success && checkExecutionCeilings(omitted.data).ok);
const legacy = parsed();
legacy.steps = legacy.steps.map((s) => ({ ...s, timeoutSeconds: 120 })); // what an old stored row would look like
check("D-1: a legacy stored config with timeoutSeconds 120 is REJECTED, not rewritten", rejects(legacy));
check("D-1: rejection does not mutate the input (no clamping)", legacy.steps.every((s) => s.timeoutSeconds === 120));

// ---- 36 step-count ceiling -------------------------------------------------
check("36: 10 steps with maxSteps 10 accepted", checkExecutionCeilings({ ...parsed(), steps: steps(10), limits: { ...parsed().limits, maxSteps: 10 } }).ok);
check("36: 11 steps rejected", rejects({ ...parsed(), steps: steps(11), limits: { ...parsed().limits, maxSteps: 11 } }, "steps.length"));
check("36: limits.maxSteps 11 rejected (with 3 steps)", rejects(withLimits({ maxSteps: 11 }), "limits.maxSteps"));
check("36: 6 steps with maxSteps 5 rejected (never truncated)", rejects({ ...parsed(), steps: steps(6), limits: { ...parsed().limits, maxSteps: 5 } }, "steps.length>limits.maxSteps"));
check("36: 3 steps with maxSteps 5 accepted", checkExecutionCeilings({ ...parsed(), limits: { ...parsed().limits, maxSteps: 5 } }).ok);

// ---- 37 cost ceiling -------------------------------------------------------
check("37: maxCostInr 20 accepted", checkExecutionCeilings(withLimits({ maxCostInr: 20 })).ok);
check("37: maxCostInr 50 (== ceiling) accepted", checkExecutionCeilings(withLimits({ maxCostInr: 50 })).ok);
check("37: maxCostInr 50.01 rejected", rejects(withLimits({ maxCostInr: 50.01 }), "limits.maxCostInr"));
check("37: maxCostInr 100 rejected", rejects(withLimits({ maxCostInr: 100 })));
check("37: maxCostInr 10000 (Zod max) rejected", rejects(withLimits({ maxCostInr: 10000 })));

// ---- 38 run active-processing ceiling -------------------------------------
check("38: limits.timeoutSeconds 120 accepted", checkExecutionCeilings(withLimits({ timeoutSeconds: 120 })).ok);
check("38: limits.timeoutSeconds 300 (== ceiling) accepted", checkExecutionCeilings(withLimits({ timeoutSeconds: 300 })).ok);
check("38: limits.timeoutSeconds 301 rejected", rejects(withLimits({ timeoutSeconds: 301 }), "limits.timeoutSeconds"));

// ---- 39 override channels --------------------------------------------------
const smuggled = validateWorkflowConfiguration({
  ...structuredClone(fixture),
  limits: { ...fixture.limits, maxStepOutputBytes: 999999999, maxRunOutputBytes: 999999999, maxRetriesPerStep: 99 },
});
check("39: unknown keys inside `limits` are stripped by the schema", smuggled.success && !("maxStepOutputBytes" in smuggled.data.limits) && !("maxRetriesPerStep" in smuggled.data.limits));
const cfgWithNoise = parsed();
cfgWithNoise.steps[1].config = { maxStepOutputBytes: 999999999, retryLimit: 99, timeoutSeconds: 9999, maxCostInr: 9999 };
check("39: nothing inside a step's free-form `config` is ever read as a limit", checkExecutionCeilings(cfgWithNoise).ok);
const cfgNoise2 = withStep(1, { retryLimit: 2 });
cfgNoise2.steps[1].config = { retryLimit: 0 };
check("39: a `config.retryLimit: 0` cannot mask a real retryLimit of 2", rejects(cfgNoise2, "steps[1].retryLimit"));

// ---- reject-never-clamp / more restrictive stays effective ------------------
const restrictive = prepareRunCreation("workflow", { ...structuredClone(fixture), steps: fixture.steps.map((s) => ({ ...s, retryLimit: 0, timeoutSeconds: 30 })) });
check("more restrictive product values pass through exactly as declared", restrictive.ok && restrictive.executionConfig.steps.every((s) => s.retryLimit === 0 && s.timeoutSeconds === 30));
const over = prepareRunCreation("workflow", { ...structuredClone(fixture), steps: fixture.steps.map((s) => ({ ...s, retryLimit: 2 })) });
check("over-ceiling config: ok=false and NO executionConfig returned (nothing to clamp)", !over.ok && over.executionConfig === undefined);
check("over-ceiling code is config_exceeds_system_ceiling", over.code === "config_exceeds_system_ceiling");

// ---- malformed frozen config fails closed -----------------------------------
const m = (patch) => { const c = parsed(); return { ...c, ...patch }; };
const bad = (r) => !r.ok && r.code === EXECUTION_ERROR_CODES.INVALID_FOR_EXECUTION;
check("malformed: null config", bad(checkExecutionCeilings(null)));
check("malformed: steps missing", bad(checkExecutionCeilings({ limits: parsed().limits })));
check("malformed: limits missing", bad(checkExecutionCeilings({ steps: parsed().steps })));
check("malformed: retryLimit missing", bad(checkExecutionCeilings(withStep(0, { retryLimit: undefined }))));
check("malformed: retryLimit non-integer", bad(checkExecutionCeilings(withStep(0, { retryLimit: 0.5 }))));
check("malformed: timeoutSeconds string", bad(checkExecutionCeilings(withStep(0, { timeoutSeconds: "30" }))));
check("malformed: maxCostInr <= 0", bad(checkExecutionCeilings(withLimits({ maxCostInr: 0 }))));

// ---- product type gate & Zod re-validation ----------------------------------
check("playbook is not executable", prepareRunCreation("playbook", {}).code === "product_not_executable");
check("Zod re-validation runs first (invalid config -> invalid_configuration)", prepareRunCreation("workflow", { goal: "" }).code === "invalid_configuration");

// ---- 42 first workflow -------------------------------------------------------
const first = prepareRunCreation("workflow", structuredClone(fixture));
check("42: validate -> ai_process -> transform, zero tools fixture passes L1", first.ok);
check("42: fixture uses no tools and exactly the three approved step kinds in order",
  first.ok && first.executionConfig.tools.length === 0 &&
  first.executionConfig.steps.map((s) => s.kind).join(",") === "validate,ai_process,transform");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
