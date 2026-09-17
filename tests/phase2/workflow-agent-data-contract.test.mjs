// Verifies the exact data shape components/WorkflowAgentDetail.jsx depends
// on (product.configuration.{goal,instructions,inputs,outputs,steps},
// tools[], permissions[]) using safe, in-memory mock data run through the
// REAL Phase 1 validation + domain-mapping logic -- never inserted into
// the database, matching Guardrail 9 (no fake production listings).
//
// This repo has no component-rendering test infrastructure (no existing
// test touches JSX), so this checks the data contract the component reads
// from, which is what would actually break silently if Phase 1's schemas
// or lib/domain's toProduct() ever changed shape.

import { validateWorkflowConfiguration } from "../../lib/validation/workflow.js";
import { validateAgentConfiguration } from "../../lib/validation/agent.js";
import { toProduct } from "../../lib/domain/products.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

// A representative Workflow config, the same shape WorkflowAgentListingForm
// submits and the create-workflow-agent route validates.
const workflowConfig = {
  goal: "Qualify inbound WhatsApp leads and route hot ones to sales.",
  inputs: [{ name: "lead_message", type: "string", required: true }],
  outputs: [{ name: "qualification_score", type: "number" }],
  steps: [
    { id: "s1", kind: "validate", config: {} },
    { id: "s2", kind: "ai_process", config: {} },
    { id: "s3", kind: "transform", config: {} },
  ],
};

const workflowResult = validateWorkflowConfiguration(workflowConfig);
check("mock workflow config passes Phase 1 validation", workflowResult.success);

if (workflowResult.success) {
  // Simulate a `listings` row this would produce (never written to the DB).
  const mockRow = {
    id: "00000000-0000-0000-0000-000000000001",
    title: "WhatsApp Lead Qualifier",
    description: "Qualifies leads and organizes follow-ups.",
    category: "Automation",
    price: "499",
    status: "pending_review",
    seller_id: "00000000-0000-0000-0000-000000000002",
    seller_name: "Test Seller",
    product_type: "workflow",
    version: 1,
    configuration: workflowResult.data,
    created_at: "2026-09-16T00:00:00Z",
    rating: null,
    reviews: 0,
  };

  const product = toProduct(mockRow);
  check("toProduct() marks it isWorkflow (not isPlaybook/isAgent)", product.isWorkflow && !product.isPlaybook && !product.isAgent);

  // Exactly the fields WorkflowAgentDetail.jsx reads off `product.configuration`.
  const config = product.configuration || {};
  check("product.configuration.goal is a non-empty string", typeof config.goal === "string" && config.goal.length > 0);
  check("product.configuration.inputs is an array WorkflowAgentDetail can .map over", Array.isArray(config.inputs) && config.inputs.length > 0);
  check("product.configuration.outputs is an array WorkflowAgentDetail can .map over", Array.isArray(config.outputs) && config.outputs.length > 0);
  check("product.configuration.steps is an array with {id, kind} WorkflowAgentDetail can render", Array.isArray(config.steps) && config.steps.every((s) => s.id && s.kind));
}

// Same contract for an Agent config (adds `instructions` + `permissions`).
const agentConfig = {
  goal: "Handle common customer questions and escalate complex cases.",
  instructions: "Answer FAQ-style questions using the knowledge base; escalate anything about refunds.",
  inputs: [{ name: "customer_message", type: "string", required: true }],
  outputs: [{ name: "reply", type: "string" }],
  steps: [{ id: "s1", kind: "ai_process", config: {} }],
  permissions: [{ permission: "SEND", requiresApproval: true }],
};
const agentResult = validateAgentConfiguration(agentConfig);
check("mock agent config passes Phase 1 validation", agentResult.success);

if (agentResult.success) {
  const mockRow = {
    id: "00000000-0000-0000-0000-000000000003",
    title: "Customer Support Agent",
    description: "Handles common customer questions.",
    category: "Business & Strategy",
    price: "999",
    status: "pending_review",
    seller_id: "00000000-0000-0000-0000-000000000002",
    seller_name: "Test Seller",
    product_type: "agent",
    version: 1,
    configuration: agentResult.data,
    created_at: "2026-09-16T00:00:00Z",
    rating: null,
    reviews: 0,
  };
  const product = toProduct(mockRow);
  check("toProduct() marks it isAgent", product.isAgent && !product.isPlaybook && !product.isWorkflow);
  check("product.configuration.instructions present for agent (rendered under 'What job it performs')", typeof product.configuration.instructions === "string" && product.configuration.instructions.length > 0);
  check(
    "product.configuration.permissions is an array WorkflowAgentDetail can render as badges",
    Array.isArray(product.configuration.permissions) && product.configuration.permissions[0].permission === "SEND"
  );
  check("high-risk permission carries requiresApproval=true through to the rendered shape", product.configuration.permissions[0].requiresApproval === true);
}

// ProductCard reads product.configuration?.goal as its Workflow/Agent
// card body -- confirm that path is safe even when configuration is {}
// (the default for every existing production row today, per Guardrail 9).
const emptyConfigProduct = toProduct({
  id: "x", title: "T", description: "D", category: "C", price: "1", status: "live",
  seller_id: null, seller_name: null, product_type: "workflow", version: 1,
  configuration: {}, created_at: "2026-01-01", rating: null, reviews: 0,
});
check("ProductCard's `product.configuration?.goal` access is safe (undefined, not a throw) on an empty config", emptyConfigProduct.configuration.goal === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
