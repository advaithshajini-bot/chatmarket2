"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search, Star } from "lucide-react";
import ModelTag from "@/components/ModelTag";
import PerforatedDivider from "@/components/PerforatedDivider";
import { CATEGORIES } from "@/lib/categories";
import { scoreListing, rankListings } from "@/lib/search-relevance";

function ListingCard({ listing }) {
  return (
    <Link
      href={`/listing/${listing.id}`}
      className="text-left rounded-md overflow-hidden block transition-transform hover:-translate-y-0.5"
      style={{ background: "#F7F7F4", border: "1px solid #D8D5C9", boxShadow: "0 1px 2px rgba(20,33,61,0.06)" }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <ModelTag model={listing.model} />
          <div className="flex items-center gap-1" style={{ color: "#6B6F76" }}>
            <Star size={12} fill="#E2A83E" color="#E2A83E" />
            <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
              {listing.rating ?? "New"} {listing.reviews ? `(${listing.reviews})` : ""}
            </span>
          </div>
        </div>

        <h3 className="text-[17px] leading-snug mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          {listing.title}
        </h3>

        <div className="space-y-1.5">
          {(listing.preview || []).slice(0, 2).map((m, i) => (
            <div
              key={i}
              className="text-xs px-2 py-1.5 rounded"
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

        <PerforatedDivider />

        <div className="flex items-center justify-between">
          <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            {listing.messages} msgs · {listing.completion}% complete
          </span>
          <span className="text-base" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            ₹{listing.price}
          </span>
        </div>
      </div>
    </Link>
  );
}

export default function BrowseClient({ listings }) {
  const searchParams = useSearchParams();
  const categoryFromUrl = searchParams.get("category");
  const [activeCategory, setActiveCategory] = useState(
    categoryFromUrl && CATEGORIES.includes(categoryFromUrl) ? categoryFromUrl : "All"
  );
  const [query, setQuery] = useState("");

  // Category is still a hard filter (an explicit pill the person chose),
  // but the search query is a ranking, not a filter: matches sort to the
  // top by field relevance (model > title > category > description) and
  // everything else stays visible afterward, in its original order —
  // typing "claude" surfaces every Claude thread first without hiding
  // the rest of the catalog.
  const categoryFiltered = listings.filter((l) => activeCategory === "All" || l.category === activeCategory);
  const ranked = rankListings(categoryFiltered, query);
  const hasQuery = query.trim().length > 0;
  const matched = hasQuery ? ranked.filter((l) => scoreListing(l, query) > 0) : ranked;
  const unmatched = hasQuery ? ranked.filter((l) => scoreListing(l, query) === 0) : [];

  return (
    <>
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-full mb-6"
        style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", maxWidth: 420 }}
      >
        <Search size={14} color="#6B6F76" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search threads — e.g. Stripe checkout, onboarding..."
          className="text-sm bg-transparent outline-none w-full"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
        />
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {["All", ...CATEGORIES].map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className="px-3 py-1.5 text-sm rounded-full transition-colors"
            style={{
              fontFamily: "'IBM Plex Sans', sans-serif",
              background: activeCategory === cat ? "#14213D" : "transparent",
              color: activeCategory === cat ? "#F7F7F4" : "#14213D",
              border: "1px solid #14213D",
            }}
          >
            {cat}
          </button>
        ))}
      </div>

      <h2 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontStyle: "italic", color: "#14213D" }}>
        Continue where they left off
      </h2>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        {hasQuery
          ? `${matched.length} thread${matched.length !== 1 ? "s" : ""} matching "${query.trim()}"`
          : `${categoryFiltered.length} thread${categoryFiltered.length !== 1 ? "s" : ""} ready to unlock`}
      </p>

      {categoryFiltered.length === 0 ? (
        <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>
          No threads in this category yet.
        </p>
      ) : (
        <>
          {hasQuery && matched.length === 0 && (
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              Nothing matches "{query.trim()}" directly — here's everything else in this category.
            </p>
          )}

          {matched.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {matched.map((listing) => (
                <ListingCard key={listing.id} listing={listing} />
              ))}
            </div>
          )}

          {hasQuery && unmatched.length > 0 && (
            <>
              <div className="flex items-center gap-3 my-8">
                <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />
                <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  Other threads
                </span>
                <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {unmatched.map((listing) => (
                  <ListingCard key={listing.id} listing={listing} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
