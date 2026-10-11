// A44 -- Milestone 4.4 logic tests (no DB, no browser): blueprint inspection + secret scan, demo-draft rules, the browser
// upload flow, the Seller Studio and Moderation Desk handlers (mocked client), and both UI reducers.
// Run from the REPO ROOT:  node tests/phase4/m44-logic.test.mjs
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";

const L = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);
const insp = await L("lib/blueprints/inspect.js");
const draft = await L("lib/studio/demo-draft.js");
const flow = await L("lib/studio/upload-flow.js");
const sh = await L("lib/studio/route-handlers.js");
const ah = await L("lib/admin/review-handlers.js");
const ss = await L("lib/studio/studio-state.js");
const ds = await L("lib/admin/review-state.js");
const dom = await L("lib/domain/studio.js");
const demos = await L("lib/domain/demos.js");
const adm = await L("lib/domain/admin-reviews.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${String(typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 300)}`); }
}
const enc = (o) => new TextEncoder().encode(typeof o === "string" ? o : JSON.stringify(o));
const N8N = { nodes: [{ type: "n8n-nodes-base.set", parameters: {} }], connections: {} };
const FLOWISE = { nodes: [{ id: "a", data: {} }, { id: "b", data: {} }], edges: [] };
const LANGFLOW = { name: "x", data: { nodes: [{ id: "1" }], edges: [] } };
const j = JSON.stringify;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
// secret-shaped fixtures are assembled at run time so this file never contains a literal credential
const FAKE = {
  anthropic: "sk-ant-" + "a1B2c3D4".repeat(5), openai: "sk-" + "Zy9X8w7V".repeat(5), aws: "AKIA" + "ABCDEFGH12345678", github: "ghp_" + "a1B2c3D4e5".repeat(4),
  google: "AIza" + "Sy" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q".slice(0, 33), slack: "xoxb-" + "1234567890-abcdefghij", stripe: "sk_live_" + "a1B2c3D4e5F6g7H8",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----", jwt: "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  hook: "https://hooks.slack.com/services/" + "T01ABCDEF/B01ABCDEF/abcdEFGHijklMNOP",
};

// ================================================================ A44-F: format detection
check("A44-F01 n8n / flowise / langflow are recognised", insp.detectFormat(N8N) === "n8n" && insp.detectFormat(FLOWISE) === "flowise" && insp.detectFormat(LANGFLOW) === "langflow");
check("A44-F02 ambiguous (n8n connections AND flowise edges) is refused rather than guessed", insp.detectFormat({ nodes: [], connections: {}, edges: [] }) === null);
check("A44-F03 other shapes -> null (arrays, strings, null, wrong types, empty object)",
  [[], "x", null, 3, {}, { nodes: {}, connections: {} }, { nodes: [], connections: [] }, { data: { nodes: [] } }, { data: [] }].every((d) => insp.detectFormat(d) === null));
check("A44-F04 node counts per format", insp.countNodes(N8N, "n8n") === 1 && insp.countNodes(FLOWISE, "flowise") === 2 && insp.countNodes(LANGFLOW, "langflow") === 1);

// ================================================================ A44-I: inspectBlueprintBytes
{
  const bytes = enc(N8N);
  const r = await insp.inspectBlueprintBytes(bytes);
  check("A44-I01 a valid n8n file: format, size, nodeCount, and a SHA-256 equal to node's own", r.ok && r.format === "n8n" && r.sizeBytes === bytes.length && r.nodeCount === 1 && r.sha256 === sha(bytes), r);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(N8N)]);
  const rb = await insp.inspectBlueprintBytes(bom);
  check("A44-I02 a UTF-8 BOM is tolerated and the hash covers the ORIGINAL bytes (what a buyer downloads)", rb.ok && rb.sha256 === sha(bom) && rb.sha256 !== r.sha256, rb);
  check("A44-I03 ArrayBuffer input works the same as Uint8Array", (await insp.inspectBlueprintBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).sha256 === r.sha256);
  const codes = async (b) => (await insp.inspectBlueprintBytes(b)).code;
  check("A44-I04 empty -> empty", (await codes(new Uint8Array(0))) === "empty");
  check("A44-I05 over 5 MiB -> too_large; exactly 5 MiB is allowed to proceed past the size check", (await codes(new Uint8Array(insp.MAX_BLUEPRINT_BYTES + 1))) === "too_large" && (await codes(new Uint8Array(insp.MAX_BLUEPRINT_BYTES))) !== "too_large");
  check("A44-I06 invalid UTF-8 -> not_utf8", (await codes(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))) === "not_utf8");
  check("A44-I07 not JSON -> not_json; JSON that is not an object -> not_object", (await codes(enc("{nope"))) === "not_json" && (await codes(enc("[1,2]"))) === "not_object" && (await codes(enc("42"))) === "not_object");
  check("A44-I08 an unrecognised object -> unknown_format (with the user-facing message)", (await codes(enc({ hello: 1 }))) === "unknown_format" && (await insp.inspectBlueprintBytes(enc({ a: 1 }))).message === insp.INSPECT_MESSAGES.unknown_format);
  const big = { nodes: Array.from({ length: 50 }, (_, i) => ({ type: "t", parameters: { n: i } })), connections: {} };
  check("A44-I09 a clean file has an empty scan", (await insp.inspectBlueprintBytes(enc(big))).scan.blocking.length === 0);
}

