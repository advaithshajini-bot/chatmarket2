// lib/validation/agent.js
//
// An Agent extends a Workflow with explicit tool access and a declared
// permission scope (PRD S11/S12). Validates `listings.configuration` for
// product_type = 'agent'. Agents must operate inside explicit boundaries
// -- this schema is the boundary declaration; enforcing it at execution
// time is Phase 4.

import { z } from "zod";
import {
  workflowStepSchema,
  modelPolicySchema,
  executionLimitsSchema,
  toolReferenceSchema,
  permissionGrantSchema,
  HIGH_RISK_PERMISSIONS,
} from "./shared.js";

export const agentConfigurationSchema = z
  .object({
    goal: z.string().min(1).max(2000),
    instructions: z.string().min(1).max(20000),
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
    // The agent's full declared permission scope. Every permission any
    // step/tool call could exercise must appear here -- this is the set
    // admin review evaluates before the product can go live.
    permissions: z.array(permissionGrantSchema).max(6).default([]),
    modelPolicy: modelPolicySchema.default({}),
    limits: executionLimitsSchema.default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const permissionSet = new Set(config.permissions.map((p) => p.permission));

    // No duplicate permission grants.
    if (permissionSet.size !== config.permissions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate permission grants in permissions[]",
        path: ["permissions"],
      });
    }

    const stepIds = new Set();
    for (const [index, step] of config.steps.entries()) {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate step id "${step.id}"`,
          path: ["steps", index, "id"],
        });
      }
      stepIds.add(step.id);

      if (step.kind === "tool_call") {
        if (!step.tool) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.id}" is kind "tool_call" but has no tool reference`,
            path: ["steps", index, "tool"],
          });
          continue;
        }
        if (!config.tools.some((t) => t.toolId === step.tool.toolId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.id}" references a tool not declared in the product's tools list`,
            path: ["steps", index, "tool", "toolId"],
          });
        }
        // Never assume an AI model is a security boundary: a tool_call
        // step that names a permission must have that permission declared
        // at the product level -- a step can't exercise a scope the
        // product never asked for.
        if (step.tool.permission && !permissionSet.has(step.tool.permission)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step "${step.id}" uses permission "${step.tool.permission}" which is not in this product's declared permissions[]`,
            path: ["steps", index, "tool", "permission"],
          });
        }
      }
    }

    // Belt-and-suspenders: even though permissionGrantSchema already
    // rejects an individual high-risk grant with requiresApproval=false,
    // re-check the whole set here too, so this invariant holds even if a
    // future refactor bypasses the per-item schema.
    for (const grant of config.permissions) {
      if (HIGH_RISK_PERMISSIONS.includes(grant.permission) && !grant.requiresApproval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Permission "${grant.permission}" is high-risk and must have requiresApproval = true`,
          path: ["permissions"],
        });
      }
    }
  });

export function validateAgentConfiguration(input) {
  return agentConfigurationSchema.safeParse(input);
}
