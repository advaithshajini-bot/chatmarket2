"use client";

// components/SortControl.jsx
//
// Phase 2 — Browse page sort. Client-side comparator over the already-
// fetched live listings, same pattern as the existing category filter (no
// new query per sort change). The actual comparator logic lives in
// lib/sort-products.js so it can be unit-tested without a JSX transpiler.

export { sortProducts } from "@/lib/sort-products";

const OPTIONS = [
  { value: "relevance", label: "Most Relevant" },
  { value: "popular", label: "Most Popular" },
  { value: "newest", label: "Newest" },
  { value: "price_low", label: "Price: Low to High" },
  { value: "price_high", label: "Price: High to Low" },
  { value: "rating", label: "Rating" },
];

export default function SortControl({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm rounded-full px-3 py-2 outline-none"
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        color: "#14213D",
        background: "#FFFFFF",
        border: "1px solid #D8D5C9",
      }}
      aria-label="Sort products"
    >
      {OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