// ================================================================ A44-X: secret scan
{
  const scanOf = (parameters) => insp.scanForSecrets({ nodes: [{ type: "x", parameters }], connections: {} });
  for (const [label, value, type] of [["anthropic key", FAKE.anthropic, "anthropic_api_key"], ["openai key", FAKE.openai, "openai_api_key"], ["aws key", FAKE.aws, "aws_access_key"],
    ["github token", FAKE.github, "github_token"], ["google key", FAKE.google, "google_api_key"], ["slack token", FAKE.slack, "slack_token"], ["stripe key", FAKE.stripe, "stripe_live_key"],
    ["private key", FAKE.pem, "private_key"], ["jwt", FAKE.jwt, "jwt"], ["slack webhook", FAKE.hook, "slack_webhook"], ["url credentials", "postgres://admin:hunter2pw@db.example.com/x", "url_credentials"]]) {
    const s = scanOf({ note: `prefix ${value} suffix` });
    check(`A44-X01 blocks ${label}: type ${type} at its JSON path`, s.blocking.length === 1 && s.blocking[0].type === type && s.blocking[0].path === "$.nodes[0].parameters.note", s.blocking);
    check(`A44-X02 ...and the finding never contains the secret value (${label})`, !JSON.stringify(s).includes(value));
  }
  check("A44-X03 an anthropic key is classified once (not also as an openai key)", scanOf({ k: FAKE.anthropic }).blocking.length === 1);
  check("A44-X04 a credential used as an object KEY is caught without echoing it", (() => { const s = scanOf({ [FAKE.github]: 1 }); return s.blocking.length === 1 && !JSON.stringify(s).includes(FAKE.github); })());
  check("A44-X05 placeholders and templates are NOT flagged: {{ }}, $json, ${ }, <...>, YOUR_, redacted",
    ["{{ $json.apiKey }}", "${API_KEY}", "<your api key>", "YOUR_API_KEY_HERE", "redacted-value", "https://{{user}}:{{pass}}@host/x"].every((v) => { const s = scanOf({ apiKey: v }); return s.blocking.length === 0 && s.warnings.length === 0; }));
  const w = scanOf({ apiKey: "abcd1234efgh5678" });
  check("A44-X06 a sensitive-looking field with a real-looking value is a WARNING, not a block", w.blocking.length === 0 && w.warnings.length === 1 && w.warnings[0].type === "sensitive_field_with_value", w);
  check("A44-X07 n8n credential REFERENCES ({id,name}) are not secrets", scanOf({}).blocking.length === 0 && insp.scanForSecrets({ nodes: [{ credentials: { openAiApi: { id: "123", name: "My OpenAI" } } }], connections: {} }).warnings.length === 0);
  check("A44-X08 short values under sensitive keys are ignored (no noise)", scanOf({ token: "abc" }).warnings.length === 0);
  const deep = (n) => { let o = { v: FAKE.aws }; for (let i = 0; i < n; i++) o = { c: o }; return o; };
  let threw = false, r1;
  try { r1 = insp.scanForSecrets(deep(5000)); } catch { threw = true; }
  check("A44-X09 a 5000-deep document neither overflows the stack nor hangs (iterative walk, depth cap)", !threw && r1.blocking.length === 0);
  const many = insp.scanForSecrets({ items: Array.from({ length: 200 }, (_, i) => ({ k: "AKIA" + String(i).padStart(16, "A") })) });
  check("A44-X10 findings are capped (<= 50) so a hostile file cannot flood the UI", many.blocking.length === 50, many.blocking.length);
  const ins = await insp.inspectBlueprintBytes(enc({ ...N8N, nodes: [{ type: "x", parameters: { k: FAKE.openai } }] }));
  check("A44-X11 inspectBlueprintBytes surfaces blocking findings (the caller decides to refuse)", ins.ok && ins.scan.blocking.length === 1);
}

// ================================================================ A44-P: paths
{
  const S = "00000000-0000-0000-0000-0000000fff01", Lg = "11111111-2222-4333-8444-555555555555";
  const p = insp.buildBlueprintPath(S, Lg, "0123456789ab");
  check("A44-P01 buildBlueprintPath matches the DB path shape", p === `${S}/${Lg}/bp-0123456789ab.json` && insp.BLUEPRINT_PATH_RE.test(p));
  check("A44-P02 it refuses a non-hex / wrong-length token", ["xyz", "0123456789a", "0123456789AB", "../../../../x"].every((t) => { try { insp.buildBlueprintPath(S, Lg, t); return false; } catch { return true; } }));
  check("A44-P03 the path regex rejects traversal, wrong extension, extra segments", [`${S}/${Lg}/../x.json`, `${S}/${Lg}/a.txt`, `${S}/${Lg}/a/b.json`, `${S}/x/a.json`, `${S}/${Lg}/.json`].every((x) => !insp.BLUEPRINT_PATH_RE.test(x)));
}

// ================================================================ A44-D: demo draft rules
{
  const models = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"];
  const good = () => ({ sampleInput: "hello", isEnabled: true, steps: [{ name: "Draft", model: models[0], system: "Be brief.", maxOutputTokens: "300", timeoutSeconds: "20" }] });
  check("A44-D01 a complete draft validates", draft.validateDraft(good(), models).ok);
  const bad = (mut) => { const d = good(); mut(d); return draft.validateDraft(d, models); };
  check("A44-D02 blank / whitespace / over-long sample input", Object.keys(bad((d) => (d.sampleInput = "  \n")).errors).includes("sampleInput") && "sampleInput" in bad((d) => (d.sampleInput = "x".repeat(2001))).errors && bad((d) => (d.sampleInput = "x".repeat(2000))).ok);
  check("A44-D03 sample length counts code points, not UTF-16 units (2000 emoji is fine, 2001 is not)", bad((d) => (d.sampleInput = "😀".repeat(2000))).ok && !bad((d) => (d.sampleInput = "😀".repeat(2001))).ok);
  check("A44-D04 zero steps and three steps are rejected (cap is 2)", "steps" in bad((d) => (d.steps = [])).errors && "steps" in bad((d) => (d.steps = [good().steps[0], good().steps[0], good().steps[0]])).errors && bad((d) => (d.steps = [good().steps[0], good().steps[0]])).ok);
  check("A44-D05 model must be on the allowlist", "steps.0.model" in bad((d) => (d.steps[0].model = "gpt-5")).errors && "steps.0.model" in bad((d) => (d.steps[0].model = "")).errors);
  check("A44-D06 system prompt: blank and >3000 rejected, 3000 ok", "steps.0.system" in bad((d) => (d.steps[0].system = "   ")).errors && "steps.0.system" in bad((d) => (d.steps[0].system = "x".repeat(3001))).errors && bad((d) => (d.steps[0].system = "x".repeat(3000))).ok);
  const edge = (f, v) => bad((d) => (d.steps[0][f] = v)).errors[`steps.0.${f}`];
  check("A44-D07 maxOutputTokens: 1..1024 whole numbers only", !edge("maxOutputTokens", "1") && !edge("maxOutputTokens", "1024") && edge("maxOutputTokens", "0") && edge("maxOutputTokens", "1025") && edge("maxOutputTokens", "1.5") && edge("maxOutputTokens", "abc") && edge("maxOutputTokens", "") && edge("maxOutputTokens", "-3") && edge("maxOutputTokens", "1e3"));
  check("A44-D08 timeoutSeconds: 1..30 whole numbers only", !edge("timeoutSeconds", "1") && !edge("timeoutSeconds", "30") && edge("timeoutSeconds", "0") && edge("timeoutSeconds", "31") && edge("timeoutSeconds", "2.5"));
  check("A44-D09 step name > 100 chars rejected; blank name allowed", "steps.0.name" in bad((d) => (d.steps[0].name = "n".repeat(101))).errors && bad((d) => (d.steps[0].name = "")).ok);
  check("A44-D10 garbage input never throws", [null, undefined, 5, "x", { steps: "no" }, { steps: [null] }].every((d) => { try { return draft.validateDraft(d, models).ok === false; } catch { return false; } }));
  const cfg = draft.draftToConfig({ ...good(), steps: [{ ...good().steps[0], name: "  Draft  ", system: "  Be brief.  " }, { name: "", model: models[1], system: "Polish", maxOutputTokens: "1024", timeoutSeconds: "30" }] });
  check("A44-D11 draftToConfig: exact strict shape, trimmed, numbers coerced, ids step-1/2, blank name omitted",
    j(cfg) === j({ steps: [{ id: "step-1", name: "Draft", model: models[0], system: "Be brief.", maxOutputTokens: 300, timeoutSeconds: 20 }, { id: "step-2", model: models[1], system: "Polish", maxOutputTokens: 1024, timeoutSeconds: 30 }] }), cfg);
  const allowedKeys = ["id", "name", "model", "system", "maxOutputTokens", "timeoutSeconds", "retryLimit"];
  check("A44-D12 the config can never carry a key the DB would reject (no tools, no prompt aliases)", cfg.steps.every((s) => Object.keys(s).every((k) => allowedKeys.includes(k))) && Object.keys(cfg).join() === "steps");
  const rt = draft.configToDraft(cfg, "hi", true);
  check("A44-D13 configToDraft round-trips through draftToConfig", j(draft.draftToConfig(rt)) === j(cfg), rt);
  check("A44-D14 configToDraft survives junk (never throws, caps at 2 steps)", draft.configToDraft(null, null).steps.length === 0 && draft.configToDraft({ steps: [{}, {}, {}] }, 5).steps.length === 2);
  let d = draft.emptyDraft(models[0]);
  d = draft.draftReducer(d, { type: "addStep" }); d = draft.draftReducer(d, { type: "addStep" });
  check("A44-D15 reducer: addStep stops at 2 and inherits the model", d.steps.length === 2 && d.steps[1].model === models[0]);
  d = draft.draftReducer(d, { type: "removeStep", index: 0 }); d = draft.draftReducer(d, { type: "removeStep", index: 0 });
  check("A44-D16 reducer: removeStep never leaves zero steps", d.steps.length === 1);
  const u = draft.draftReducer(d, { type: "updateStep", index: 0, field: "system", value: "abc" });
  check("A44-D17 reducer: updateStep edits one field; an unknown field or index is ignored (no prototype / key injection)",
    u.steps[0].system === "abc" && draft.draftReducer(d, { type: "updateStep", index: 0, field: "tools", value: "x" }) === d && draft.draftReducer(d, { type: "updateStep", index: 5, field: "system", value: "x" }) === d && draft.draftReducer(d, { type: "updateStep", index: 0, field: "__proto__", value: "x" }) === d);
  check("A44-D18 reducer: setSample / setEnabled / unknown action", draft.draftReducer(d, { type: "setSample", value: "s" }).sampleInput === "s" && draft.draftReducer(d, { type: "setEnabled", value: false }).isEnabled === false && draft.draftReducer(d, { type: "nope" }) === d);
  check("A44-D19 review labels", draft.reviewLabel("pending_admin_approval") === "Waiting for admin review" && draft.reviewLabel("approved") === "Approved" && draft.reviewLabel("rejected") === "Changes requested" && draft.reviewLabel("zzz") === "Draft");
}

