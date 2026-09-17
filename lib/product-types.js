// lib/product-types.js
//
// Phase 2 — single source of truth for how each product_type is labeled,
// colored, and iconed across the UI (cards, badges, tabs, the seller
// type-picker). Deliberately separate from lib/validation/shared.js's
// PRODUCT_TYPES (the validation/DB vocabulary) so display concerns don't
// leak into the validation layer, but the `type` keys below are the same
// three values and must stay in sync with it.
//
// Never color alone: every type also gets a distinct icon and label.

import { BookMarked, Workflow, Bot } from "lucide-react";

export const PRODUCT_TYPE_META = {
  playbook: {
    type: "playbook",
    label: "Playbook",
    verb: "Learn / reuse",
    description: "Reusable knowledge, templates, or assets you apply yourself.",
    icon: BookMarked,
    colorVar: "--playbook",
    tailwindColor: "playbook",
  },
  workflow: {
    type: "workflow",
    label: "Workflow",
    verb: "Automate",
    description: "A repeatable multi-step process that turns inputs into outputs.",
    icon: Workflow,
    colorVar: "--workflow",
    tailwindColor: "workflow",
  },
  agent: {
    type: "agent",
    label: "Agent",
    verb: "Delegate",
    description: "An AI worker that performs a job using approved tools.",
    icon: Bot,
    colorVar: "--agent",
    tailwindColor: "agent",
  },
};

export const PRODUCT_TYPE_ORDER = ["playbook", "workflow", "agent"];

export function productTypeMeta(type) {
  return PRODUCT_TYPE_META[type] || PRODUCT_TYPE_META.playbook;
}
