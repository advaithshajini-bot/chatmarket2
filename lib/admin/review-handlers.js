// lib/admin/review-handlers.js
//
// Admin Moderation Desk server logic (framework-free; the routes under app/api/admin/reviews/** are glue only).
//
// AUTHORITY: every RPC below starts with private.is_admin_mfa() (admin AND JWT aal2) and answers 42501 otherwise, so
// the checks in the page are UX only. The caller's own client is used throughout; there is no service key.
//
// The server never trusts a hash from the browser, and never trusts the hash the seller submitted either: to approve
// a blueprint it downloads the stored object (admin read policy), RE-HASHES it, and hands THAT hash to
// public.review_listing_blueprint, which refuses unless it equals the hash recorded at submission (CM059). A file that
// changed since submission, vanished, stopped being valid, or now contains credentials cannot be approved here.

import { inspectBlueprintBytes, MAX_BLUEPRINT_BYTES } from "../blueprints/inspect.js";

export const BLUEPRINT_BUCKET = "listing-blueprints";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { MIN_REJECT_NOTE, MAX_NOTE } from "./review-constants.js";
export { MIN_REJECT_NOTE, MAX_NOTE };

export const ADMIN_ERROR_STATUS = {
  "28000": 401, "42501": 403,
  CM054: 409, CM055: 409, CM056: 409, CM057: 400, CM058: 422, CM059: 409, CM060: 403, CM061: 400, CM062: 404,
  CM001: 409, CM002: 409,           // the stored demo config is no longer valid (e.g. a model was deactivated)
};
const ADMIN_ERROR_COPY = {
  "28000": "You need to be logged in.",
  "42501": "Admin access with a verified MFA session is required.",
  CM054: "This demo isn't ready: it is disabled or has no sample input.",
  CM055: "This item is no longer waiting for review.",
  CM056: "The seller changed this demo after you opened it. Reload and review the new version.",
  CM057: `A note of at least ${MIN_REJECT_NOTE} characters is required to reject.`,
  CM058: "The blueprint file is missing or invalid.",
  CM059: "The stored file no longer matches what the seller submitted. Reject it, or ask the seller to resubmit.",
  CM060: "You can't review your own listing.",
  CM061: "Invalid decision.",
  CM062: "That item no longer exists.",
  CM001: "The demo configuration is over the platform caps. Reject it with a note.",
  CM002: "The demo configuration is no longer valid (for example a model was retired). Reject it with a note.",
};
export function adminErrorResponse(error, fallback = "Something went wrong. Please try again.") {
  const status = ADMIN_ERROR_STATUS[error?.code] ?? 500;
  return { status, json: { error: status === 500 ? fallback : ADMIN_ERROR_COPY[error.code] ?? fallback } };
}
const unauth = () => ({ status: 401, json: { error: "You need to be logged in." } });
const badId = () => ({ status: 400, json: { error: "Invalid id." } });
const okId = (v) => typeof v === "string" && UUID_RE.test(v);

