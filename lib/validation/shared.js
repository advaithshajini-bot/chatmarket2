// lib/validation/shared.js
//
// Chatmarket 2.0 Phase 1 -- shared primitives for the server-side
// validation layer. Every Workflow/Agent configuration schema is built
// from these so the permission/tool vocabulary can't drift between them.
//
// IMPORTANT: this file is the single source of truth for the permission
// and product-type enums on the *application* side. It must be kept in
// sync with the CHECK constraints in the database migrations
// (supabase/migrations/2026...create_product_permissions_table.sql and
// ...add_product_domain_columns_to_listings.sql). Neither side trusts the
// other -- the DB enforces its own constraints regardless of what the app
// validates, and the app validates before ever sending a write, so a
// malicious or buggy client can't rely on the DB being the only check.

import { z } from "zod";

export const PRODUCT_TYPES = ["playbook", "workflow", "agent"];

export const PERMISSIONS = [
  "READ",
  "WRITE",
  "SEND",
  "PUBLISH",
  "DELETE",
  "FINANCIAL_ACTION",
];

// Permissions that must default to requiring human approval before a run
// is allowed to execute them (PRD S13/S17 -- "financial and destructive
// actions should NOT be enabled by default"). Mirrors the DB's
// `high_risk_permissions_require_approval` CHECK constraint exactly.
export const HIGH_RISK_PERMISSIONS = ["SEND", "PUBLISH", "DELETE", "FINANCIAL_ACTION"];

export const permissionSchema = z.enum(PERMISSIONS);

export const permissionGrantSchema = z
  .object({
    permission: permissionSchema,
    requiresApproval: z.boolean().default(true),
  })
  .refine(
    (grant) => grant.requiresApproval || !HIGH_RISK_PERMISSIONS.includes(grant.permission),
    {
      message:
        "SEND, PUBLISH, DELETE, and FINANCIAL_ACTION permissions must have requiresApproval = true",
      path: ["requiresApproval"],
    }
  );

// A tool reference as it appears inside a Workflow/Agent configuration.
// This validates the *shape* a creator submits; whether toolId actually
// exists in the `tools` registry is a separate, database-level check made
// at write time (Phase 1 does not seed the registry or wire this up yet).
export const toolReferenceSchema = z.object({
  toolId: z.string().uuid(),
  // The specific permission this tool call needs, must be a subset of the
  // product's own declared permissions (checked by
  // validateToolPermissionsSubset below, not by this schema alone, since
  // it requires cross-referencing the parent config).
  permission: permissionSchema.optional(),
});

// A single Workflow step, matching the PRD S10 step contract:
// INPUT -> VALIDATE -> AI_PROCESS -> TOOL_CALL -> TRANSFORM -> OUTPUT
export const STEP_KINDS = ["validate", "ai_process", "tool_call", "transform"];

export const workflowStepSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(STEP_KINDS),
  // Free-form per-kind config (e.g. a prompt template for ai_process, a
  // tool reference for tool_call). Deliberately loose here -- Phase 3's
  // execution engine is what interprets `config` per kind; Phase 1 only
  // guarantees the envelope is well-formed.
  config: z.record(z.string(), z.unknown()).default({}),
  tool: toolReferenceSchema.optional(),
  // D-1 (Phase 3.1, forward-looking only): the default is 90, not the original 120, because 90 s is
  // the Phase 3 hard system ceiling for one worker invocation (lib/execution/ceilings.js). A default
  // above the ceiling would make every newly created listing non-executable by construction.
  // Existing stored configurations are NOT rewritten. The schema `.max(3600)` is unchanged: an
  // explicit value above 90 still parses here and is REJECTED (never clamped) at run creation by
  // lib/execution/executability.js and by the database.
  timeoutSeconds: z.number().int().positive().max(3600).default(90),
  retryLimit: z.number().int().min(0).max(5).default(1),
});

export const modelPolicySchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"]).default("anthropic"),
  model: z.string().min(1).max(100).optional(),
  maxTokens: z.number().int().positive().max(200000).optional(),
});

export const executionLimitsSchema = z.object({
  maxSteps: z.number().int().positive().max(50).default(10),
  maxCostInr: z.number().positive().max(10000).default(50),
  timeoutSeconds: z.number().int().positive().max(3600).default(300),
});
