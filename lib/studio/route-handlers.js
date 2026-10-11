// lib/studio/route-handlers.js
//
// Seller Studio server logic. Framework-free (relative imports only, no next/server) so plain `node` tests can
// import it; the files under app/api/studio/** are glue only.
//
// Authority: every write goes through a SECURITY DEFINER RPC (migration 20260930100800) under the CALLER'S OWN
// client. There is no service-role key anywhere in this flow. The blueprint registration route trusts ONLY the
// storage path from the browser: it downloads the stored object with the seller's own session (Storage RLS),
// re-inspects it (size, UTF-8, JSON, format, SHA-256, secret scan) and passes the values it computed itself.

import { inspectBlueprintBytes, MAX_BLUEPRINT_BYTES, BLUEPRINT_PATH_RE } from "../blueprints/inspect.js";
import { validateDraft, draftToConfig } from "./demo-draft.js";

export const BLUEPRINT_BUCKET = "listing-blueprints";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STUDIO_ERROR_STATUS = {
  "28000": 401, "42501": 403,
  CM001: 400, CM002: 400,           // demo config over the cap / invalid
  CM051: 404,                       // listing not found (or not yours)
  CM052: 400,                       // sample input invalid
  CM053: 400,                       // only workflow / agent listings
  CM054: 409,                       // demo not ready to submit
  CM055: 409,                       // wrong review state
  CM058: 422,                       // blueprint rejected by the database
};
const STUDIO_ERROR_COPY = {
  "28000": "You need to be logged in.",
  "42501": "You don't have access to that.",
  CM001: "A demo can have at most 2 steps.",
  CM002: "The demo configuration isn't valid. Check the steps, models and limits.",
  CM051: "We couldn't find that listing among yours.",
  CM052: "The sample input must be 1-2000 characters and not blank.",
  CM053: "Demos and blueprints are only available for workflow and agent listings.",
  CM054: "Save an enabled demo with a sample input before submitting it.",
  CM055: "This item can't be submitted right now - it may already be waiting for review.",
  CM058: "The blueprint file couldn't be accepted. Upload it again.",
};
export function studioErrorResponse(error, fallback = "Something went wrong. Please try again.") {
  const status = STUDIO_ERROR_STATUS[error?.code] ?? 500;
  return { status, json: { error: status === 500 ? fallback : STUDIO_ERROR_COPY[error.code] ?? fallback } };
}

const unauth = () => ({ status: 401, json: { error: "You need to be logged in." } });
const badId = () => ({ status: 400, json: { error: "Invalid listing id." } });

export async function listModelsHandler({ supabase, user }) {
  if (!user) return unauth();
  const { data, error } = await supabase.rpc("list_demo_models");
  if (error) return studioErrorResponse(error, "Could not load the model list.");
  return { status: 200, json: { models: Array.isArray(data) ? data : [] } };
}

/** PUT { sampleInput, isEnabled, steps:[{name?, model, system, maxOutputTokens, timeoutSeconds}] } */
export async function saveDemoHandler({ supabase, user, listingId, body }) {
  if (!user) return unauth();
  if (typeof listingId !== "string" || !UUID_RE.test(listingId)) return badId();
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, json: { error: "Invalid request body." } };

  const models = await supabase.rpc("list_demo_models");
  if (models.error) return studioErrorResponse(models.error, "Could not validate the demo.");
  const allowed = (Array.isArray(models.data) ? models.data : []).map((m) => m.model);

  const draft = { sampleInput: body.sampleInput, isEnabled: body.isEnabled !== false, steps: body.steps };
  const v = validateDraft(draft, allowed);
  if (!v.ok) return { status: 400, json: { error: "Please fix the highlighted fields.", errors: v.errors } };

  const { data, error } = await supabase.rpc("save_listing_demo", {
    p_listing_id: listingId,
    p_demo_config: draftToConfig(draft),
    p_sample_input: draft.sampleInput.trim(),
    p_is_enabled: draft.isEnabled,
  });
  if (error) return studioErrorResponse(error, "Could not save the demo.");
  return { status: 200, json: { demo: data } };
}

export async function submitDemoHandler({ supabase, user, listingId }) {
  if (!user) return unauth();
  if (typeof listingId !== "string" || !UUID_RE.test(listingId)) return badId();
  const { data, error } = await supabase.rpc("submit_listing_demo_for_review", { p_listing_id: listingId });
  if (error) return studioErrorResponse(error, "Could not submit the demo.");
  return { status: 200, json: { demo: data } };
}

/** POST { path } -- the object the browser already uploaded to the private bucket. */
export async function registerBlueprintHandler({ supabase, user, listingId, body, inspect = inspectBlueprintBytes }) {
  if (!user) return unauth();
  if (typeof listingId !== "string" || !UUID_RE.test(listingId)) return badId();
  const path = body?.path;
  const parts = typeof path === "string" ? path.split("/") : [];
  if (typeof path !== "string" || !BLUEPRINT_PATH_RE.test(path)
      || parts[0] !== String(user.id).toLowerCase() || parts[1] !== listingId.toLowerCase()) {
    return { status: 400, json: { error: "Invalid upload path." } };
  }
  // best-effort cleanup of an object we are not going to keep (Storage RLS refuses to delete a pending/live one)
  const discard = async () => { try { await supabase.storage.from(BLUEPRINT_BUCKET).remove([path]); } catch { /* ignore */ } };

  const { data: blob, error: dlErr } = await supabase.storage.from(BLUEPRINT_BUCKET).download(path);
  if (dlErr || !blob) return { status: 404, json: { error: "We couldn't find the uploaded file. Please upload it again." } };
  if (blob.size > MAX_BLUEPRINT_BYTES) { await discard(); return { status: 422, json: { error: "The file is larger than 5 MB.", code: "too_large" } }; }

  const result = await inspect(new Uint8Array(await blob.arrayBuffer()));
  if (!result.ok) { await discard(); return { status: 422, json: { error: result.message, code: result.code } }; }
  if (result.scan.blocking.length > 0) {
    await discard();
    return { status: 422, json: { error: "This file appears to contain credentials. Remove them and upload it again.", code: "secrets", findings: result.scan.blocking } };
  }

  const { data, error } = await supabase.rpc("submit_listing_blueprint", {
    p_listing_id: listingId, p_path: path, p_format: result.format, p_sha256: result.sha256, p_size_bytes: result.sizeBytes,
    p_scan: { blocking: 0, warnings: result.scan.warnings.length, nodeCount: result.nodeCount, warningTypes: [...new Set(result.scan.warnings.map((w) => w.type))] },
  });
  if (error) { await discard(); return studioErrorResponse(error, "Could not register the blueprint."); }
  return {
    status: 201,
    json: { submissionId: data, format: result.format, sha256: result.sha256, sizeBytes: result.sizeBytes, nodeCount: result.nodeCount, warnings: result.scan.warnings },
  };
}