function parseDecision(body, { needsVersion }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid request body." };
  const { decision } = body;
  if (decision !== "approve" && decision !== "reject") return { error: "decision must be 'approve' or 'reject'." };
  let note = body.note;
  if (note !== undefined && note !== null && typeof note !== "string") return { error: "note must be text." };
  note = typeof note === "string" ? note.trim() : "";
  if (note.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` };
  if (decision === "reject" && note.length < MIN_REJECT_NOTE) return { error: `A note of at least ${MIN_REJECT_NOTE} characters is required to reject.` };
  let expectedVersion;
  if (needsVersion) {
    expectedVersion = body.expectedVersion;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { error: "expectedVersion is required." };
  }
  return { decision, note: note || null, expectedVersion };
}

export async function getQueueHandler({ supabase, user }) {
  if (!user) return unauth();
  const { data, error } = await supabase.rpc("admin_review_queue", { p_limit: 100 });
  if (error) return adminErrorResponse(error, "Could not load the review queue.");
  return { status: 200, json: { queue: { demos: data?.demos ?? [], blueprints: data?.blueprints ?? [] } } };
}

export async function getDemoDetailHandler({ supabase, user, listingId }) {
  if (!user) return unauth();
  if (!okId(listingId)) return badId();
  const { data, error } = await supabase.rpc("admin_get_demo_for_review", { p_listing_id: listingId });
  if (error) return adminErrorResponse(error, "Could not load the demo.");
  return { status: 200, json: { demo: data } };
}

/** Download + inspect the stored object. Returns { status: 'match'|'mismatch'|'missing'|'invalid', ... } -- never throws. */
export async function verifyStoredBlueprint({ supabase, record, inspect = inspectBlueprintBytes }) {
  let blob;
  try {
    const r = await supabase.storage.from(BLUEPRINT_BUCKET).download(record.storagePath);
    if (r.error || !r.data) return { status: "missing" };
    blob = r.data;
  } catch { return { status: "missing" }; }
  if (blob.size > MAX_BLUEPRINT_BYTES) return { status: "invalid", reason: "too_large" };
  const result = await inspect(new Uint8Array(await blob.arrayBuffer()));
  if (!result.ok) return { status: "invalid", reason: result.code };
  return {
    status: result.sha256 === record.sha256 ? "match" : "mismatch",
    sha256: result.sha256, format: result.format, sizeBytes: result.sizeBytes, nodeCount: result.nodeCount,
    blocking: result.scan.blocking, warnings: result.scan.warnings,
  };
}

export async function getBlueprintDetailHandler({ supabase, user, submissionId, inspect }) {
  if (!user) return unauth();
  if (!okId(submissionId)) return badId();
  const { data, error } = await supabase.rpc("admin_get_blueprint_for_review", { p_submission_id: submissionId });
  if (error) return adminErrorResponse(error, "Could not load the blueprint.");
  const verification = await verifyStoredBlueprint({ supabase, record: data, inspect });
  let downloadUrl = null;
  try {
    const s = await supabase.storage.from(BLUEPRINT_BUCKET).createSignedUrl(data.storagePath, 60, { download: data.storagePath.split("/").pop() });
    downloadUrl = s?.data?.signedUrl ?? null;
  } catch { /* the review still works without a download link */ }
  const { storagePath, ...safe } = data;                      // the object path is not needed by the browser
  return { status: 200, json: { blueprint: safe, verification, downloadUrl } };
}

export async function reviewDemoHandler({ supabase, user, listingId, body }) {
  if (!user) return unauth();
  if (!okId(listingId)) return badId();
  const p = parseDecision(body, { needsVersion: true });
  if (p.error) return { status: 400, json: { error: p.error } };
  const { data, error } = await supabase.rpc("review_listing_demo", {
    p_listing_id: listingId, p_decision: p.decision, p_expected_version: p.expectedVersion, p_note: p.note,
  });
  if (error) return adminErrorResponse(error, "Could not record the decision.");
  return { status: 200, json: { result: data } };
}

export async function reviewBlueprintHandler({ supabase, user, submissionId, body, inspect }) {
  if (!user) return unauth();
  if (!okId(submissionId)) return badId();
  const p = parseDecision(body, { needsVersion: false });
  if (p.error) return { status: 400, json: { error: p.error } };

  let verified = null;
  if (p.decision === "approve") {
    const rec = await supabase.rpc("admin_get_blueprint_for_review", { p_submission_id: submissionId });
    if (rec.error) return adminErrorResponse(rec.error, "Could not load the blueprint.");
    const v = await verifyStoredBlueprint({ supabase, record: rec.data, inspect });
    if (v.status === "missing") return { status: 422, json: { error: ADMIN_ERROR_COPY.CM058, code: "missing" } };
    if (v.status === "invalid") return { status: 422, json: { error: "The stored file is no longer a valid blueprint.", code: v.reason } };
    if (v.status === "mismatch") return { status: 409, json: { error: ADMIN_ERROR_COPY.CM059, code: "hash_mismatch" } };
    if (v.blocking.length > 0) return { status: 422, json: { error: "The file contains what look like credentials, so it can't be approved. Reject it with a note.", code: "secrets", findings: v.blocking } };
    verified = v.sha256;                                   // recomputed from the stored bytes, just now
  }
  const { data, error } = await supabase.rpc("review_listing_blueprint", {
    p_submission_id: submissionId, p_decision: p.decision, p_verified_sha256: verified, p_note: p.note,
  });
  if (error) return adminErrorResponse(error, "Could not record the decision.");
  return { status: 200, json: { result: data } };
}
