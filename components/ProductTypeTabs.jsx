"use client";

// components/ProductTypeTabs.jsx
//
// Phase 2 — underline-tab strip filtering Browse results by product_type.
// "All" plus the three real types; counts are computed from whatever
// listings were already fetched (no extra query), same pattern as the
// existing category-pill filter.

import { PRODUCT_TYPE_ORDER, productTypeMeta, isComingSoon } from "@/lib/product-types";

export default function ProductTypeTabs({ value, onChange, counts }) {
  const tabs = ["all", ...PRODUCT_TYPE_ORDER];

  return (
    <div className="flex items-center gap-5 border-b mb-6 overflow-x-auto" style={{ borderColor: "#D8D5C9" }} role="tablist">
      {tabs.map((tab) => {
        const isAll = tab === "all";
        const meta = isAll ? null : productTypeMeta(tab);
        const label = isAll ? "All" : meta.label + "s";
        const active = value === tab;
        const count = counts?.[tab];
        const soon = !isAll && isComingSoon(tab);

        return (
          <button
            key={tab}
            role="tab"
            aria-selected={active}
            aria-disabled={soon}
            disabled={soon}
            onClick={() => { if (!soon) onChange(tab); }}
            className="pb-3 -mb-px text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              color: active ? "#14213D" : "#6B6F76", opacity: soon ? 0.7 : 1, cursor: soon ? "not-allowed" : "pointer",
              borderBottom: active ? "2px solid #14213D" : "2px solid transparent",
            }}
          >
            {label}
            {soon && <span className="text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wide" style={{ background: "#E8E7E2", color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>Coming soon</span>}
            {!soon && typeof count === "number" && (
              <span className="text-xs font-mono" style={{ color: active ? "#14213D" : "#9A9DA3" }}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
