// lib/domain/studio.js -- the seller's own view of a listing's demo + blueprint state. Like every lib/domain module it
// takes the caller's Supabase client and runs under that session (RLS: sellers read only their own rows); nothing
// here uses a service-role client. Explicit column lists only.

import { configToDraft } from "../studio/demo-draft.js";

const DEMO_COLUMNS = "demo_config, sample_input, is_enabled, review_status, review_note, config_version, submitted_at";
const SUBMISSION_COLUMNS = "id, format, size_bytes, status, review_note, submitted_at";

/** Pure: normalise the raw rows. Never throws. */
export function toStudioState({ listing, demo, submissions, models }) {
  if (!listing) return null;
  const modelIds = (Array.isArray(models) ? models : []).filter((m) => m && typeof m.model === "string");
  const defaultModel = modelIds.find((m) => m.isDefault)?.model ?? modelIds[0]?.model ?? "";
  return {
    listing: { id: listing.id, title: listing.title ?? "", status: listing.status ?? "", productType: listing.product_type ?? "" },
    eligible: listing.product_type === "workflow" || listing.product_type === "agent",
    models: modelIds,
    defaultModel,
    demo: demo
      ? { reviewStatus: demo.review_status ?? "draft", reviewNote: demo.review_note ?? null, configVersion: demo.config_version ?? 1,
          submittedAt: demo.submitted_at ?? null, isEnabled: demo.is_enabled !== false, draft: configToDraft(demo.demo_config, demo.sample_input, demo.is_enabled) }
      : null,
    liveBlueprint: listing.blueprint_format ? { format: listing.blueprint_format, sizeBytes: listing.blueprint_size_bytes ?? null } : null,
    submissions: (Array.isArray(submissions) ? submissions : []).map((s) => ({
      id: s.id, format: s.format, sizeBytes: s.size_bytes, status: s.status, reviewNote: s.review_note ?? null, submittedAt: s.submitted_at,
    })),
  };
}

export async function getStudioState(supabase, listingId, userId) {
  try {
    const { data: listing } = await supabase.from("listings")
      .select("id, title, status, product_type, seller_id, blueprint_format, blueprint_size_bytes").eq("id", listingId).maybeSingle();
    if (!listing || listing.seller_id !== userId) return null;           // not yours -> same answer as "does not exist"
    const [{ data: demo }, { data: submissions }, { data: models }] = await Promise.all([
      supabase.from("listing_demos").select(DEMO_COLUMNS).eq("listing_id", listingId).maybeSingle(),
      supabase.from("blueprint_submissions").select(SUBMISSION_COLUMNS).eq("listing_id", listingId).order("submitted_at", { ascending: false }).limit(5),
      supabase.rpc("list_demo_models"),
    ]);
    return toStudioState({ listing, demo, submissions, models });
  } catch {
    return null;
  }
}
