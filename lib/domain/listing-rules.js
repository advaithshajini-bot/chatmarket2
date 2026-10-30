// lib/domain/listing-rules.js -- minimum quality bars and price bounds for a new listing. Framework-free.
// The SAME numbers are enforced by the database (migration 20261030100000, private.enforce_listing_rules), so the form is only the friendly layer.

export const LISTING_RULES = {
  titleMin: 10,
  descriptionMin: 500,
  zipContentsMin: 250,
  priceMinRupees: 50,      // 5,000 paise
  priceMaxRupees: 999,     // 99,900 paise
};

const len = (v) => (typeof v === "string" ? v.trim().length : 0);

/** Text rules for a playbook listing. @returns {{ ok: boolean, errors: { title?: string, description?: string, zipContents?: string } }} */
export function validateListingText({ title, description, zipContents } = {}) {
  const errors = {};
  if (len(title) < LISTING_RULES.titleMin) errors.title = `The title needs at least ${LISTING_RULES.titleMin} characters.`;
  if (len(description) < LISTING_RULES.descriptionMin) errors.description = `The description needs at least ${LISTING_RULES.descriptionMin} characters (${len(description)} so far).`;
  if (len(zipContents) < LISTING_RULES.zipContentsMin) errors.zipContents = `Describe what's in the zip in at least ${LISTING_RULES.zipContentsMin} characters (${len(zipContents)} so far).`;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Price in whole rupees, ₹50 to ₹999. Accepts a number or a numeric string. */
export function validateListingPrice(price) {
  const n = typeof price === "string" && price.trim() === "" ? NaN : Number(price);
  if (!Number.isFinite(n)) return { ok: false, error: "Enter a price." };
  if (n < LISTING_RULES.priceMinRupees) return { ok: false, error: `The minimum price is ₹${LISTING_RULES.priceMinRupees}.` };
  if (n > LISTING_RULES.priceMaxRupees) return { ok: false, error: `The maximum price is ₹${LISTING_RULES.priceMaxRupees}.` };
  return { ok: true, error: null };
}

/** Rules for workflow / agent listings (no zip note): title, description and price. */
export function validateProductListing({ title, description, price } = {}) {
  const errors = {};
  if (len(title) < LISTING_RULES.titleMin) errors.title = `The title needs at least ${LISTING_RULES.titleMin} characters.`;
  if (len(description) < LISTING_RULES.descriptionMin) errors.description = `The description needs at least ${LISTING_RULES.descriptionMin} characters.`;
  const p = validateListingPrice(price);
  if (!p.ok) errors.price = p.error;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Plain sentence for a database refusal (CM081). */
export function explainListingRuleError(error) {
  const m = String(error?.message || "");
  if (/title_too_short/.test(m)) return `The title needs at least ${LISTING_RULES.titleMin} characters.`;
  if (/description_too_short/.test(m)) return `The description needs at least ${LISTING_RULES.descriptionMin} characters.`;
  if (/zip_contents_too_short/.test(m)) return `Describe what's in the zip in at least ${LISTING_RULES.zipContentsMin} characters.`;
  if (/price_out_of_range/.test(m)) return `The price must be between ₹${LISTING_RULES.priceMinRupees} and ₹${LISTING_RULES.priceMaxRupees}.`;
  return null;
}