// ================================================================ A44-U: browser upload flow
{
  const S = "00000000-0000-0000-0000-0000000fff01", Lg = "11111111-2222-4333-8444-555555555555";
  const mkFile = (obj, name = "flow.json") => { const b = enc(obj); return { name, size: b.length, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const calls = [];
  const deps = (over = {}) => ({
    sellerId: S, listingId: Lg, randomHex: () => "0123456789ab",
    upload: async (p, f) => { calls.push(["upload", p]); return { error: null }; },
    register: async (p) => { calls.push(["register", p]); return { ok: true, status: 201, json: { submissionId: "sub1", sha256: over.sha ?? deps.lastSha, format: "n8n", sizeBytes: 1, nodeCount: 1, warnings: [] } }; },
    ...over,
  });
  check("A44-U01 checkSelectedFile: needs a .json file, not empty, <= 5 MB",
    flow.checkSelectedFile(null) && flow.checkSelectedFile({ name: "a.txt", size: 5 }) && flow.checkSelectedFile({ name: "a.json", size: 0 }) && flow.checkSelectedFile({ name: "a.json", size: 6 * 1024 * 1024 }) && flow.checkSelectedFile({ name: "A.JSON", size: 5 }) === null);
  const file = mkFile(N8N);
  const expectSha = sha(enc(N8N));
  calls.length = 0;
  let r = await flow.runBlueprintUpload({ file, ...deps({ sha: expectSha }) });
  check("A44-U02 happy path: inspect -> upload to <seller>/<listing>/bp-<hex>.json -> register that path -> ok", r.ok && calls[0][0] === "upload" && calls[0][1] === `${S}/${Lg}/bp-0123456789ab.json` && calls[1][0] === "register" && calls[1][1] === calls[0][1] && r.registered.submissionId === "sub1", [r, calls]);
  check("A44-U03 the browser sends the server ONLY a path to register (the hash is never sent)", calls.length === 2 && calls.every((c) => c.length === 2));
  calls.length = 0;
  r = await flow.runBlueprintUpload({ file: mkFile({ ...N8N, nodes: [{ type: "x", parameters: { k: FAKE.anthropic } }] }), ...deps() });
  check("A44-U04 a file with credentials is refused BEFORE anything is uploaded", !r.ok && r.stage === "secrets" && r.findings.length === 1 && calls.length === 0, r);
  r = await flow.runBlueprintUpload({ file: mkFile({ hello: 1 }), ...deps() });
  check("A44-U05 an unrecognised file stops at 'inspect'", !r.ok && r.stage === "inspect" && /recognise/.test(r.error));
  r = await flow.runBlueprintUpload({ file: { name: "x.pdf", size: 5, arrayBuffer: async () => new ArrayBuffer(5) }, ...deps() });
  check("A44-U06 a wrong extension stops at 'select'", !r.ok && r.stage === "select");
  calls.length = 0;
  r = await flow.runBlueprintUpload({ file, ...deps({ upload: async () => ({ error: { message: "boom" } }) }) });
  check("A44-U07 an upload error stops there (no register call) and shows a generic message, not the raw error", !r.ok && r.stage === "upload" && !/boom/.test(r.error));
  r = await flow.runBlueprintUpload({ file, ...deps({ register: async () => ({ ok: false, status: 422, json: { error: "File has credentials", findings: [{ type: "jwt", path: "$" }] } }) }) });
  check("A44-U08 a server refusal is surfaced (message + findings)", !r.ok && r.stage === "register" && r.error === "File has credentials" && r.findings.length === 1);
  r = await flow.runBlueprintUpload({ file, ...deps({ sha: "f".repeat(64) }) });
  check("A44-U09 if the server's recomputed hash differs from the local one, the upload is reported as FAILED ('verify')", !r.ok && r.stage === "verify");
  const hex = flow.randomHex12({ getRandomValues: (a) => a.fill(0xab) });
  check("A44-U10 randomHex12 makes 12 lowercase hex chars from 6 random bytes", hex === "abababababab");
}

// ================================================================ mock Supabase client
function mock({ rpc = {}, downloads = {}, removeLog = [], signed = "https://signed.example/x" } = {}) {
  const log = [];
  return {
    log,
    rpc: async (name, args) => { log.push([name, args]); const f = rpc[name]; return f ? f(args) : { data: null, error: { code: "XX", message: "no mock for " + name } }; },
    storage: { from: (bucket) => ({
      download: async (p) => { log.push(["download", bucket, p]); const d = downloads[p]; return d === undefined ? { data: null, error: { message: "nf" } } : { data: new Blob([d]), error: null }; },
      remove: async (ps) => { removeLog.push(...ps); return { data: [], error: null }; },
      createSignedUrl: async (p, ttl, o) => { log.push(["sign", p, ttl, o]); return { data: { signedUrl: signed }, error: null }; },
    }) },
  };
}
const UID = "00000000-0000-0000-0000-0000000fff01", LID = "11111111-2222-4333-8444-555555555555", SUB = "22222222-2222-4333-8444-555555555555";
const user = { id: UID };
const MODELS = { list_demo_models: async () => ({ data: [{ model: "claude-haiku-4-5-20251001", tier: "economy", isDefault: true }, { model: "claude-sonnet-4-6", tier: "intelligence", isDefault: false }], error: null }) };
const body = (o = {}) => ({ sampleInput: "hi", isEnabled: true, steps: [{ name: "A", model: "claude-haiku-4-5-20251001", system: "Be brief.", maxOutputTokens: "300", timeoutSeconds: "20" }], ...o });

// ================================================================ A44-H: seller handlers
{
  const sb = mock({ rpc: { ...MODELS, save_listing_demo: async () => ({ data: { configVersion: 1, reviewStatus: "draft", isEnabled: true }, error: null }) } });
  check("A44-H01 every studio handler: anonymous -> 401, bad listing id -> 400",
    (await sh.listModelsHandler({ supabase: sb, user: null })).status === 401 && (await sh.saveDemoHandler({ supabase: sb, user: null, listingId: LID, body: body() })).status === 401
    && (await sh.submitDemoHandler({ supabase: sb, user: null, listingId: LID })).status === 401 && (await sh.registerBlueprintHandler({ supabase: sb, user: null, listingId: LID, body: {} })).status === 401
    && (await sh.saveDemoHandler({ supabase: sb, user, listingId: "nope", body: body() })).status === 400 && (await sh.submitDemoHandler({ supabase: sb, user, listingId: "../x" })).status === 400
    && (await sh.registerBlueprintHandler({ supabase: sb, user, listingId: "x", body: {} })).status === 400);
  const ok = await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: body({ sampleInput: "  hi  " }) });
  const call = sb.log.find((c) => c[0] === "save_listing_demo");
  check("A44-H02 save: valid draft -> 200; the RPC gets the strict config, the trimmed sample and the flag", ok.status === 200 && ok.json.demo.configVersion === 1
    && call[1].p_listing_id === LID && call[1].p_sample_input === "hi" && call[1].p_is_enabled === true && j(Object.keys(call[1].p_demo_config)) === '["steps"]' && call[1].p_demo_config.steps[0].maxOutputTokens === 300, call);
  const before = sb.log.length;
  const inv = await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: body({ steps: [body().steps[0], body().steps[0], body().steps[0]] }) });
  check("A44-H03 save: 3 steps -> 400 with field errors and NO save call", inv.status === 400 && inv.json.errors.steps && !sb.log.slice(before).some((c) => c[0] === "save_listing_demo"));
  const inv2 = await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: body({ steps: [{ ...body().steps[0], model: "gpt-5" }] }) });
  check("A44-H04 save: a model outside the live allowlist -> 400", inv2.status === 400 && "steps.0.model" in inv2.json.errors);
  check("A44-H05 save: a non-object body -> 400", [null, [], "x", 5].every(async () => true) && (await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: [] })).status === 400 && (await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: null })).status === 400);
  const injected = await sh.saveDemoHandler({ supabase: sb, user, listingId: LID, body: body({ tools: ["x"], steps: [{ ...body().steps[0], tools: ["x"], approved_at: "now" }] }) });
  const c2 = sb.log.filter((c) => c[0] === "save_listing_demo").pop();
  check("A44-H06 save: unknown fields in the request are dropped, never forwarded (no tools, no approval fields)", injected.status === 200 && j(c2[1].p_demo_config).indexOf("tools") === -1 && j(c2[1]).indexOf("approved") === -1);
  const errs = { CM001: 400, CM002: 400, CM051: 404, CM052: 400, CM053: 400, CM054: 409, CM055: 409, CM058: 422, "28000": 401, "42501": 403, XX000: 500 };
  let allMapped = true;
  for (const [code, st] of Object.entries(errs)) {
    const e = mock({ rpc: { ...MODELS, save_listing_demo: async () => ({ data: null, error: { code, message: "RAW-DB-MESSAGE-" + code } }), submit_listing_demo_for_review: async () => ({ data: null, error: { code, message: "RAW-DB-MESSAGE-" + code } }) } });
    const a = await sh.saveDemoHandler({ supabase: e, user, listingId: LID, body: body() }), b = await sh.submitDemoHandler({ supabase: e, user, listingId: LID });
    if (a.status !== st || b.status !== st || j(a.json).includes("RAW-DB") || j(b.json).includes("RAW-DB")) allMapped = false;
  }
  check("A44-H07 every DB error code maps to the right status with friendly copy; raw DB messages never leak", allMapped);
  const sub = await sh.submitDemoHandler({ supabase: mock({ rpc: { submit_listing_demo_for_review: async (a) => ({ data: { configVersion: 2, reviewStatus: "pending_admin_approval" }, error: null }) } }), user, listingId: LID });
  check("A44-H08 submit: 200 with the pending status", sub.status === 200 && sub.json.demo.reviewStatus === "pending_admin_approval");
  const lm = await sh.listModelsHandler({ supabase: sb, user });
  check("A44-H09 listModels returns the models", lm.status === 200 && lm.json.models.length === 2);
}

