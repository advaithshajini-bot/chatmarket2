// lib/validation/playbook.js
//
// A Playbook is static reusable content -- no execution, no tools, no
// permissions. This schema covers the (currently empty, for existing
// rows) `listings.configuration` jsonb for product_type = 'playbook'.
// Existing conversation-export listings keep using their own dedicated
// columns (thread/preview/output_zip_path/zip_contents); this schema is
// for *new* playbook products created going forward that describe
// themselves generically instead.

import { z } from "zod";

export const playbookConfigurationSchema = z
  .object({
    instructions: z.string().max(20000).optional(),
    templates: z
      .array(
        z.object({
          title: z.string().min(1).max(200),
          content: z.string().max(50000),
        })
      )
      .max(50)
      .optional(),
    examples: z.array(z.string().max(20000)).max(20).optional(),
  })
  .strict();

export function validatePlaybookConfiguration(input) {
  return playbookConfigurationSchema.safeParse(input);
}
