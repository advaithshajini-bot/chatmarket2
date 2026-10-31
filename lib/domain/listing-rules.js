// lib/domain/listing-rules.js -- quality bars, media limits and price bounds for a new listing. Framework-free.
// The SAME numbers are enforced by the database (migration 20261031100000, private.enforce_listing_rules), so the form is only the friendly layer.

export const LISTING_RULES = {
  titleMin: 10,
  titleMax: 20,
  descriptionMin: 500,
  descriptionMax: 2000,
  zipContentsMin: 250,
  zipContentsMax: 500,
  screenshotsMin: 4,
  screenshotsMax: 10,
  photoMaxSizeBytes: 10 * 1024 * 1024,      // 10MB per photo
  videoMaxSizeBytes: 25 * 1024 * 1024,      // 25MB video
  videoMinDurationSeconds: 5,
  videoMaxDurationSeconds: 15,
  videosRequired: 1,
  priceMinRupees: 50,
  priceMaxRupees: 999,
};

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const VIDEO_TYPES = ["video/mp4", "video/webm"];

const len = (v) => (typeof v === "string" ? v.trim().length : 0);
const inRange = (n, lo, hi) => n >= lo && n <= hi;

/** Text rules for a playbook listing. @returns {{ ok: boolean, errors: { title?: string, description?: string, zipContents?: string } }} */
export function validateListingText({ title, description, zipContents } = {}) {
  const errors = {};
  const R = LISTING_RULES;
  if (!inRange(len(title), R.titleMin, R.titleMax)) errors.title = `The title must be ${R.titleMin} to ${R.titleMax} characters (${len(title)} now).`;
  if (!inRange(len(description), R.descriptionMin, R.descriptionMax)) errors.description = `The description must be ${R.descriptionMin} to ${R.descriptionMax} characters (${len(description)} now).`;
  if (!inRange(len(zipContents), R.zipContentsMin, R.zipContentsMax)) errors.zipContents = `The zip contents note must be ${R.zipContentsMin} to ${R.zipContentsMax} characters (${len(zipContents)} now).`;
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

/** Screenshots: 4 to 10 uploaded images. @param count number of uploaded screenshots */
export function validateScreenshotCount(count) {
  const R = LISTING_RULES;
  if (!Number.isInteger(count) || count < R.screenshotsMin) return { ok: false, error: `Add at least ${R.screenshotsMin} screenshots (${count || 0} uploaded).` };
  if (count > R.screenshotsMax) return { ok: false, error: `Use at most ${R.screenshotsMax} screenshots.` };
  return { ok: true, error: null };
}

/** One image file picked in the browser: type + 10MB cap. */
export function validateImageFile(file) {
  if (!file || !IMAGE_TYPES.includes(file.type)) return { ok: false, error: `${file?.name ?? "That file"} isn't a supported image type (PNG, JPEG or WebP).` };
  if (file.size > LISTING_RULES.photoMaxSizeBytes) return { ok: false, error: `${file.name} is over the 10MB limit.` };
  return { ok: true, error: null };
}

/** The preview video file: .mp4 / .webm, under 25MB. Duration is checked separately once the browser has read the metadata. */
export function validateVideoFile(file) {
  if (!file || !(VIDEO_TYPES.includes(file.type) || /\.(mp4|webm)$/i.test(file.name ?? ""))) return { ok: false, error: "The preview video must be an .mp4 or .webm file." };
  if (file.size > LISTING_RULES.videoMaxSizeBytes) return { ok: false, error: "Video must be under 25MB." };
  return { ok: true, error: null };
}

export function validateVideoDuration(seconds) {
  const R = LISTING_RULES;
  if (!Number.isFinite(seconds) || seconds < R.videoMinDurationSeconds || seconds > R.videoMaxDurationSeconds) {
    return { ok: false, error: `Video duration must be between ${R.videoMinDurationSeconds} and ${R.videoMaxDurationSeconds} seconds.` };
  }
  return { ok: true, error: null };
}

/** 8.4 -> "0:08" */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Everything a playbook needs before it can be submitted. media = { screenshotCount, video: { duration } | null } */
export function validatePlaybookListing({ title, description, zipContents, price, screenshotCount, video } = {}) {
  const text = validateListingText({ title, description, zipContents });
  const errors = { ...text.errors };
  const shots = validateScreenshotCount(screenshotCount);
  if (!shots.ok) errors.screenshots = shots.error;
  if (!video) errors.video = "Add the preview video (5 to 15 seconds).";
  else { const d = validateVideoDuration(video.duration); if (!d.ok) errors.video = d.error; }
  const p = validateListingPrice(price);
  if (!p.ok) errors.price = p.error;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Rules for workflow / agent listings (no zip note, no media yet): title, description and price. */
export function validateProductListing({ title, description, price } = {}) {
  const errors = {};
  const R = LISTING_RULES;
  if (!inRange(len(title), R.titleMin, R.titleMax)) errors.title = `The title must be ${R.titleMin} to ${R.titleMax} characters.`;
  if (!inRange(len(description), R.descriptionMin, R.descriptionMax)) errors.description = `The description must be ${R.descriptionMin} to ${R.descriptionMax} characters.`;
  const p = validateListingPrice(price);
  if (!p.ok) errors.price = p.error;
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Plain sentence for a database refusal (CM081). */
export function explainListingRuleError(error) {
  const m = String(error?.message || "");
  const R = LISTING_RULES;
  if (/title_out_of_range/.test(m)) return `The title must be ${R.titleMin} to ${R.titleMax} characters.`;
  if (/description_out_of_range/.test(m)) return `The description must be ${R.descriptionMin} to ${R.descriptionMax} characters.`;
  if (/zip_contents_out_of_range/.test(m)) return `The zip contents note must be ${R.zipContentsMin} to ${R.zipContentsMax} characters.`;
  if (/screenshots_count_invalid/.test(m)) return `Add ${R.screenshotsMin} to ${R.screenshotsMax} screenshots.`;
  if (/video_required/.test(m)) return "Add the preview video.";
  if (/video_duration_out_of_range/.test(m)) return `Video duration must be between ${R.videoMinDurationSeconds} and ${R.videoMaxDurationSeconds} seconds.`;
  if (/price_out_of_range/.test(m)) return `The price must be between ₹${R.priceMinRupees} and ₹${R.priceMaxRupees}.`;
  return null;
}