// ================================================================ A44-R: blueprint registration handler
{
  const path_ = (name = "bp-0123456789ab.json", u = UID, l = LID) => `${u}/${l}/${name}`;
  const P = path_();
  const bytes = enc(N8N);
  const submitOk = async (a) => ({ data: SUB, error: null });
  const removed = [];
  const sb = (over = {}) => mock({ rpc: { submit_listing_blueprint: submitOk, ...(over.rpc ?? {}) }, downloads: over.downloads ?? { [P]: bytes }, removeLog: removed });
  const reg = (supabase, bodyv, extra = {}) => sh.registerBlueprintHandler({ supabase, user, listingId: LID, body: bodyv, ...extra });

  const s1 = sb();
  const r1 = await reg(s1, { path: P });
  const c1 = s1.log.find((c) => c[0] === "submit_listing_blueprint");
  check("A44-R01 happy path: 201, and the RPC receives hash/size/format RECOMPUTED by the server from the stored bytes", r1.status === 201 && r1.json.sha256 === sha(bytes) && c1[1].p_sha256 === sha(bytes) && c1[1].p_size_bytes === bytes.length && c1[1].p_format === "n8n" && c1[1].p_path === P, [r1, c1]);
  check("A44-R02 a client-supplied hash/format/size in the body is ignored", await (async () => {
    const s = sb(); await reg(s, { path: P, sha256: "f".repeat(64), format: "langflow", sizeBytes: 1 });
    const c = s.log.find((x) => x[0] === "submit_listing_blueprint")[1]; return c.p_sha256 === sha(bytes) && c.p_format === "n8n" && c.p_size_bytes === bytes.length;
  })());
  check("A44-R03 the scan summary sent to the DB holds counts/types only", j(c1[1].p_scan) === j({ blocking: 0, warnings: 0, nodeCount: 1, warningTypes: [] }), c1[1].p_scan);
  const bads = [null, {}, { path: 5 }, { path: "../../etc/passwd" }, { path: path_("bp.txt") }, { path: path_("bp.json", "00000000-0000-0000-0000-0000000fff99") }, { path: path_("bp.json", UID, "99999999-2222-4333-8444-555555555555") }, { path: P + "/x" }];
  let all400 = true; const s2 = sb();
  for (const b of bads) if ((await reg(s2, b)).status !== 400) all400 = false;
  check("A44-R04 paths outside the caller's own <user>/<listing>/ folder, traversal, wrong shape -> 400, nothing downloaded", all400 && !s2.log.some((c) => c[0] === "download"));
  check("A44-R05 the object is read with the CALLER's client from the private bucket", s1.log.find((c) => c[0] === "download")[1] === "listing-blueprints");
  const s3 = sb({ downloads: {} });
  check("A44-R06 an object that isn't in storage -> 404 and no RPC", (await reg(s3, { path: P })).status === 404 && !s3.log.some((c) => c[0] === "submit_listing_blueprint"));
  removed.length = 0;
  const s4 = sb({ downloads: { [P]: enc({ nope: 1 }) } });
  const r4 = await reg(s4, { path: P });
  check("A44-R07 an invalid file -> 422 with the reason, no RPC, and the stored object is discarded", r4.status === 422 && r4.json.code === "unknown_format" && !s4.log.some((c) => c[0] === "submit_listing_blueprint") && removed.includes(P), [r4, removed]);
  removed.length = 0;
  const s5 = sb({ downloads: { [P]: enc({ ...N8N, nodes: [{ type: "x", parameters: { key: FAKE.stripe } }] }) } });
  const r5 = await reg(s5, { path: P });
  check("A44-R08 a file with credentials -> 422 'secrets', findings (type+path only, no value), no RPC, object discarded",
    r5.status === 422 && r5.json.code === "secrets" && r5.json.findings.length === 1 && !j(r5).includes(FAKE.stripe) && !s5.log.some((c) => c[0] === "submit_listing_blueprint") && removed.includes(P), r5);
  const s6 = sb({ downloads: { [P]: new Uint8Array(insp.MAX_BLUEPRINT_BYTES + 1) } });
  check("A44-R09 an oversized object -> 422 too_large before it is parsed", (await reg(s6, { path: P })).json?.code === "too_large");
  const warn = enc({ ...N8N, nodes: [{ type: "x", parameters: { apiKey: "abcd1234efgh5678" } }] });
  const r7 = await reg(sb({ downloads: { [P]: warn } }), { path: P });
  check("A44-R10 heuristic WARNINGS don't block: 201 with the warnings listed", r7.status === 201 && r7.json.warnings.length === 1);
  removed.length = 0;
  const r8 = await reg(sb({ rpc: { submit_listing_blueprint: async () => ({ data: null, error: { code: "CM051", message: "listing_not_found" } }) } }), { path: P });
  check("A44-R11 a DB refusal (not your listing) -> 404 and the object is discarded", r8.status === 404 && removed.includes(P), r8);
  const r9 = await reg(sb({ rpc: { submit_listing_blueprint: async () => ({ data: null, error: { code: "CM058", message: "invalid_blueprint" } }) } }), { path: P });
  check("A44-R12 CM058 -> 422", r9.status === 422);
  check("A44-R13 the inspector is injectable and its verdict is what counts (a stubbed 'ok' inspector is used verbatim)", await (async () => {
    const s = sb(); const out = await reg(s, { path: P }, { inspect: async () => ({ ok: true, format: "flowise", sizeBytes: 9, sha256: "e".repeat(64), nodeCount: 3, scan: { blocking: [], warnings: [] } }) });
    const c = s.log.find((x) => x[0] === "submit_listing_blueprint")[1]; return out.status === 201 && c.p_format === "flowise" && c.p_sha256 === "e".repeat(64);
  })());
}

