"use client";

// components/ProductTypePicker.jsx
//
// Phase 2 — new leading step in the seller flow, before the existing
// wizard. Playbook selection proceeds into the existing, completely
// unchanged 3-step wizard; Workflow/Agent selection renders the new,
// deliberately minimal WorkflowAgentListingForm instead.

import { PRODUCT_TYPE_ORDER, productTypeMeta } from "@/lib/product-types";

export default function ProductTypePicker({ onSelect }) {
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        What are you listing?
      </h1>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        Choose the product type that best fits what you're selling.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PRODUCT_TYPE_ORDER.map((type) => {
          const meta = productTypeMeta(type);
          const Icon = meta.icon;
          return (
            <button
              key={type}
              onClick={() => onSelect(type)}
              className="text-left rounded-md p-5 transition-transform hover:-translate-y-0.5"
              style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}
            >
              <div
                className="flex items-center justify-center w-10 h-10 rounded-lg mb-4"
                style={{ background: `color-mix(in srgb, var(${meta.colorVar}) 14%, transparent)` }}
              >
                <Icon size={20} color={`var(${meta.colorVar})`} strokeWidth={2.25} />
              </div>
              <h3 className="text-base mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
                {meta.label}
              </h3>
              <p className="text-xs" style={{ color: "#6B6F76" }}>{meta.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
