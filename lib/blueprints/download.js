// lib/blueprints/download.js
//
// Hands a BUYER a short-lived signed URL for a listing's blueprint file.
//
// The access check is Storage RLS, not this code: the signed URL is created with the CALLER'S OWN
// client, and storage.objects only lets that user SELECT the object if they are the seller, an admin,
// or hold a purchases row with status 'paid' for that listing (migration 20260930100600). So there is
// no service key here and nothing to forget to check. A refund removes access to new URLs; a file
// already downloaded cannot be recalled.
//
// Framework-free so it can be unit-tested with plain `node`.

export const BLUEPRINT_BUCKET = "listing-blueprints";
export const DEFAULT_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getBlueprintDownloadHandler({ supabase, user, listingId, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!user) {
    return { status: 401, json: { error: "You need to be logged in to download a blueprint." } };
  }
  if (typeof listingId !== "string" || !UUID_RE.test(listingId)) {
    return { status: 400, json: { error: "Invalid listing id." } };
  }
  const ttl = Math.min(Math.max(Math.trunc(Number(ttlSeconds)) || DEFAULT_TTL_SECONDS, 1), MAX_TTL_SECONDS);

  const { data: listing, error: lookupErr } = await supabase
    .from("listings")
    .select("blueprint_path, blueprint_format, blueprint_sha256, blueprint_size_bytes")
    .eq("id", listingId)
    .maybeSingle();
  if (lookupErr) return { status: 500, json: { error: "Could not look up the blueprint." } };
  if (!listing || !listing.blueprint_path) {
    return { status: 404, json: { error: "This listing has no downloadable blueprint." } };
  }

  const filename = listing.blueprint_path.split("/").pop();
  const { data: signed, error: signErr } = await supabase.storage
    .from(BLUEPRINT_BUCKET)
    .createSignedUrl(listing.blueprint_path, ttl, { download: filename });
  if (signErr || !signed?.signedUrl) {
    // Storage answers "object not found" when RLS denies the read: no purchase (or refunded)
    return { status: 403, json: { error: "Purchase the listing to download its blueprint." } };
  }

  return {
    status: 200,
    json: {
      url: signed.signedUrl,
      filename,
      format: listing.blueprint_format,
      sha256: listing.blueprint_sha256,
      sizeBytes: listing.blueprint_size_bytes,
      expiresInSeconds: ttl,
    },
  };
}
