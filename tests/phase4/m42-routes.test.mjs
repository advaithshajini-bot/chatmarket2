// A42-R -- unit tests for the framework-free handlers added in Milestone 4.2 (mocked Supabase client).
// Run:  node tests/phase4/m42-routes.test.mjs     (no database needed)
import { startDemoRunHandler, DEMO_ERROR_STATUS } from "../../lib/demo/route-handlers.js";
import { getBlueprintDownloadHandler, MAX_TTL_SECONDS } from "../../lib/blueprints/download.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const LID = "11111111-1111-4111-8111-111111111111";
const user = { id: "u1" };

// ---------------------------------------------------------------- demo start
function rpcClient(result) { const calls = []; return { calls, rpc: async (fn, args) => { calls.push({ fn, args }); return result; } }; }
{
  const c = rpcClient({ data: "run-1", error: null });
  const r = await startDemoRunHandler({ supabase: c, user, body: { listingId: LID, text: "hello" } });
  check("A42-R01 success: 201 { runId }, exact RPC name and args", r.status === 201 && r.json.runId === "run-1"
    && c.calls.length === 1 && c.calls[0].fn === "start_demo_run" && JSON.stringify(c.calls[0].args) === JSON.stringify({ p_listing_id: LID, p_input: { text: "hello" } }), c.calls);
}
{
  const c = rpcClient({ data: null, error: null });
  const r = await startDemoRunHandler({ supabase: c, user: null, body: { listingId: LID, text: "x" } });
  check("A42-R02 not logged in: 401 and NO rpc call", r.status === 401 && c.calls.length === 0);
}
for (const [label, body] of [["no body", undefined], ["no listingId", { text: "x" }], ["listingId a number", { listingId: 5, text: "x" }],
  ["no text", { listingId: LID }], ["text a number", { listingId: LID, text: 5 }], ["blank text", { listingId: LID, text: "  \n " }],
  ["2001 chars", { listingId: LID, text: "a".repeat(2001) }]]) {
  const c = rpcClient({ data: "x", error: null });
  const r = await startDemoRunHandler({ supabase: c, user, body });
  check(`A42-R03 bad body (${label}): 400 and NO rpc call`, r.status === 400 && c.calls.length === 0, r);
}
{
  const c = rpcClient({ data: "ok", error: null });
  const a = await startDemoRunHandler({ supabase: c, user, body: { listingId: LID, text: "a".repeat(2000) } });
  const b = await startDemoRunHandler({ supabase: c, user, body: { listingId: LID, text: "अ".repeat(2000) } });
  check("A42-R04 exactly 2000 characters is accepted, counted in characters not bytes (matches the DB)", a.status === 201 && b.status === 201);
}
{
  const want = { "28000": 401, CM010: 503, CM011: 404, CM012: 400, CM014: 403, CM030: 503, CM031: 404, CM032: 400, CM033: 429, CM034: 503, CM036: 503 };
  check("A42-R05 the status table covers every demo error code", JSON.stringify(DEMO_ERROR_STATUS) === JSON.stringify(want), DEMO_ERROR_STATUS);
  for (const [code, status] of Object.entries(want)) {
    const r = await startDemoRunHandler({ supabase: rpcClient({ data: null, error: { code, message: `m-${code}` } }), user, body: { listingId: LID, text: "x" } });
    check(`A42-R06 ${code} -> ${status} with the DB's safe message`, r.status === status && r.json.error === `m-${code}`, r);
  }
  const r = await startDemoRunHandler({ supabase: rpcClient({ data: null, error: { code: "XX000", message: "internal detail: relation foo" } }), user, body: { listingId: LID, text: "x" } });
  check("A42-R07 an unknown error becomes a generic 500 and does NOT echo internal details", r.status === 500 && !r.json.error.includes("relation foo"), r);
}

