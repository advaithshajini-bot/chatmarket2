"use client";

import { useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { CATEGORIES } from "@/lib/categories";
import { scoreListing, rankListings } from "@/lib/search-relevance";
import { PRODUCT_TYPE_ORDER } from "@/lib/product-types";
import SearchBar from "@/components/SearchBar";
import CategoryChip from "@/components/CategoryChip";
import ProductTypeTabs from "@/components/ProductTypeTabs";
import SortControl from "@/components/SortControl";
import { sortProducts } from "@/lib/sort-products";
import ProductCard from "@/components/ProductCard";

export default function BrowseClient({ products }) {
  const searchParams = useSearchParams();
  const categoryFromUrl = searchParams.get("category");
  const typeFromUrl = searchParams.get("type");

  const [activeCategory, setActiveCategory] = useState(
    categoryFromUrl && CATEGORIES.includes(categoryFromUrl) ? categoryFromUrl : (categoryFromUrl || "All")
  );
  const [activeType, setActiveType] = useState(
    typeFromUrl && PRODUCT_TYPE_ORDER.includes(typeFromUrl) ? typeFromUrl : "all"
  );
  const [sort, setSort] = useState("relevance");
  const [query, setQuery] = useState(searchParams.get("q") || "");

  // Custom categories a seller typed in via "Other" when listing a product
  // (e.g. "Data Science") show up here automatically the moment that
  // listing goes live -- this component only ever receives live listings,
  // so there's nothing extra to wire up: whatever distinct category values
  // exist in the data beyond the fixed list are exactly the custom ones.
  const extraCategories = [...new Set(products.map((p) => p.category))]
    .filter((c) => c && !CATEGORIES.includes(c))
    .sort();
  const [showAllCategories, setShowAllCategories] = useState(
    !!(categoryFromUrl && extraCategories.includes(categoryFromUrl))
  );
  const visibleCategories = showAllCategories ? [...CATEGORIES, ...extraCategories] : CATEGORIES;

  const typeCounts = useMemo(() => {
    const counts = { all: products.length };
    for (const t of PRODUCT_TYPE_ORDER) counts[t] = products.filter((p) => p.type === t).length;
    return counts;
  }, [products]);

  // Category and product-type are hard filters (an explicit choice the
  // person made), but the search query is a ranking, not a filter: matches
  // sort to the top by field relevance (model > title > category >
  // description) and everything else stays visible afterward, in its
  // original order -- typing "claude" surfaces every Claude playbook first
  // without hiding the rest of the catalog.
  const typeFiltered = activeType === "all" ? products : products.filter((p) => p.type === activeType);
  const categoryFiltered = typeFiltered.filter((p) => activeCategory === "All" || p.category === activeCategory);

  // rankListings/scoreListing were written for the flat pre-Phase-2 row
  // shape (listing.model at the top level). lib/domain's toProduct()
  // deliberately nests legacy playbook-only fields under
  // legacyPlaybookFields instead of flattening them -- rather than change
  // that Phase 1 design, adapt here with a tiny local mapping just for the
  // ranking call.
  const searchable = categoryFiltered.map((p) => ({ ...p, model: p.legacyPlaybookFields?.model }));
  const ranked = rankListings(searchable, query);
  const hasQuery = query.trim().length > 0;
  const matched = hasQuery ? ranked.filter((p) => scoreListing(p, query) > 0) : ranked;
  const unmatched = hasQuery ? ranked.filter((p) => scoreListing(p, query) === 0) : [];

  const sortedMatched = sort === "relevance" && hasQuery ? matched : sortProducts(matched, sort);
  const sortedUnmatched = sortProducts(unmatched, sort);

  return (
    <>
      <h1
        className="text-3xl mb-1"
        style={{ fontFamily: "'Fraunces', serif", fontStyle: "italic", color: "#14213D" }}
      >
        Explore AI products for work
      </h1>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        {hasQuery
          ? `${matched.length} product${matched.length !== 1 ? "s" : ""} matching "${query.trim()}"`
          : `${categoryFiltered.length} product${categoryFiltered.length !== 1 ? "s" : ""} ready to unlock`}
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <SearchBar
          value={query}
          onChange={setQuery}
          placeholder="Search products — e.g. lead qualifier, contract summary..."
          maxWidth={420}
          className="flex-1 min-w-[240px]"
        />
        <SortControl value={sort} onChange={setSort} />
      </div>

      <ProductTypeTabs value={activeType} onChange={setActiveType} counts={typeCounts} />

      <div className="flex flex-wrap items-center gap-2 mb-6">
        {["All", ...visibleCategories].map((cat) => (
          <CategoryChip key={cat} label={cat} active={activeCategory === cat} onClick={() => setActiveCategory(cat)} />
        ))}
        {!showAllCategories && extraCategories.length > 0 && (
          <CategoryChip label="See all →" dashed onClick={() => setShowAllCategories(true)} />
        )}
      </div>

      {categoryFiltered.length === 0 ? (
        <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>
          No products in this category yet.
        </p>
      ) : (
        <>
          {hasQuery && matched.length === 0 && (
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              Nothing matches "{query.trim()}" directly — here's everything else in this category.
            </p>
          )}

          {sortedMatched.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {sortedMatched.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </div>
          )}

          {hasQuery && sortedUnmatched.length > 0 && (
            <>
              <div className="flex items-center gap-3 my-8">
                <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />
                <span
                  className="text-xs uppercase tracking-wide"
                  style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}
                >
                  Other products
                </span>
                <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {sortedUnmatched.map((product) => (
                  <ProductCard key={product.id} product={product} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