// ================================================================ A44-M: admin handlers
{
  const P = `${UID}/${LID}/bp-0123456789ab.json`;
  const bytes = enc(N8N), H = sha(bytes);
  const rec = (over = {}) => ({ submissionId: SUB, listingId: LID, title: "T", sellerName: "S", status: "pending", storagePath: P, format: "n8n", sha256: H, sizeBytes: bytes.length, scanSummary: {}, ...over });
  const mk = (o = {}) => mock({ downloads: o.downloads ?? { [P]: bytes }, rpc: {
    admin_get_blueprint_for_review: async () => ({ data: o.rec ?? rec(), error: null }),
    review_listing_blueprint: o.review ?? (async () => ({ data: { status: "approved" }, error: null })),
    review_listing_demo: o.reviewDemo ?? (async () => ({ data: { reviewStatus: "approved", configVersion: 2 }, error: null })),
    admin_review_queue: async () => ({ data: { demos: [{ listingId: LID }], blueprints: [] }, error: null }),
    admin_get_demo_for_review: async () => ({ data: { listingId: LID, configVersion: 2 }, error: null }),
  } });
  const noUser = [await ah.getQueueHandler({ supabase: mk(), user: null }), await ah.getDemoDetailHandler({ supabase: mk(), user: null, listingId: LID }), await ah.getBlueprintDetailHandler({ supabase: mk(), user: null, submissionId: SUB }),
    await ah.reviewDemoHandler({ supabase: mk(), user: null, listingId: LID, body: {} }), await ah.reviewBlueprintHandler({ supabase: mk(), user: null, submissionId: SUB, body: {} })];
  check("A44-M01 every admin handler: anonymous -> 401", noUser.every((r) => r.status === 401));
  check("A44-M02 bad ids -> 400, no RPC", await (async () => { const s = mk(); const a = await ah.getDemoDetailHandler({ supabase: s, user, listingId: "x" }); const b = await ah.reviewBlueprintHandler({ supabase: s, user, submissionId: "x", body: { decision: "approve" } }); return a.status === 400 && b.status === 400 && s.log.length === 0; })());
  const q = await ah.getQueueHandler({ supabase: mk(), user });
  check("A44-M03 queue handler returns the queue", q.status === 200 && q.json.queue.demos.length === 1 && q.json.queue.blueprints.length === 0);
  // ---- demo decisions
  const rd = (b, s = mk()) => ah.reviewDemoHandler({ supabase: s, user, listingId: LID, body: b });
  const badBodies = [null, [], {}, { decision: "maybe", expectedVersion: 1 }, { decision: "approve" }, { decision: "approve", expectedVersion: "1" }, { decision: "approve", expectedVersion: 0 }, { decision: "approve", expectedVersion: 1.5 },
    { decision: "reject", expectedVersion: 1 }, { decision: "reject", expectedVersion: 1, note: "short" }, { decision: "reject", expectedVersion: 1, note: "         pad    " }, { decision: "approve", expectedVersion: 1, note: 5 }, { decision: "approve", expectedVersion: 1, note: "x".repeat(1001) }];
  let all400 = true; const sx = mk();
  for (const b of badBodies) if ((await rd(b, sx)).status !== 400) all400 = false;
  check("A44-M04 demo decision validation: bad decision/version/notes -> 400 and the RPC is never called", all400 && sx.log.length === 0);
  const sd = mk();
  const okd = await rd({ decision: "approve", expectedVersion: 2, note: "  fine  " }, sd);
  check("A44-M05 approve passes the version the admin REVIEWED and a trimmed note to the RPC", okd.status === 200 && j(sd.log[0]) === j(["review_listing_demo", { p_listing_id: LID, p_decision: "approve", p_expected_version: 2, p_note: "fine" }]), sd.log[0]);
  const sr = mk(); await rd({ decision: "reject", expectedVersion: 2, note: "This prompt asks for personal data." }, sr);
  check("A44-M06 reject with a proper note is forwarded", sr.log[0][1].p_decision === "reject" && sr.log[0][1].p_note === "This prompt asks for personal data.");
  let mapped = true;
  for (const [code, st] of Object.entries({ "42501": 403, CM054: 409, CM055: 409, CM056: 409, CM057: 400, CM060: 403, CM061: 400, CM062: 404, CM001: 409, CM002: 409, "28000": 401, P0001: 500 })) {
    const r = await rd({ decision: "approve", expectedVersion: 1 }, mk({ reviewDemo: async () => ({ data: null, error: { code, message: "RAW-" + code } }) }));
    if (r.status !== st || j(r.json).includes("RAW-")) mapped = false;
  }
  check("A44-M07 admin error codes map to statuses (42501 -> 403 with MFA copy; stale CM056 -> 409) and raw messages never leak", mapped);
  check("A44-M08 the 42501 copy tells the admin MFA is required", /MFA/.test((await rd({ decision: "approve", expectedVersion: 1 }, mk({ reviewDemo: async () => ({ data: null, error: { code: "42501" } }) }))).json.error));
  // ---- blueprint decisions
  const rb = (b, s) => ah.reviewBlueprintHandler({ supabase: s, user, submissionId: SUB, body: b });
  const s1 = mk(); const a1 = await rb({ decision: "approve" }, s1);
  const rc = s1.log.find((c) => c[0] === "review_listing_blueprint")[1];
  check("A44-M09 APPROVE re-downloads the stored object, re-hashes it, and passes THAT hash (not anything from the browser)", a1.status === 200 && rc.p_verified_sha256 === H && s1.log.some((c) => c[0] === "download" && c[2] === P), [a1, rc]);
  check("A44-M10 a hash supplied in the request body is ignored", await (async () => { const s = mk(); await rb({ decision: "approve", verifiedSha256: "f".repeat(64), sha256: "f".repeat(64) }, s); return s.log.find((c) => c[0] === "review_listing_blueprint")[1].p_verified_sha256 === H; })());
  const changed = enc({ ...N8N, nodes: [{ type: "evil", parameters: {} }] });
  const s2 = mk({ downloads: { [P]: changed } }); const a2 = await rb({ decision: "approve" }, s2);
  check("A44-M11 a stored file that CHANGED since submission -> 409 hash_mismatch and the approve RPC is never called", a2.status === 409 && a2.json.code === "hash_mismatch" && !s2.log.some((c) => c[0] === "review_listing_blueprint"), a2);
  const s3 = mk({ downloads: {} }); const a3 = await rb({ decision: "approve" }, s3);
  check("A44-M12 a missing stored file -> 422 and no approve call", a3.status === 422 && !s3.log.some((c) => c[0] === "review_listing_blueprint"));
  const s4 = mk({ downloads: { [P]: enc("not json") } }); const a4 = await rb({ decision: "approve" }, s4);
  check("A44-M13 a stored file that is no longer valid -> 422 and no approve call", a4.status === 422 && !s4.log.some((c) => c[0] === "review_listing_blueprint"));
  const withKey = enc({ ...N8N, nodes: [{ type: "x", parameters: { k: FAKE.github } }] });
  const s5 = mk({ downloads: { [P]: withKey }, rec: rec({ sha256: sha(withKey) }) }); const a5 = await rb({ decision: "approve" }, s5);
  check("A44-M14 a file with credentials CANNOT be approved even if its hash matches (422, findings without values, no approve call)",
    a5.status === 422 && a5.json.code === "secrets" && !j(a5).includes(FAKE.github) && !s5.log.some((c) => c[0] === "review_listing_blueprint"), a5);
  const s6 = mk({ downloads: {} }); const a6 = await rb({ decision: "reject", note: "Contains a hard-coded webhook." }, s6);
  check("A44-M15 REJECT needs no download (works even when the file is gone) and passes a null verified hash", a6.status === 200 && s6.log.length === 1 && s6.log[0][1].p_verified_sha256 === null && s6.log[0][1].p_decision === "reject");
  check("A44-M16 reject without a note -> 400, no RPC", await (async () => { const s = mk(); const r = await rb({ decision: "reject" }, s); return r.status === 400 && s.log.length === 0; })());
  const a7 = await rb({ decision: "approve" }, mk({ review: async () => ({ data: null, error: { code: "CM059", message: "RAW" } }) }));
  check("A44-M17 the DB's own hash check (CM059) is also mapped (409)", a7.status === 409 && !j(a7).includes("RAW"));
  const a8 = await rb({ decision: "approve" }, mk({ review: async () => ({ data: null, error: { code: "42501" } }) }));
  check("A44-M18 a non-admin / aal1 session reaches the RPC and is refused (403)", a8.status === 403);
  // ---- detail
  const det = await ah.getBlueprintDetailHandler({ supabase: mk(), user, submissionId: SUB });
  check("A44-M19 blueprint detail: live verification 'match', a 60-second signed download link, and NO storage path in the response",
    det.status === 200 && det.json.verification.status === "match" && det.json.verification.sha256 === H && det.json.downloadUrl === "https://signed.example/x" && !j(det.json).includes(P) && !("storagePath" in det.json.blueprint), det);
  const dm = await ah.getBlueprintDetailHandler({ supabase: mk({ downloads: { [P]: changed } }), user, submissionId: SUB });
  check("A44-M20 blueprint detail flags a changed file as 'mismatch'", dm.json.verification.status === "mismatch");
  const dg = await ah.getBlueprintDetailHandler({ supabase: mk({ downloads: {} }), user, submissionId: SUB });
  check("A44-M21 ...and a missing one as 'missing' (the page still loads)", dg.status === 200 && dg.json.verification.status === "missing");
  const dd = await ah.getDemoDetailHandler({ supabase: mk(), user, listingId: LID });
  check("A44-M22 demo detail passes through the RPC answer", dd.status === 200 && dd.json.demo.configVersion === 2);
}

