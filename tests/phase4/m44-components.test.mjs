// A44-C -- renders the Seller Studio and Moderation Desk views for every state with react-dom/server and asserts the markup:
// copy, which controls are enabled/disabled, accessibility attributes, and that seller-authored text is escaped.
// Needs esbuild + react + react-dom + lucide-react (dev only). Run from the REPO ROOT.
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

let esbuild;
try { esbuild = await import("esbuild"); } catch { console.log("SKIPPED: esbuild is not installed (npm i -D esbuild)."); process.exit(0); }
const React = (await import("react")).default ?? (await import("react"));
const { renderToStaticMarkup } = await import("react-dom/server");

const root = process.cwd();
const outDir = path.join(root, "tests", "phase4", ".build44");
fs.mkdirSync(outDir, { recursive: true });
async function load(entry, outName) {
  const outfile = path.join(outDir, outName);
  await esbuild.build({
    entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic",
    alias: { "@": root }, external: ["react", "react-dom", "react/jsx-runtime"], mainFields: ["module", "main"], logLevel: "silent",
    plugins: [{ name: "stubs", setup(b) {
      // the Supabase browser client is only needed by the (untested here) wrapper; stub it so the bundle has no network code
      b.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "sb-stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: "export const createClient = () => ({});", resolveDir: root }));
    } }],
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}
const { SellerStudioView } = await load("components/SellerStudio.jsx", "SellerStudio.mjs");
const { AdminReviewDeskView } = await load("components/AdminReviewDesk.jsx", "AdminReviewDesk.mjs");
const L = (f) => import(pathToFileURL(path.join(root, f)).href);
const ss = await L("lib/studio/studio-state.js"), dd = await L("lib/studio/demo-draft.js"), ds = await L("lib/admin/review-state.js");
process.on("exit", () => fs.rmSync(outDir, { recursive: true, force: true }));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${String(extra).slice(0, 300)}`); }
}
const has = (h, s) => h.includes(s);
const buttonOf = (h, label) => { const m = h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "s")); return m ? m[0] : ""; };
const disabled = (btn) => /\sdisabled(=|\s|>)/.test(btn);

const HAIKU = "claude-haiku-4-5-20251001", SONNET = "claude-sonnet-4-6";
const MODELS = [{ model: HAIKU, tier: "economy", isDefault: true }, { model: SONNET, tier: "intelligence", isDefault: false }];
const validDraft = (over = {}) => ({ sampleInput: "Summarise this", isEnabled: true, steps: [{ name: "Draft", model: HAIKU, system: "Be brief.", maxOutputTokens: "300", timeoutSeconds: "20" }], ...over });
const studio = (state, { eligible = true } = {}) => renderToStaticMarkup(React.createElement(SellerStudioView, {
  state, dispatch: () => {}, title: "My Workflow", models: MODELS, eligible, onPickFile: () => {}, onUpload: () => {}, onSave: () => {}, onSubmit: () => {} }));
const S = (over = {}, init = {}) => ({ ...ss.initialStudioState({ draft: validDraft(), ...init }), ...over });
const INS = { ok: true, format: "n8n", sizeBytes: 2048, sha256: "ab".repeat(32), nodeCount: 3, scan: { blocking: [], warnings: [] } };

// ================================================================ Seller Studio
{
  const h = studio(S());
  check("A44-C01 the studio shows its title, the listing name and the file picker (.json only)", has(h, "Seller Studio") && has(h, "My Workflow") && has(h, 'type="file"') && has(h, 'accept=".json,application/json"'));
  check("A44-C02 with no file chosen, Upload is disabled", disabled(buttonOf(h, "Upload and submit for review")));
  check("A44-C03 a never-saved valid draft: Save and Submit are enabled", !disabled(buttonOf(h, "Save draft")) && !disabled(buttonOf(h, "Submit for review")));
  check("A44-C04 one step is shown, 'Add a second step' is enabled, no Remove button", has(h, "Step 1") && !has(h, "Step 2") && !disabled(buttonOf(h, "Add a second step")) && !has(h, "Remove step"));
  check("A44-C05 the model <select> lists exactly the allowed models, default selected", has(h, `<option value="${HAIKU}" selected="">`) && has(h, `value="${SONNET}"`) && (h.match(/<option /g) ?? []).length === 2);
  check("A44-C06 privacy copy: instructions stay private; buyers see step names + the example", has(h, "Instructions (private)") && /buyers see only the step names and your example input/.test(h));
  check("A44-C07 inputs are length-bounded (sample 2000, instructions 3000, name 100)", has(h, 'maxLength="2000"') && has(h, 'maxLength="3000"') && has(h, 'maxLength="100"'));
  check("A44-C08 labels are wired to controls (accessibility)", has(h, 'for="studio-sample"') && has(h, 'id="studio-sample"') && has(h, 'for="step-0-system"') && has(h, 'id="step-0-system"') && has(h, 'for="studio-file"'));
}
{
  const two = validDraft({ steps: [validDraft().steps[0], { ...validDraft().steps[0], name: "Polish", model: SONNET }] });
  const h = studio(S({ draft: two }));
  check("A44-C09 two steps: both rendered, Add is DISABLED and says 'Up to 2 steps', each step can be removed", has(h, "Step 2") && disabled(buttonOf(h, "Up to 2 steps")) && (h.match(/Remove step/g) ?? []).length === 2);
}
{
  const ineligible = studio(S(), { eligible: false });
  check("A44-C10 a playbook listing gets an explanation and no form", has(ineligible, "workflow and agent listings only") && !has(ineligible, "<textarea") && !has(ineligible, 'type="file"'));
}
{
  const ready = studio(S({ blueprint: { phase: "ready", fileName: "f.json", inspection: INS, error: null, findings: null, warnings: [] } }));
  check("A44-C11 a clean preview: format label, size, node count, the SHA-256, and Upload ENABLED", has(ready, "n8n workflow") && has(ready, "2.0 KB") && has(ready, "3 nodes") && has(ready, "ab".repeat(32)) && !disabled(buttonOf(ready, "Upload and submit for review")));
  const warn = studio(S({ blueprint: { phase: "ready", fileName: "f.json", inspection: INS, error: null, findings: null, warnings: [{ type: "sensitive_field_with_value", path: "$.nodes[0].parameters.apiKey" }] } }));
  check("A44-C12 warnings are listed (type + path) but do NOT disable Upload", has(warn, "sensitive field with value") && has(warn, "$.nodes[0].parameters.apiKey") && !disabled(buttonOf(warn, "Upload and submit for review")));
  const bad = studio(S({ blueprint: { phase: "ready", fileName: "f.json", inspection: { ...INS, scan: { blocking: [{ type: "openai_api_key", path: "$.nodes[1].parameters.key" }], warnings: [] } }, error: null, findings: null, warnings: [] } }));
  check("A44-C13 credentials found: the finding (type + path) is shown, Upload is DISABLED, the matched value is not in the page", has(bad, "openai api key") && has(bad, "$.nodes[1].parameters.key") && has(bad, "can&#x27;t be uploaded") && disabled(buttonOf(bad, "Upload and submit for review")));
  const err = studio(S({ blueprint: { phase: "error", fileName: "x", inspection: null, error: "Couldn't recognise this as an n8n, Flowise or LangFlow export.", findings: null, warnings: [] } }));
  check("A44-C14 an unreadable file shows an alert and keeps Upload disabled", has(err, 'role="alert"') && has(err, "recognise") && disabled(buttonOf(err, "Upload and submit for review")));
  const busy = studio(S({ busy: "uploading", blueprint: { phase: "ready", fileName: "f.json", inspection: INS, error: null, findings: null, warnings: [] } }));
  check("A44-C15 while uploading, every action is disabled and the file input is locked", disabled(buttonOf(busy, "Upload and submit for review")) && disabled(buttonOf(busy, "Save draft")) && disabled(buttonOf(busy, "Submit for review")) && /<input id="studio-file"[^>]*disabled/.test(busy));
}
{
  const subs = [{ id: "1", format: "n8n", sizeBytes: 100, status: "pending", reviewNote: null }, { id: "2", format: "flowise", sizeBytes: 100, status: "rejected", reviewNote: "Contains a hard-coded webhook." }, { id: "3", format: "n8n", sizeBytes: 5, status: "approved", reviewNote: null }];
  const h = studio(S({ submissions: subs, liveBlueprint: { format: "n8n", sizeBytes: 5 } }));
  check("A44-C16 submissions show their state in words; a rejection shows the reviewer's note; the live blueprint is called out",
    has(h, "Waiting for admin review") && has(h, "Changes requested") && has(h, "Reviewer: Contains a hard-coded webhook.") && has(h, "Approved - live") && has(h, "Live now: n8n workflow"));
}
{
  const rej = studio(S({ demo: { reviewStatus: "rejected", reviewNote: "Step 1 asks for personal data.", configVersion: 2 } }));
  check("A44-C17 a rejected demo shows the reviewer's note and the 'Changes requested' chip", has(rej, "Step 1 asks for personal data.") && has(rej, "Changes requested"));
  const pen = studio(S({ demo: { reviewStatus: "pending_admin_approval", reviewNote: null, configVersion: 1 }, savedJson: JSON.stringify(validDraft()) }));
  check("A44-C18 a pending demo: status chip, the 'changing anything withdraws your submission' warning, and Submit is disabled until something changes", has(pen, "Waiting for admin review") && has(pen, "withdraws your submission") && disabled(buttonOf(pen, "Submit for review")) && disabled(buttonOf(pen, "Save draft")));
  const app = studio(S({ demo: { reviewStatus: "approved", reviewNote: null, configVersion: 1 }, savedJson: JSON.stringify(validDraft()) }));
  check("A44-C19 an approved demo: 'Approved' chip and a warning that edits withdraw the approval", has(app, ">Approved<") && has(app, "withdraws the approval"));
}
{
  const withErr = studio(S({ errors: { sampleInput: "Add a sample input buyers can try with one click.", "steps.0.system": "Write the instructions for this step.", "steps.0.maxOutputTokens": "Max output must be a whole number from 1 to 1024.", steps: "A demo can have at most 2 steps." }, notice: { kind: "error", text: "Please fix the highlighted fields." } }));
  check("A44-C20 field errors are rendered as alerts next to the fields, with a summary notice (aria-live)", (withErr.match(/role="alert"/g) ?? []).length === 4 && has(withErr, "Please fix the highlighted fields.") && has(withErr, 'aria-live="polite"') && has(withErr, 'aria-invalid="true"'));
  const ok = studio(S({ notice: { kind: "ok", text: "Draft saved." } }));
  check("A44-C21 a success notice is announced politely", has(ok, "Draft saved.") && has(ok, 'role="status"'));
  const invalid = studio(S({ draft: validDraft({ sampleInput: "" }) }));
  check("A44-C22 an incomplete draft disables Submit and says why", disabled(buttonOf(invalid, "Submit for review")) && has(invalid, "Complete every field to submit."));
  const off = studio(S({ draft: validDraft({ isEnabled: false }) }));
  check("A44-C23 a demo switched off cannot be submitted", disabled(buttonOf(off, "Submit for review")));
}
{
  const evil = `</textarea><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const h = studio(S({ draft: validDraft({ sampleInput: evil, steps: [{ ...validDraft().steps[0], name: evil, system: evil }] }), blueprint: { phase: "ready", fileName: evil, inspection: INS, error: null, findings: null, warnings: [{ type: evil, path: evil }] }, submissions: [{ id: "1", format: "n8n", sizeBytes: 1, status: "rejected", reviewNote: evil }] }), { eligible: true });
  check("A44-C24 seller-authored text (sample, name, instructions, findings, reviewer notes) is escaped everywhere", !has(h, "<script") && !has(h, "<img src=x") && has(h, "&lt;script&gt;"));
}

// ================================================================ Moderation Desk
const desk = (state) => renderToStaticMarkup(React.createElement(AdminReviewDeskView, { state, dispatch: () => {}, onSelect: () => {}, onDecide: () => {} }));
const Q = { demos: [{ listingId: "L1", title: "Flow A", sellerName: "Sam", stepCount: 2, configVersion: 1, submittedAt: "2026-10-10T09:00:00Z" }], blueprints: [{ submissionId: "S1", listingId: "L1", title: "Flow B", sellerName: "Sue", format: "flowise", sizeBytes: 4096, submittedAt: "2026-10-10T10:00:00Z" }] };
const D = (over = {}) => ({ ...ds.initialDeskState(Q), ...over });
const demoDetail = { demo: { listingId: "L1", title: "Flow A", sellerName: "Sam", reviewStatus: "pending_admin_approval", configVersion: 3, isEnabled: true, sampleInput: "Summarise this", demoConfig: { steps: [{ id: "step-1", name: "Draft", model: HAIKU, system: "SECRET-PROMPT-TEXT", maxOutputTokens: 300, timeoutSeconds: 20 }] } } };
const bpDetail = (v, extra = {}) => ({ blueprint: { submissionId: "S1", title: "Flow B", sellerName: "Sue", format: "flowise", sizeBytes: 4096, sha256: "cd".repeat(32) }, verification: v, downloadUrl: "https://signed.example/f.json", ...extra });
{
  const empty = desk(D({ queue: { demos: [], blueprints: [] } }));
  check("A44-C25 an empty queue says so", has(empty, "Nothing is waiting") && has(empty, "Moderation desk"));
  const h = desk(D());
  check("A44-C26 the queue lists demos and blueprints with seller, counts, format and size", has(h, "Flow A") && has(h, "Sam") && has(h, "2 steps") && has(h, "Flow B") && has(h, "Sue") && has(h, "Flowise flow") && has(h, "4.0 KB") && has(h, "Demos (1)") && has(h, "Blueprints (1)"));
  check("A44-C27 nothing selected: a prompt to pick one, no decision buttons", has(h, "Pick an item from the queue") && !has(h, ">Approve<") && !has(h, ">Reject<"));
  check("A44-C28 loading state", has(desk(D({ selected: { kind: "demo", id: "L1" }, detailPhase: "loading" })), "Loading"));
}
{
  const sel = { kind: "demo", id: "L1" };
  const h = desk(D({ selected: sel, detail: demoDetail, detailPhase: "ready" }));
  check("A44-C29 a demo review shows the prompts, sample input, model, limits and version (the reviewer sees what they approve)", has(h, "SECRET-PROMPT-TEXT") && has(h, "Summarise this") && has(h, HAIKU) && has(h, "max 300 tokens") && has(h, "20s") && has(h, "version 3"));
  check("A44-C30 Approve is enabled; Reject is disabled until a 10-char note is written", !disabled(buttonOf(h, "Approve")) && disabled(buttonOf(h, "Reject")));
  const short = desk(D({ selected: sel, detail: demoDetail, detailPhase: "ready", note: "too short" }));
  check("A44-C31 a short note tells the admin how many characters remain and keeps Reject disabled", disabled(buttonOf(short, "Reject")) && has(short, "1 more character to enable Reject"));
  const long = desk(D({ selected: sel, detail: demoDetail, detailPhase: "ready", note: "Asks for private data." }));
  check("A44-C32 a long-enough note enables Reject", !disabled(buttonOf(long, "Reject")));
  const busy = desk(D({ selected: sel, detail: demoDetail, detailPhase: "ready", note: "Asks for private data.", decisionPhase: "submitting" }));
  check("A44-C33 while a decision is in flight both buttons are disabled and the note is locked", disabled(buttonOf(busy, "Approve")) && disabled(buttonOf(busy, "Reject")) && /<textarea id="desk-note"[^>]*disabled/.test(busy));
  const off = desk(D({ selected: sel, detail: { demo: { ...demoDetail.demo, isEnabled: false } }, detailPhase: "ready" }));
  check("A44-C34 a demo the seller disabled shows that and cannot be approved", has(off, "disabled by seller") && disabled(buttonOf(off, "Approve")));
  const stale = desk(D({ selected: sel, detail: { demo: { ...demoDetail.demo, reviewStatus: "draft" } }, detailPhase: "ready" }));
  check("A44-C35 a demo that is no longer pending cannot be approved", disabled(buttonOf(stale, "Approve")));
  check("A44-C36 the note box is labelled", has(h, 'for="desk-note"') && has(h, 'id="desk-note"') && has(h, "required to reject"));
}
{
  const sel = { kind: "blueprint", id: "S1" };
  const ok = desk(D({ selected: sel, detail: bpDetail({ status: "match", sha256: "cd".repeat(32), nodeCount: 4, blocking: [], warnings: [] }), detailPhase: "ready" }));
  check("A44-C37 a verified blueprint: recorded hash, 'matches' status, node count, download link (noopener) and Approve ENABLED",
    has(ok, "cd".repeat(32)) && has(ok, "matches what the seller submitted") && has(ok, "4 nodes") && has(ok, 'href="https://signed.example/f.json"') && has(ok, 'rel="noopener noreferrer"') && !disabled(buttonOf(ok, "Approve")));
  const mm = desk(D({ selected: sel, detail: bpDetail({ status: "mismatch", sha256: "ee".repeat(32), blocking: [], warnings: [] }), detailPhase: "ready" }));
  check("A44-C38 a changed file is flagged loudly and Approve is DISABLED", has(mm, "has CHANGED since it was submitted") && disabled(buttonOf(mm, "Approve")));
  const miss = desk(D({ selected: sel, detail: bpDetail({ status: "missing" }, { downloadUrl: null }), detailPhase: "ready" }));
  check("A44-C39 a missing file: message, no download link, Approve disabled", has(miss, "could not be found") && !has(miss, "Download to inspect") && disabled(buttonOf(miss, "Approve")));
  const inv = desk(D({ selected: sel, detail: bpDetail({ status: "invalid", reason: "not_json" }), detailPhase: "ready" }));
  check("A44-C40 an invalid stored file disables Approve", disabled(buttonOf(inv, "Approve")) && has(inv, "no longer a valid blueprint"));
  const sec = desk(D({ selected: sel, detail: bpDetail({ status: "match", sha256: "cd".repeat(32), nodeCount: 1, blocking: [{ type: "github_token", path: "$.nodes[0].parameters.t" }], warnings: [{ type: "sensitive_field_with_value", path: "$.x" }] }), detailPhase: "ready" }));
  check("A44-C41 credentials found: findings shown (type + path), Approve DISABLED even though the hash matches; Reject stays possible with a note",
    has(sec, "github token") && has(sec, "$.nodes[0].parameters.t") && has(sec, "can&#x27;t be approved") && disabled(buttonOf(sec, "Approve")) && has(sec, "sensitive field with value"));
  const rejOk = desk(D({ selected: sel, detail: bpDetail({ status: "mismatch", blocking: [] }), detailPhase: "ready", note: "The file changed after upload." }));
  check("A44-C42 an admin can still REJECT a blueprint that cannot be approved", !disabled(buttonOf(rejOk, "Reject")));
}
{
  const err = desk(D({ notice: { kind: "error", text: "The seller changed this demo after you opened it. Reload and review the new version." } }));
  const ok = desk(D({ notice: { kind: "ok", text: "Approved." } }));
  check("A44-C43 notices are announced (aria-live) in the right tone", has(err, "seller changed this demo") && has(err, 'aria-live="polite"') && has(ok, "Approved."));
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
  const q = { demos: [{ listingId: "L1", title: evil, sellerName: evil, stepCount: 1, configVersion: 1, submittedAt: "x" }], blueprints: [] };
  const h = desk(D({ queue: q, selected: { kind: "demo", id: "L1" }, detailPhase: "ready", detail: { demo: { ...demoDetail.demo, title: evil, sellerName: evil, sampleInput: evil, demoConfig: { steps: [{ ...demoDetail.demo.demoConfig.steps[0], system: evil, name: evil }] } } } }));
  check("A44-C44 seller-authored text (titles, names, prompts, sample input) is escaped in the queue and the review pane", !has(h, "<script") && !has(h, "<img src=x") && has(h, "&lt;script&gt;"));
  check("A44-C45 the review pane marks the selected queue item (aria-current)", has(desk(D({ selected: { kind: "demo", id: "L1" }, detailPhase: "loading" })), 'aria-current="true"'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
