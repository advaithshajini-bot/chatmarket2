// lib/blueprints/inspect.js
//
// Pure, framework-free inspection of a blueprint file (n8n / Flowise / LangFlow JSON). The SAME module runs in
// the browser (instant feedback in the Seller Studio) and on the server (the authoritative check): the browser's
// answer is a convenience, the server re-inspects the stored bytes and its answer is the one that counts.
//
//   inspectBlueprintBytes(bytes) -> { ok:true, format, sizeBytes, sha256, nodeCount, scan }  |  { ok:false, code, message }
//
// The secret scan is HEURISTIC. `blocking` findings are well-known credential shapes (the Studio refuses to upload
// them and the admin desk refuses to approve them); `warnings` are weaker hints a human should look at. Findings
// carry a TYPE and a JSON path only -- never the matched value -- so a leaked key is not copied into logs, the
// database or the UI.

export const MAX_BLUEPRINT_BYTES = 5 * 1024 * 1024;
export const BLUEPRINT_FORMATS = Object.freeze(["n8n", "flowise", "langflow"]);

const MAX_DEPTH = 64;
const MAX_VISITED = 250000;
const MAX_FINDINGS = 50;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** n8n: { nodes: [], connections: {} }; Flowise: { nodes: [], edges: [] }; LangFlow: { data: { nodes: [], edges: [] } }. */
export function detectFormat(doc) {
  if (!isObj(doc)) return null;
  if (isObj(doc.data) && Array.isArray(doc.data.nodes) && Array.isArray(doc.data.edges)) return "langflow";
  const n8n = Array.isArray(doc.nodes) && isObj(doc.connections);
  const flowise = Array.isArray(doc.nodes) && Array.isArray(doc.edges);
  if (n8n && flowise) return null;                // ambiguous: refuse rather than guess
  if (n8n) return "n8n";
  if (flowise) return "flowise";
  return null;
}

export function countNodes(doc, format) {
  if (format === "langflow") return doc.data.nodes.length;
  if (format === "n8n" || format === "flowise") return doc.nodes.length;
  return 0;
}

const BLOCKING_RULES = [
  ["anthropic_api_key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_api_key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["slack_webhook", /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ["stripe_live_key", /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ["private_key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
const URL_CREDS = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+):([^\s/@]+)@/i;
const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key|client[_-]?secret)/i;
const PLACEHOLDER = /^(?:\s*|.*(?:\{\{|\}\}|\$\{|\$json|\$env|<[^>]*>|your[_-]|example|placeholder|changeme|xxx+|\*{3,}|redacted|todo).*)$/i;

function classifyString(s) {
  for (const [type, re] of BLOCKING_RULES) if (re.test(s)) return type;
  const m = URL_CREDS.exec(s);
  if (m && !/[{$<]/.test(m[1] + m[2])) return "url_credentials";
  return null;
}

/** Walks every string value and every key. Returns { blocking:[{type,path}], warnings:[{type,path}] }. */
export function scanForSecrets(doc) {
  const blocking = [], warnings = [], seen = new Set();
  const add = (list, type, path) => {
    const k = `${type}@${path}`;
    if (list.length < MAX_FINDINGS && !seen.has(k)) { seen.add(k); list.push({ type, path: path.slice(0, 160) }); }
  };
  const stack = [[doc, "$", 0, ""]];
  let visited = 0;
  while (stack.length && visited < MAX_VISITED) {
    const [v, path, depth, key] = stack.pop();
    visited++;
    if (typeof v === "string") {
      const t = classifyString(v);
      if (t) add(blocking, t, path);
      else if (key && SENSITIVE_KEY.test(key) && v.length >= 8 && !PLACEHOLDER.test(v)) add(warnings, "sensitive_field_with_value", path);
    } else if (depth < MAX_DEPTH && v !== null && typeof v === "object") {
      if (Array.isArray(v)) v.forEach((x, i) => stack.push([x, `${path}[${i}]`, depth + 1, key]));
      else for (const k of Object.keys(v)) {
        const kt = classifyString(k);                                  // a credential used as a KEY
        if (kt) add(blocking, kt, `${path}.<key>`);
        stack.push([v[k], `${path}.${k}`, depth + 1, k]);
      }
    }
  }
  if (visited >= MAX_VISITED) add(warnings, "scan_truncated", "$");
  return { blocking, warnings };
}

export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto is not available");
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fail = (code, message) => ({ ok: false, code, message });

export const INSPECT_MESSAGES = {
  empty: "The file is empty.",
  too_large: "The file is larger than 5 MB.",
  not_utf8: "The file is not valid UTF-8 text.",
  not_json: "The file is not valid JSON.",
  not_object: "The file must be a JSON object exported from n8n, Flowise or LangFlow.",
  unknown_format: "Couldn't recognise this as an n8n, Flowise or LangFlow export.",
};

export async function inspectBlueprintBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0) return fail("empty", INSPECT_MESSAGES.empty);
  if (bytes.byteLength > MAX_BLUEPRINT_BYTES) return fail("too_large", INSPECT_MESSAGES.too_large);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("not_utf8", INSPECT_MESSAGES.not_utf8); }
  let doc;
  try { doc = JSON.parse(text); } catch { return fail("not_json", INSPECT_MESSAGES.not_json); }
  if (!isObj(doc)) return fail("not_object", INSPECT_MESSAGES.not_object);
  const format = detectFormat(doc);
  if (!format) return fail("unknown_format", INSPECT_MESSAGES.unknown_format);
  return {
    ok: true,
    format,
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),            // hash of the ORIGINAL bytes, exactly what a buyer will download
    nodeCount: countNodes(doc, format),
    scan: scanForSecrets(doc),
  };
}

/** Storage object name: <seller>/<listing>/bp-<random>.json (shape enforced by the DB and by Storage RLS). */
export function buildBlueprintPath(sellerId, listingId, randomHex) {
  if (!/^[0-9a-f]{12}$/.test(randomHex)) throw new Error("randomHex must be 12 lowercase hex chars");
  return `${sellerId}/${listingId}/bp-${randomHex}.json`;
}
export const BLUEPRINT_PATH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,100}\.json$/;
