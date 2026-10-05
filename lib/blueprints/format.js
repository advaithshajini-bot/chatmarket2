// lib/blueprints/format.js -- pure display helpers for the blueprint download card (unit-tested in node).

export const FORMAT_LABELS = { n8n: "n8n workflow", flowise: "Flowise flow", langflow: "LangFlow template" };
export const formatLabel = (format) => FORMAT_LABELS[format] ?? "Blueprint";

export function formatBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shell commands a buyer can paste to verify the downloaded file against the listing's SHA-256. */
export function checksumCommands(filename) {
  const f = String(filename ?? "blueprint.json").replace(/[^A-Za-z0-9._-]/g, "_");
  return { unix: `sha256sum ${f}`, windows: `Get-FileHash ${f} -Algorithm SHA256` };
}

export function describeBlueprintError({ status, refunded = false } = {}) {
  if (status === 401) return "Log in to download your blueprint.";
  if (status === 403) return refunded ? "Blueprint access ended with your refund." : "Blueprint downloads are available to buyers of this listing.";
  if (status === 404) return "The seller hasn't attached a downloadable blueprint to this listing yet.";
  return "Couldn't prepare the download. Please try again in a moment.";
}
