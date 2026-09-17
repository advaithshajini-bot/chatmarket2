"use client";

// components/ProductCard.jsx
//
// Phase 2 — type-aware product card, replacing BrowseClient's local
// ListingCard. Same card shell/shadow/hover as before (this is the
// existing, working card language, not a new one) with a leading
// ProductTypeBadge and type-appropriate body content:
//   - playbook: the existing conversation-preview snippet (unchanged look)
//   - workflow/agent: the product's declared `goal`, since that's the
//     closest thing to a one-line value proposition in the Phase 1
//     configuration schema
//
// Pricing is rendered plainly (no invented "/run" or "/month" suffix --
// listings.price has no real pricing-unit field yet, so nothing implies
// one that isn't backed by real data).

import Link from "next/link";
import { Star } from "lucide-react";
import ModelTag from "@/components/ModelTag";
import ProductTypeBadge from "@/components/ProductTypeBadge";

export default function ProductCard({ product }) {
  const isPlaybook = product.isPlaybook;
  const goal = product.configuration?.goal;

  return (
    <Link
      href={`/listing/${product.id}`}
      className="text-left rounded-md overflow-hidden block transition-transform hover:-translate-y-0.5"
      style={{ background: "#F7F7F4", border: "1px solid #D8D5C9", boxShadow: "0 1px 2px rgba(20,33,61,0.06)" }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ProductTypeBadge type={product.type} size="sm" />
            {isPlaybook && product.legacyPlaybookFields?.model && (
              <ModelTag model={product.legacyPlaybookFields.model} />
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0" style={{ color: "#6B6F76" }}>
            <Star size={12} fill="#E2A83E" color="#E2A83E" />
            <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
              {product.rating ?? "New"} {product.reviewCount ? `(${product.reviewCount})` : ""}
            </span>
          </div>
        </div>

        <h3
          className="text-[17px] leading-snug mb-1 line-clamp-2"
          style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}
        >
          {product.title}
        </h3>
        <p className="text-xs mb-3" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          {product.category}
        </p>

        {isPlaybook ? (
          <div className="space-y-1.5">
            {(product.legacyPlaybookFields?.preview || []).slice(0, 2).map((m, i) => (
              <div
                key={i}
                className="text-xs px-2 py-1.5 rounded line-clamp-2"
                style={{
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  background: m.who === "user" ? "#EDEEEA" : "#FFFFFF",
                  color: "#3A3D42",
                  border: "1px solid #E4E2D8",
                }}
              >
                {m.text}
              </div>
            ))}
          </div>
        ) : (
          <p
            className="text-xs leading-relaxed line-clamp-3"
            style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#3A3D42" }}
          >
            {goal || product.description}
          </p>
        )}

        <div className="my-3 h-px" style={{ background: "#D8D5C9" }} />

        <div className="flex items-center justify-end">
          <span className="text-base" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            ₹{product.price}
          </span>
        </div>
      </div>
    </Link>
  );
}