// ---------------------------------------------------------------- blueprint download
function bpClient({ listing = { blueprint_path: `s/${LID}/bp.json`, blueprint_format: "n8n", blueprint_sha256: "a".repeat(64), blueprint_size_bytes: 1234 }, lookupErr = null, signed = { signedUrl: "https://signed.example/x" }, signErr = null } = {}) {
  const log = { from: [], select: [], eq: [], storageFrom: [], sign: [] };
  return {
    log,
    from(t) { log.from.push(t); return { select(cols) { log.select.push(cols); return { eq(c, v) { log.eq.push([c, v]); return { maybeSingle: async () => ({ data: lookupErr ? null : listing, error: lookupErr }) }; } }; } }; },
    storage: { from(b) { log.storageFrom.push(b); return { createSignedUrl: async (p, ttl, opts) => { log.sign.push({ p, ttl, opts }); return { data: signErr ? null : signed, error: signErr }; } }; } },
  };
}
{
  const c = bpClient();
  const r = await getBlueprintDownloadHandler({ supabase: c, user, listingId: LID });
  check("A42-R10 success: 200 with url, filename, format, sha256, size, ttl 60",
    r.status === 200 && r.json.url === "https://signed.example/x" && r.json.filename === "bp.json" && r.json.format === "n8n"
      && r.json.sha256 === "a".repeat(64) && r.json.sizeBytes === 1234 && r.json.expiresInSeconds === 60, r);
  check("A42-R11 uses ONLY the caller's client: private bucket 'listing-blueprints', 60 s, forced download filename; reads only blueprint columns",
    c.log.storageFrom[0] === "listing-blueprints" && c.log.sign[0].p === `s/${LID}/bp.json` && c.log.sign[0].ttl === 60 && c.log.sign[0].opts.download === "bp.json"
      && c.log.select[0] === "blueprint_path, blueprint_format, blueprint_sha256, blueprint_size_bytes" && c.log.eq[0][1] === LID, c.log);
}
{
  const c = bpClient();
  const r = await getBlueprintDownloadHandler({ supabase: c, user: null, listingId: LID });
  check("A42-R12 not logged in: 401 and no database/storage access at all", r.status === 401 && c.log.from.length === 0 && c.log.storageFrom.length === 0);
}
for (const bad of [undefined, null, 5, "", "not-a-uuid", `${LID}/../x`, "11111111-1111-4111-8111-11111111111g"]) {
  const c = bpClient();
  const r = await getBlueprintDownloadHandler({ supabase: c, user, listingId: bad });
  check(`A42-R13 invalid listing id ${JSON.stringify(bad)}: 400, no access`, r.status === 400 && c.log.from.length === 0);
}
{
  const c = bpClient({ listing: null });
  const r = await getBlueprintDownloadHandler({ supabase: c, user, listingId: LID });
  check("A42-R14 listing not visible/not found: 404, storage never called", r.status === 404 && c.log.storageFrom.length === 0, r);
  const c2 = bpClient({ listing: { blueprint_path: null, blueprint_format: null, blueprint_sha256: null, blueprint_size_bytes: null } });
  const r2 = await getBlueprintDownloadHandler({ supabase: c2, user, listingId: LID });
  check("A42-R15 a listing without a blueprint: 404, storage never called", r2.status === 404 && c2.log.storageFrom.length === 0, r2);
  const c3 = bpClient({ lookupErr: { message: "db boom with internals" } });
  const r3 = await getBlueprintDownloadHandler({ supabase: c3, user, listingId: LID });
  check("A42-R16 lookup failure: generic 500, no internals echoed", r3.status === 500 && !JSON.stringify(r3.json).includes("internals"), r3);
}
{
  for (const [label, o] of [["storage error (RLS denied -> 'Object not found')", { signErr: { message: "Object not found" } }], ["no signedUrl returned", { signed: {} }], ["null data", { signed: null }]]) {
    const r = await getBlueprintDownloadHandler({ supabase: bpClient(o), user, listingId: LID });
    check(`A42-R17 ${label}: 403 'purchase the listing', no URL leaked`, r.status === 403 && r.json.url === undefined, r);
  }
}
{
  const ttl = async (t) => { const c = bpClient(); await getBlueprintDownloadHandler({ supabase: c, user, listingId: LID, ttlSeconds: t }); return c.log.sign[0].ttl; };
  check("A42-R18 TTL is clamped to 1..120 s (never an hour-long URL); garbage falls back to 60",
    (await ttl(3600)) === MAX_TTL_SECONDS && (await ttl(0)) === 60 && (await ttl(-5)) === 1 && (await ttl("abc")) === 60 && (await ttl(30)) === 30);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
