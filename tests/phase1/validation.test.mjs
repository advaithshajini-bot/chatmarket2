import { validateProductConfiguration } from "../../lib/validation/product-configuration.js";
import { validatePlaybookConfiguration } from "../../lib/validation/playbook.js";
import { validateWorkflowConfiguration } from "../../lib/validation/workflow.js";
import { validateAgentConfiguration } from "../../lib/validation/agent.js";
import { validateToolDefinition } from "../../lib/validation/tool.js";
import { validateRunInput, buildRunInputSchema } from "../../lib/validation/run.js";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name); }
}

check("empty playbook config valid", validateProductConfiguration("playbook", {}).success);

const goodWorkflow = {
  goal: "Summarize a document",
  inputs: [{ name: "doc", type: "file", required: true }],
  outputs: [{ name: "summary", type: "string" }],
  tools: [{ toolId: "11111111-1111-1111-1111-111111111111" }],
  steps: [
    { id: "s1", kind: "validate", config: {} },
    { id: "s2", kind: "tool_call", config: {}, tool: { toolId: "11111111-1111-1111-1111-111111111111" } },
  ],
};
check("well-formed workflow valid", validateProductConfiguration("workflow", goodWorkflow).success);
check("workflow with undeclared tool rejected", !validateProductConfiguration("workflow", { ...goodWorkflow, tools: [] }).success);
check("duplicate step ids rejected", !validateProductConfiguration("workflow", { ...goodWorkflow, steps: [{ id: "s1", kind: "validate", config: {} }, { id: "s1", kind: "validate", config: {} }] }).success);

const riskyAgent = {
  goal: "Pay invoices", instructions: "Do the thing",
  inputs: [{ name: "x", type: "string" }], outputs: [{ name: "y", type: "string" }],
  steps: [{ id: "s1", kind: "validate", config: {} }],
  permissions: [{ permission: "FINANCIAL_ACTION", requiresApproval: false }],
};
check("agent FINANCIAL_ACTION without approval rejected", !validateProductConfiguration("agent", riskyAgent).success);
const safeAgent = { ...riskyAgent, permissions: [{ permission: "FINANCIAL_ACTION", requiresApproval: true }] };
check("agent FINANCIAL_ACTION with approval accepted", validateProductConfiguration("agent", safeAgent).success);

let threw = false;
try { validateProductConfiguration("bogus", {}); } catch (e) { threw = true; }
check("unknown product_type throws", threw);
check("unknown keys in playbook config rejected", !validateProductConfiguration("playbook", { notAField: 1 }).success);

const scopeCreepAgent = {
  ...safeAgent,
  steps: [{ id: "s1", kind: "tool_call", config: {}, tool: { toolId: "11111111-1111-1111-1111-111111111111", permission: "DELETE" } }],
  tools: [{ toolId: "11111111-1111-1111-1111-111111111111" }],
};
check("step using undeclared permission scope rejected", !validateProductConfiguration("agent", scopeCreepAgent).success);

// --- New for this validation round ---

// Direct schema module sanity (not just via dispatcher)
check("validatePlaybookConfiguration direct export works", validatePlaybookConfiguration({}).success);
check("validateWorkflowConfiguration direct export works", validateWorkflowConfiguration(goodWorkflow).success);
check("validateAgentConfiguration direct export works", validateAgentConfiguration(safeAgent).success);

// Tool definition schema
check("valid tool definition accepted", validateToolDefinition({ name: "WhatsApp Send", description: "sends a message", requiredPermission: "SEND" }).success);
check("tool definition rejects unknown key", !validateToolDefinition({ name: "x", bogus: true }).success);
check("tool definition rejects invalid permission enum", !validateToolDefinition({ name: "x", requiredPermission: "NUKE" }).success);

// Run input schema: required/optional/type/unknown-key handling
const declaredInputs = [
  { name: "email", type: "string", required: true },
  { name: "count", type: "number", required: false },
];
check("run input: all required fields present -> valid", validateRunInput(declaredInputs, { email: "a@b.com" }).success);
check("run input: missing required field -> rejected", !validateRunInput(declaredInputs, {}).success);
check("run input: wrong type for declared field -> rejected", !validateRunInput(declaredInputs, { email: 123 }).success);
check("run input: unknown key -> rejected (strict)", !validateRunInput(declaredInputs, { email: "a@b.com", extra: "nope" }).success);
check("run input: optional field omitted -> valid", validateRunInput(declaredInputs, { email: "a@b.com" }).success);

// Workflow limits/model policy defaults apply
const r = validateWorkflowConfiguration(goodWorkflow);
check("workflow default limits applied (maxSteps default 10)", r.success && r.data.limits.maxSteps === 10);
check("workflow default modelPolicy provider is anthropic", r.success && r.data.modelPolicy.provider === "anthropic");

// Agent: permission grant default requiresApproval=true for non-high-risk too
const agentWithReadPerm = { ...safeAgent, permissions: [...safeAgent.permissions, { permission: "READ" }] };
const ra = validateAgentConfiguration(agentWithReadPerm);
check("agent READ permission defaults requiresApproval=true", ra.success && ra.data.permissions.find(p => p.permission === "READ").requiresApproval === true);

// Duplicate permission grants on an agent rejected
const dupPerm = { ...safeAgent, permissions: [...safeAgent.permissions, { permission: "FINANCIAL_ACTION", requiresApproval: true }] };
check("agent duplicate permission grants rejected", !validateAgentConfiguration(dupPerm).success);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