// ================================================================ A44-S: studio reducer
{
  const base = () => ss.initialStudioState({ draft: draft.emptyDraft("claude-haiku-4-5-20251001") });
  const models = ["claude-haiku-4-5-20251001"];
  let s = base();
  check("A44-S01 a fresh studio: never saved -> dirty; a pristine empty draft cannot be submitted", ss.isDirty(s) && !ss.canSubmitDemo(s, models) && !ss.canUploadBlueprint(s));
  s = ss.studioReducer(s, { type: "DRAFT", action: { type: "setSample", value: "hi" } });
  s = ss.studioReducer(s, { type: "DRAFT", action: { type: "updateStep", index: 0, field: "system", value: "Be brief." } });
  check("A44-S02 once the draft is valid it can be submitted (save-then-submit)", ss.canSubmitDemo(s, models));
  s = ss.studioReducer(s, { type: "SAVE_START" });
  check("A44-S03 while busy nothing else can start", ss.isBusy(s) && !ss.canSubmitDemo(s, models));
  s = ss.studioReducer(s, { type: "SAVE_OK", demo: { configVersion: 1, reviewStatus: "draft", isEnabled: true } });
  check("A44-S04 SAVE_OK clears dirty and shows a notice", !ss.isDirty(s) && s.notice.kind === "ok" && s.demo.configVersion === 1);
  check("A44-S05 a saved draft is submittable; after submit it is not (pending)", ss.canSubmitDemo(s, models));
  s = ss.studioReducer(s, { type: "SUBMIT_OK", demo: { configVersion: 1, reviewStatus: "pending_admin_approval" } });
  check("A44-S06 pending: cannot resubmit, and editing warns that it withdraws the submission", !ss.canSubmitDemo(s, models) && ss.editingWithdraws(s));
  s = ss.studioReducer(s, { type: "DRAFT", action: { type: "setSample", value: "changed" } });
  check("A44-S07 editing a pending/approved demo makes it dirty -> submittable again (the save withdraws the old state)", ss.isDirty(s) && ss.canSubmitDemo(s, models));
  s = ss.studioReducer(s, { type: "DRAFT", action: { type: "setEnabled", value: false } });
  check("A44-S08 a disabled demo cannot be submitted", !ss.canSubmitDemo(s, models));
  s = ss.studioReducer(s, { type: "ERRORS", errors: { sampleInput: "x" } });
  check("A44-S09 ERRORS stores field errors + an error notice; the next edit clears them", s.errors.sampleInput === "x" && s.notice.kind === "error" && Object.keys(ss.studioReducer(s, { type: "DRAFT", action: { type: "setSample", value: "a" } }).errors).length === 0);
  s = ss.studioReducer(s, { type: "SAVE_FAIL", error: "nope", errors: { steps: "bad" } });
  check("A44-S10 SAVE_FAIL keeps the draft, unbusies, shows the server's error", !ss.isBusy(s) && s.notice.text === "nope" && s.errors.steps === "bad");
  // blueprint
  let b = base();
  const okIns = { ok: true, format: "n8n", sizeBytes: 5, sha256: "a".repeat(64), nodeCount: 1, scan: { blocking: [], warnings: [{ type: "sensitive_field_with_value", path: "$.x" }] } };
  b = ss.studioReducer(b, { type: "FILE_PREVIEW_OK", fileName: "f.json", inspection: okIns });
  check("A44-S11 a clean preview enables upload and keeps the warnings", ss.canUploadBlueprint(b) && b.blueprint.warnings.length === 1);
  const withBlock = ss.studioReducer(base(), { type: "FILE_PREVIEW_OK", fileName: "f.json", inspection: { ...okIns, scan: { blocking: [{ type: "jwt", path: "$" }], warnings: [] } } });
  check("A44-S12 a preview with credentials NEVER enables upload", !ss.canUploadBlueprint(withBlock));
  check("A44-S13 a failed preview shows the error and disables upload", (() => { const x = ss.studioReducer(base(), { type: "FILE_PREVIEW_FAIL", fileName: "x", error: "bad" }); return x.blueprint.phase === "error" && !ss.canUploadBlueprint(x); })());
  b = ss.studioReducer(b, { type: "UPLOAD_START" });
  check("A44-S14 uploading blocks a second upload", !ss.canUploadBlueprint(b));
  b = ss.studioReducer({ ...b, submissions: [{ id: "old", status: "pending", format: "n8n", sizeBytes: 1 }] }, { type: "UPLOAD_OK", registered: { submissionId: "new", format: "n8n", sizeBytes: 5, warnings: [] }, at: "t" });
  check("A44-S15 UPLOAD_OK adds a pending submission and marks the previous pending one superseded", b.submissions[0].id === "new" && b.submissions[0].status === "pending" && b.submissions[1].status === "superseded" && b.blueprint.phase === "done" && ss.hasPendingBlueprint(b));
  b = ss.studioReducer(b, { type: "UPLOAD_FAIL", error: "x", findings: [{ type: "jwt", path: "$" }] });
  check("A44-S16 UPLOAD_FAIL shows the error + findings", b.blueprint.phase === "error" && b.blueprint.findings.length === 1);
  check("A44-S17 unknown actions are ignored", ss.studioReducer(b, { type: "??" }) === b);
}

