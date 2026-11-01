// Names shown to other people (seller, creator, account badge) must never be an email address.
// Mirrors private.safe_public_name() in the database: an email becomes the part before '@' with separators turned into spaces.
export const DEFAULT_CREATOR_NAME = "Verified Creator";

export function safePublicName(value) {
  if (typeof value !== "string") return null;
  const base = value.includes("@") ? value.split("@")[0] : value;
  const cleaned = base.replace(/[._+-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

/** Display name for a seller: the first usable candidate, else "Verified Creator". */
export function publicSellerName(...candidates) {
  for (const c of candidates) { const n = safePublicName(c); if (n) return n; }
  return DEFAULT_CREATOR_NAME;
}

/** "Asha Rao" -> "Asha" (for the "Hello, ..." line). */
export function firstName(value) {
  const n = safePublicName(value);
  return n ? n.split(" ")[0] : null;
}
