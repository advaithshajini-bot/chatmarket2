"use client";

// components/SearchBar.jsx
//
// Phase 2 design-system primitive, extracted from the search input markup
// that previously lived inline in BrowseClient.jsx. Same visual styling as
// before (pill input, Search icon, IBM Plex Sans) -- this is an extraction,
// not a redesign, so the Browse page's existing look doesn't shift.

import { Search } from "lucide-react";

export default function SearchBar({
  value,
  onChange,
  placeholder = "What do you want to get done?",
  className = "",
  maxWidth,
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-full ${className}`}
      style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", maxWidth }}
    >
      <Search size={14} color="#6B6F76" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label="Search products"
        className="text-sm bg-transparent outline-none w-full"
        style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
      />
    </div>
  );
}