// ================================================================ A44-K: desk reducer
{
  const Q = { demos: [{ listingId: "L1" }, { listingId: "L2" }], blueprints: [{ submissionId: "S1" }] };
  let s = ds.initialDeskState(Q);
  s = ds.deskReducer(s, { type: "SELECT", kind: "demo", id: "L1" });
  check("A44-K01 selecting loads (phase 'loading'); approve/reject disabled until the detail arrives", s.detailPhase === "loading" && !ds.canApprove(s) && !ds.canReject(s));
  s = ds.deskReducer(s, { type: "DETAIL_OK", id: "L2", detail: { demo: {} } });
  check("A44-K02 a late response for a PREVIOUS selection is ignored", s.detailPhase === "loading" && s.detail === null);
  s = ds.deskReducer(s, { type: "DETAIL_OK", id: "L1", detail: { demo: { configVersion: 3, isEnabled: true, reviewStatus: "pending_admin_approval" } } });
  check("A44-K03 a pending, enabled demo can be approved; reject still needs a 10-char note", ds.canApprove(s) && !ds.canReject(s));
  s = ds.deskReducer(s, { type: "NOTE", value: "too short" });
  check("A44-K04 9 characters is not enough", !ds.canReject(s));
  s = ds.deskReducer(s, { type: "NOTE", value: "  long enough note  " });
  check("A44-K05 the note is measured trimmed; >= 10 enables Reject", ds.canReject(s) && ds.noteLength(s) === 16);
  check("A44-K06 a demo that is not pending / is disabled cannot be approved", !ds.canApprove({ ...s, detail: { demo: { configVersion: 3, isEnabled: false, reviewStatus: "pending_admin_approval" } } }) && !ds.canApprove({ ...s, detail: { demo: { configVersion: 3, isEnabled: true, reviewStatus: "draft" } } }));
  const sd = ds.deskReducer(s, { type: "DECIDE_START" });
  check("A44-K07 while a decision is in flight both buttons are disabled (no double submit)", !ds.canApprove(sd) && !ds.canReject(sd));
  const done = ds.deskReducer(sd, { type: "DECIDE_OK", decision: "approve" });
  check("A44-K08 a decision removes the item from the queue and clears the selection", done.queue.demos.length === 1 && done.queue.demos[0].listingId === "L2" && done.selected === null && done.notice.kind === "ok" && done.queue.blueprints.length === 1);
  const fail = ds.deskReducer(sd, { type: "DECIDE_FAIL", status: 409, error: "stale" });
  check("A44-K09 a failed decision keeps the item, shows the error, and flags 409 as stale", fail.queue.demos.length === 2 && fail.notice.text === "stale" && fail.stale === true && fail.decisionPhase === "idle");
  let bs = ds.deskReducer(ds.initialDeskState(Q), { type: "SELECT", kind: "blueprint", id: "S1" });
  const det = (v) => ({ blueprint: {}, verification: v });
  const approvable = (v) => ds.canApprove(ds.deskReducer(bs, { type: "DETAIL_OK", id: "S1", detail: det(v) }));
  check("A44-K10 a blueprint is approvable ONLY when the live check says 'match' with no credentials", approvable({ status: "match", blocking: [] }) && !approvable({ status: "mismatch", blocking: [] }) && !approvable({ status: "missing" }) && !approvable({ status: "invalid" }) && !approvable({ status: "match", blocking: [{ type: "jwt", path: "$" }] }) && !approvable(undefined));
  const rb = ds.deskReducer(ds.deskReducer(bs, { type: "DETAIL_OK", id: "S1", detail: det({ status: "match", blocking: [] }) }), { type: "DECIDE_OK", decision: "reject" });
  check("A44-K11 deciding a blueprint removes it from the blueprint queue only", rb.queue.blueprints.length === 0 && rb.queue.demos.length === 2 && /Rejected/.test(rb.notice.text));
  check("A44-K12 NOTE is capped at 1000 chars; CLOSE resets the panel", ds.deskReducer(s, { type: "NOTE", value: "x".repeat(2000) }).note.length === 1000 && ds.deskReducer(s, { type: "CLOSE" }).selected === null);
}

