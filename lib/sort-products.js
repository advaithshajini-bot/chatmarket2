// lib/sort-products.js
//
// Phase 2 — pure comparator logic for the Browse page's sort control,
// extracted from components/SortControl.jsx so it can be unit-tested
// without a JSX transpiler. "Popular" is defined from real existing
// fields (rating, reviews), not an invented metric.

export function sortProducts(products, sort) {
  const list = [...products];
  switch (sort) {
    case "popular":
      return list.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || (b.rating ?? 0) - (a.rating ?? 0));
    case "newest":
      return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    case "price_low":
      return list.sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    case "price_high":
      return list.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    case "rating":
      return list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    case "relevance":
    default:
      return list;
  }
}
