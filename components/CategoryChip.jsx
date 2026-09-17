"use client";

// components/CategoryChip.jsx
//
// Phase 2 — promotes the category-pill button that previously lived
// inline in BrowseClient.jsx into a shared component. Same exact styling
// as before (ink border, ink-filled when active) -- extraction, not a
// redesign.

export default function CategoryChip({ label, active, onClick, dashed = false }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 text-sm rounded-full transition-colors"
      style={{
        fontFamily: "'IBM Plex Sans', sans-serif",
        background: active ? "#14213D" : "transparent",
        color: active ? "#F7F7F4" : dashed ? "#6B6F76" : "#14213D",
        border: dashed ? "1px dashed #D8D5C9" : "1px solid #14213D",
      }}
    >
      {label}
    </button>
  );
}
