// lib/validation/product-configuration.js
//
// Single entry point every write path should call: given a product_type
// and a candidate `configuration` object, returns the right Zod result.
// Never trust configuration supplied by the browser -- every server route
// that writes `listings.configuration` (Creator Studio, Phase 5+) must
// call this before the write, and the execution engine (Phase 3+) must
// call it again before a run is allowed to start, per the explicit
// instruction that invalid configurations must never be executable.

import { playbookConfigurationSchema } from "./playbook.js";
import { workflowConfigurationSchema } from "./workflow.js";
import { agentConfigurationSchema } from "./agent.js";
import { PRODUCT_TYPES } from "./shared.js";

const schemaByProductType = {
  playbook: playbookConfigurationSchema,
  workflow: workflowConfigurationSchema,
  agent: agentConfigurationSchema,
};

/**
 * @param {string} productType - one of PRODUCT_TYPES
 * @param {unknown} configuration - candidate value for listings.configuration
 * @returns {{ success: true, data: object } | { success: false, error: import('zod').ZodError }}
 */
export function validateProductConfiguration(productType, configuration) {
  if (!PRODUCT_TYPES.includes(productType)) {
    throw new Error(
      `Unknown product_type "${productType}". Must be one of: ${PRODUCT_TYPES.join(", ")}`
    );
  }
  return schemaByProductType[productType].safeParse(configuration);
}

export { PRODUCT_TYPES } from "./shared.js";
export { PERMISSIONS, HIGH_RISK_PERMISSIONS } from "./shared.js";
