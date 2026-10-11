// lib/studio/upload-flow.js -- the browser side of "attach a blueprint": inspect locally, upload to the private bucket
// under the seller's own session, then ask the server to register it. All I/O is injected, so it runs in plain node.
//
//   runBlueprintUpload({ file, sellerId, listingId, upload, register, randomHex?, inspect? })
//     -> { ok:true, inspection, registered } | { ok:false, stage, error, findings? }
//
// stages: "select" | "inspect" | "secrets" | "upload" | "register" | "verify"
// The local hash is a convenience: the SERVER recomputes it from the stored bytes. If the two disagree the upload
// is reported as failed ("verify") rather than silently trusted.

import { inspectBlueprintBytes, buildBlueprintPath, MAX_BLUEPRINT_BYTES } from "../blueprints/inspect.js";

export function randomHex12(cryptoImpl = globalThis.crypto) {
  const b = cryptoImpl.getRandomValues(new Uint8Array(6));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function checkSelectedFile(file) {
  if (!file) return "Choose a .json file.";
  if (!/\.json$/i.test(file.name ?? "")) return "The blueprint must be a .json file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_BLUEPRINT_BYTES) return "The file is larger than 5 MB.";
  return null;
}

/** Local inspection only (used to preview before the seller commits to an upload). */
export async function previewBlueprint(file, inspect = inspectBlueprintBytes) {
  const bad = checkSelectedFile(file);
  if (bad) return { ok: false, stage: "select", error: bad };
  const r = await inspect(await file.arrayBuffer());
  return r.ok ? { ok: true, inspection: r } : { ok: false, stage: "inspect", error: r.message };
}

export async function runBlueprintUpload({ file, sellerId, listingId, upload, register, randomHex = randomHex12, inspect = inspectBlueprintBytes }) {
  const preview = await previewBlueprint(file, inspect);
  if (!preview.ok) return preview;
  const { inspection } = preview;
  if (inspection.scan.blocking.length > 0) {
    return { ok: false, stage: "secrets", error: "This file appears to contain credentials. Remove them before uploading.", findings: inspection.scan.blocking };
  }
  const path = buildBlueprintPath(sellerId, listingId, randomHex());
  const up = await upload(path, file);
  if (up?.error) return { ok: false, stage: "upload", error: "The upload failed. Please try again." };
  const reg = await register(path);
  if (!reg?.ok) return { ok: false, stage: "register", error: reg?.json?.error ?? "Could not register the blueprint.", findings: reg?.json?.findings };
  if (reg.json?.sha256 !== inspection.sha256) {
    return { ok: false, stage: "verify", error: "The stored copy doesn't match the file you chose. Please upload it again." };
  }
  return { ok: true, inspection, registered: reg.json };
}
