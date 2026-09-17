// lib/domain/products.js
//
// Chatmarket 2.0 Phase 1 domain layer.
//
// `listings` is, and for now remains, the physical table for the Product
// domain (see supabase/migrations -- this is a deliberate decision, not
// an oversight). This module is the seam: everything elsewhere in the app
// that wants "a product" should go through here rather than querying
// `listings` directly with ad hoc field names, so that if Product ever
// does become its own physical table later, callers don't need to change.
//
// All functions take a Supabase client (from lib/supabase/server.js or
// lib/supabase/client.js) as their first argument and run under that
// client's own session -- RLS applies exactly as it does for any other
// query in this app. Nothing here uses a service-role/bypass client.

import { PRODUCT_TYPES } from "../validation/shared.js";

export { PRODUCT_TYPES };

/**
 * Normalizes a raw `listings` row into a Product-shaped object. Existing
 * playbook-specific columns (thread/preview/output_zip_path/zip_contents)
 * are preserved under `legacyPlaybookFields` rather than renamed, so nothing
 * about the existing conversation-listing rendering path needs to change.
 */
export function toProduct(listingRow) {
  if (!listingRow) return null;
  const {
    id,
    title,
    description,
    category,
    price,
    status,
    seller_id,
    seller_name,
    product_type,
    version,
    configuration,
    created_at,
    thread,
    preview,
    screenshots,
    output_zip_path,
    zip_contents,
    messages,
    completion,
    model,
    rating,
    reviews,
  } = listingRow;

  return {
    id,
    title,
    description,
    category,
    price,
    status,
    sellerId: seller_id,
    sellerName: seller_name,
    type: product_type,
    version,
    configuration: configuration ?? {},
    createdAt: created_at,
    rating,
    reviewCount: reviews,
    isPlaybook: product_type === "playbook",
    isWorkflow: product_type === "workflow",
    isAgent: product_type === "agent",
    // Legacy/playbook-specific fields -- present regardless of type today
    // since they live as columns on the same physical row, but only
    // meaningful for product_type = 'playbook'.
    legacyPlaybookFields: {
      thread,
      preview,
      screenshots,
      outputZipPath: output_zip_path,
      zipContentsNote: zip_contents,
      messages,
      completion,
      model,
    },
  };
}

const PRODUCT_SELECT_COLUMNS =
  "id, title, description, category, price, status, seller_id, seller_name, product_type, version, configuration, created_at, thread, preview, screenshots, output_zip_path, zip_contents, messages, completion, model, rating, reviews";

/**
 * Fetch a single product by id. Returns null if not found or not visible
 * to the caller under RLS (the same "not found vs not authorized" as
 * every other lookup in this app -- RLS makes the distinction
 * unobservable to the caller, which is the correct behavior).
 */
export async function getProduct(supabase, productId) {
  const { data, error } = await supabase
    .from("listings")
    .select(PRODUCT_SELECT_COLUMNS)
    .eq("id", productId)
    .maybeSingle();

  if (error) throw error;
  return toProduct(data);
}

/**
 * Browse-style product listing. `type` narrows to a single product_type;
 * omit it to get all types mixed together (the marketplace redesign in a
 * later phase decides how to actually present that mix -- this function
 * just fetches it).
 */
export async function listProducts(supabase, { type, status = "live", limit = 50 } = {}) {
  if (type && !PRODUCT_TYPES.includes(type)) {
    throw new Error(`Unknown product type "${type}"`);
  }

  let query = supabase
    .from("listings")
    .select(PRODUCT_SELECT_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (status) query = query.eq("status", status);
  if (type) query = query.eq("product_type", type);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(toProduct);
}

/**
 * Products a given seller/creator owns, regardless of status -- the
 * Creator Studio "my products" view (extends today's seller dashboard).
 */
export async function listProductsBySeller(supabase, sellerId) {
  const { data, error } = await supabase
    .from("listings")
    .select(PRODUCT_SELECT_COLUMNS)
    .eq("seller_id", sellerId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map(toProduct);
}