// ================================================================ A44-N: domain normalisers
{
  const st = dom.toStudioState({
    listing: { id: LID, title: "T", status: "live", product_type: "workflow", blueprint_format: "n8n", blueprint_size_bytes: 10 },
    demo: { demo_config: { steps: [{ id: "step-1", name: "A", model: "m", system: "s", maxOutputTokens: 300, timeoutSeconds: 20 }] }, sample_input: "hi", is_enabled: true, review_status: "rejected", review_note: "fix", config_version: 4, submitted_at: "t" },
    submissions: [{ id: "x", format: "n8n", size_bytes: 5, status: "approved", review_note: null, submitted_at: "t" }], models: [{ model: "a", tier: "economy", isDefault: false }, { model: "b", tier: "intelligence", isDefault: true }] });
  check("A44-N01 toStudioState: eligible, default model, draft rebuilt from the saved config, live blueprint, submissions camelCased",
    st.eligible && st.defaultModel === "b" && st.demo.reviewStatus === "rejected" && st.demo.reviewNote === "fix" && st.demo.configVersion === 4 && st.demo.draft.steps[0].maxOutputTokens === "300" && st.demo.draft.sampleInput === "hi"
    && st.liveBlueprint.format === "n8n" && st.submissions[0].sizeBytes === 5, st);
  check("A44-N02 toStudioState: no listing -> null; playbook -> not eligible; junk models/submissions are tolerated", dom.toStudioState({ listing: null }) === null && dom.toStudioState({ listing: { id: LID, product_type: "playbook" }, models: "x", submissions: 5 }).eligible === false);
  const listingRow = { id: LID, title: "T", status: "live", product_type: "workflow", seller_id: UID };
  const q = (table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "listings" ? listingRow : null }), order: () => ({ limit: async () => ({ data: [] }) }) }) }) });
  const sbq = { from: q, rpc: async () => ({ data: [] }) };
  check("A44-N03 getStudioState: another user's listing looks exactly like a missing one (null)", (await dom.getStudioState(sbq, LID, "someone-else")) === null && (await dom.getStudioState(sbq, LID, UID)) !== null);
  check("A44-N04 getStudioState never throws", (await dom.getStudioState({ from: () => { throw new Error("x"); } }, LID, UID)) === null);
  const good = { available: true, stepNames: ["A"], maxInputChars: 2000, runsPerDay: 3, remainingToday: 3, budgetExhausted: false };
  check("A44-N05 toDemoInfo carries a valid sampleInput and omits it when blank/absent/too long/non-string",
    demos.toDemoInfo({ ...good, sampleInput: "try me" }).sampleInput === "try me" && !("sampleInput" in demos.toDemoInfo({ ...good, sampleInput: "  " })) && !("sampleInput" in demos.toDemoInfo(good))
    && !("sampleInput" in demos.toDemoInfo({ ...good, sampleInput: "x".repeat(2001) })) && !("sampleInput" in demos.toDemoInfo({ ...good, sampleInput: 5 })));
  const gate = (profile, level) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }), auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: level, nextLevel: "aal2" } }) } } });
  check("A44-N06 admin gate: allowed only for is_admin AND aal2", (await adm.getAdminGate(gate({ is_admin: true }, "aal2"), user)).allowed === true && (await adm.getAdminGate(gate({ is_admin: true }, "aal1"), user)).allowed === false
    && (await adm.getAdminGate(gate({ is_admin: false }, "aal2"), user)).allowed === false && (await adm.getAdminGate(gate(null, "aal2"), user)).allowed === false && (await adm.getAdminGate(gate({ is_admin: true }, "aal2"), null)).allowed === false);
  check("A44-N07 the admin gate fails closed on an error", (await adm.getAdminGate({ from: () => { throw new Error("x"); } }, user)).allowed === false);
  check("A44-N08 getReviewQueue fails to an empty queue", j(await adm.getReviewQueue({ rpc: async () => ({ data: null, error: { code: "42501" } }) })) === j({ demos: [], blueprints: [] }) && j(await adm.getReviewQueue({ rpc: async () => { throw new Error("x"); } })) === j({ demos: [], blueprints: [] }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
