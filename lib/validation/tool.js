// lib/validation/tool.js
//
// Validates a row before it is written to the `tools` registry table.
// Phase 1 does not seed any tools or expose a creator-facing tool
// submission UI -- this schema exists so that when Phase 4/5 does write
// to `tools`, the write goes through the same validate-before-store
// discipline as everything else, from day one.

import { z } from "zod";
import { permissionSchema } from "./shared.js";

export const toolDefinitionSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    requiredPermission: permissionSchema.optional(),
    enabled: z.boolean().default(false),
  })
  .strict();

export function validateToolDefinition(input) {
  return toolDefinitionSchema.safeParse(input);
}
