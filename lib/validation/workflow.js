// lib/validation/workflow.js
//
// A Workflow is a deterministic multi-step AI process (PRD S10). This
// validates the shape of `listings.configuration` for product_type =
// 'workflow' before it is ever written to the database, and again before
// a run is created from it (Phase 3) -- per the explicit instruction that
// "every configuration must be validated again before execution" and
// "invalid configurations must never be executable."

import { z } from "zod";
import {
  workflowStepSchema,
  modelPolicySchema,
  executionLimitsSchema,
  toolReferenceSchema,
} from "./shared.js";

export const workflowConfigurationSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    inputs: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          type: z.enum(["string", "number", "boolean", "file", "json"]),
          required: z.boolean().default(true),
          description: z.string().max(1000).optional(),
        })
      )
      .min(1)
      .max(20),
    outputs: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          type: z.enum(["string", "number", "boolean", "file", "json"]),
          description: z.string().max(1000).optional(),
        })
      )
      .min(1)
      .max(20),
    steps: z.array(workflowStepSchema).min(1).max(50),
    tools: z.array(toolReferenceSchema).max(20).default([]),
    modelPolicy: modelPolicySchema.default({}),
    limits: executionLimitsSchema.default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Every step id must be unique -- steps reference each other by id
    // once the execution engine exists, so a duplicate id would be
    // ambiguous rather than merely untidy.
    const seen = new Set();
    for (const [index, step] of config.steps.entries()) {
      if (seen.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step id "${step.id}"`,
          path: ["steps", index, "id"],
        });
      }
      seen.add(step.id);

      // Every tool_call step must reference a tool declared in the
      // top-level `tools` list -- a step can't silently invoke a tool the
      // product never declared.
      if (step.kind === "tool_call") {
        if (!step.tool) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.id}" is kind "tool_call" but has no tool reference`,
            path: ["steps", index, "tool"],
          });
        } else if (!config.tools.some((t) => t.toolId === step.tool.toolId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.id}" references a tool not declared in the product's tools list`,
            path: ["steps", index, "tool", "toolId"],
          });
        }
      }
    }
  });

export function validateWorkflowConfiguration(input) {
  return workflowConfigurationSchema.safeParse(input);
}
