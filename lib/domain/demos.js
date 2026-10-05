// lib/domain/demos.js
//
// Domain-layer access to the PUBLIC demo availability answer (public.listing_demo_info). Like every
// lib/domain module it takes the caller's Supabase client and runs under that session; nothing here uses a
// service-role client. listing_demos itself is private (the demo prompts are the seller's IP): this function
// is the only way a listing page learns whether, and how, a demo can be tried.

const UNAVAILABLE = Object.freeze({ available: false });

/** Normalises whatever the database returned. Never throws: any doubt -> { available: false }. */
export function toDemoInfo(raw) {
  if (!raw || typeof raw !== "object" || raw.available !== true) return UNAVAILABLE;
  const stepNames = Array.isArray(raw.stepNames) ? raw.stepNames.filter((n) => typeof n === "string").slice(0, 2) : [];
  if (stepNames.length === 0) return UNAVAILABLE;
  const int = (v, fallback) => (Number.isInteger(v) && v >= 0 ? v : fallback);
  return {
    available: true,
    stepNames,
    maxInputChars: int(raw.maxInputChars, 2000) || 2000,
    runsPerDay: int(raw.runsPerDay, 3),
    remainingToday: raw.remainingToday === null || raw.remainingToday === undefined ? null : int(raw.remainingToday, 0),
    budgetExhausted: raw.budgetExhausted === true,
  };
}

export async function getListingDemoInfo(supabase, listingId) {
  try {
    const { data, error } = await supabase.rpc("listing_demo_info", { p_listing_id: listingId });
    if (error) return UNAVAILABLE;
    return toDemoInfo(data);
  } catch {
    return UNAVAILABLE;
  }
}
