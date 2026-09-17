"use client";

// components/ProductTypeBadge.jsx
//
// Phase 2 design-system primitive. Icon + label, never color alone (per
// guardrail: distinguish product types without relying on color alone).
// Used on ProductCard, the product detail page, and the seller flow's
// type picker so all three read consistently.

import { productTypeMeta } from "@/lib/product-types";

const SIZE_CLASSES = {
  sm: "text-[10px] px-2 py-0.5 gap-1",
  md: "text-[11px] px-2.5 py-1 gap-1.5",
};

export default function ProductTypeBadge({ type, size = "md", className = "" }) {
  const meta = productTypeMeta(type);
  const Icon = meta.icon;

  return (
    <span
      className={`inline-flex items-center rounded-full font-mono uppercase tracking-wide font-medium ${SIZE_CLASSES[size]} ${className}`}
      style={{
        color: `var(${meta.colorVar})`,
        backgroundColor: `color-mix(in srgb, var(${meta.colorVar}) 12%, transparent)`,
      }}
    >
      <Icon size={size === "sm" ? 11 : 13} strokeWidth={2.25} aria-hidden="true" />
      {meta.label}
    </span>
  );
}
