// lib/validation/run.js
//
// Validates the `input` a buyer submits when starting a run, against the
// `inputs[]` a Workflow/Agent product itself declares in its
// configuration. Phase 1 does not create runs (no execution engine yet)
// -- this schema is what Phase 3's "create job" API route will call
// before ever inserting a `runs` row, so it exists now alongside the rest
// of the validation layer rather than being bolted on later.

import { z } from "zod";

const inputValueSchemaByType = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  json: z.unknown(),
  // A file input is a reference (storage path), not raw bytes, by the
  // time it reaches this layer -- the upload itself is a separate,
  // existing concern (lib upload handling), not something this schema
  // re-validates.
  file: z.string().min(1),
};

/**
 * Builds a Zod schema for a run's `input` object from a product's
 * declared `inputs[]` (as validated by workflowConfigurationSchema /
 * agentConfigurationSchema). Every declared required input must be
 * present and of the declared type; unknown keys are rejected outright --
 * a run can't smuggle in fields the product never asked for.
 */
export function buildRunInputSchema(declaredInputs) {
  const shape = {};
  for (const input of declaredInputs) {
    const base = inputValueSchemaByType[input.type] ?? z.unknown();
    shape[input.name] = input.required ? base : base.optional();
  }
  return z.object(shape).strict();
}

export function validateRunInput(declaredInputs, input) {
  return buildRunInputSchema(declaredInputs).safeParse(input);
}

// Sandbox flag + basic run-request envelope (product id, version, input,
// is_sandbox) -- the part of a "create run" request that's the same
// regardless of product type. Product-specific input validation still
// goes through validateRunInput above using that product's own declared
// inputs.
export const runRequestSchema = z.object({
  productId: z.string().uuid(),
  productVersion: z.number().int().positive(),
  isSandbox: z.boolean().default(false),
  input: z.record(z.string(), z.unknown()).default({}),
});

export function validateRunRequest(input) {
  return runRequestSchema.safeParse(input);
}
