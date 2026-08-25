// Relevance ranking, not filtering: every listing stays in the results —
// matches just sort to the top. A search for "claude" should show every
// Claude-model thread first, then every other thread afterward, not hide
// them. Multi-word queries ("powerpoint presentation") score each word
// independently across model/title/category/description, so a listing
// matching either word still ranks above one matching neither.

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(query) {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

// Field weights reflect how strongly a match there signals relevance: the
// source model and title are the strongest signals, category next,
// description weakest (it's prose, more prone to incidental word overlap).
const FIELD_WEIGHTS = { model: 5, title: 4, category: 3, description: 1 };

function fieldScore(fieldValue, tokens, weight) {
  if (!fieldValue) return 0;
  const lower = String(fieldValue).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower === token) score += weight * 3; // whole field is exactly the term
    else if (new RegExp(`\\b${escapeRegExp(token)}\\b`).test(lower)) score += weight * 2; // whole-word match
    else if (lower.includes(token)) score += weight; // substring match
  }
  return score;
}

export function scoreListing(listing, query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  return (
    fieldScore(listing.model, tokens, FIELD_WEIGHTS.model) +
    fieldScore(listing.title, tokens, FIELD_WEIGHTS.title) +
    fieldScore(listing.category, tokens, FIELD_WEIGHTS.category) +
    fieldScore(listing.description, tokens, FIELD_WEIGHTS.description)
  );
}

// Stable sort by score descending -- ties (including all-zero when there's
// no query) keep their original relative order rather than reshuffling.
export function rankListings(listings, query) {
  if (!query || !query.trim()) return listings;
  return listings
    .map((listing, index) => ({ listing, index, score: scoreListing(listing, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.listing);
}
