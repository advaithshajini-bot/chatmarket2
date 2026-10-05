// A43-C -- renders the Try Demo view and the blueprint card for EVERY state with react-dom/server and asserts the
// markup: copy, disabled/enabled controls, accessibility attributes, and that untrusted model output is escaped.
//
// Needs esbuild to transpile the .jsx files (dev-only):   npm i -D esbuild
// Run from the REPO ROOT:  node tests/phase4/m43-components.test.mjs
// (Without esbuild this prints SKIPPED and exits 0; run-all treats SKIPPED as not passed unless --allow-skip.)

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

let esbuild;
try { esbuild = await import("esbuild"); } catch { console.log("SKIPPED: esbuild is not installed (npm i -D esbuild)."); process.exit(0); }
const React = (await import("react")).default ?? (await import("react"));
const { renderToStaticMarkup } = await import("react-dom/server");

const root = process.cwd();
const outDir = path.join(root, "tests", "phase4", ".build");
fs.mkdirSync(outDir, { recursive: true });
async function load(entry, outName) {
  const outfile = path.join(outDir, outName);
  await esbuild.build({
    entryPoints: [path.join(root, entry)], outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic",
    alias: { "@": root }, external: ["react", "react-dom", "react/jsx-runtime"], mainFields: ["module", "main"], logLevel: "silent",
    // next/link is stubbed to a plain <a>: we only assert markup, and Link needs the Next runtime to render.
    plugins: [{
      name: "stub-next-link",
      setup(b) {
        b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link-stub", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: 'import React from "react"; export default function Link({ href, children, ...rest }) { return React.createElement("a", { href, ...rest }, children); }',
          resolveDir: root,
        }));
      },
    }],
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}
const { TryDemoView } = await load("components/TryDemo.jsx", "TryDemo.mjs");
const BlueprintCard = (await load("components/BlueprintDownloadCard.jsx", "Blueprint.mjs")).default;
const { initialState } = await import(pathToFileURL(path.join(root, "lib/demo/demo-state.js")).href);
const { FAILURE_COPY, START_ERROR_COPY, POLL_ERROR_COPY } = await import(pathToFileURL(path.join(root, "lib/demo/failure.js")).href);
process.on("exit", () => fs.rmSync(outDir, { recursive: true, force: true }));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${String(extra).slice(0, 300)}`); }
}
const INFO = { available: true, stepNames: ["Draft", "Polish"], maxInputChars: 2000, runsPerDay: 3, remainingToday: 3, budgetExhausted: false };
const html = (state, { info = INFO, loggedIn = true } = {}) =>
  renderToStaticMarkup(React.createElement(TryDemoView, { state, dispatch: () => {}, info, isLoggedIn: loggedIn, listingId: "L1", onSubmit: () => {}, onKeyDown: () => {} }));
const S = (over = {}) => ({ ...initialState({ remainingToday: 3 }), ...over });
const run = (over = {}) => ({ id: "r1", status: "running", done: false, failure: null, steps: [], result: null, ...over });
const has = (h, s) => h.includes(s);
const buttonOf = (h, label) => { const m = h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "s")); return m ? m[0] : ""; };

// ---------------------------------------------------------------- availability + access
check("A43-C01 an unavailable demo renders NOTHING (the listing page is unchanged)",
  html(S(), { info: { available: false } }) === "" && html(S(), { info: null }) === "");
{
  const h = html(S(), { loggedIn: false });
  check("A43-C02 anonymous: a login link back to this listing, and NO input box or run button",
    has(h, 'href="/login?next=/listing/L1"') && has(h, "Log in to try the demo") && !has(h, "<textarea") && !has(h, "Run demo"), h);
}
{
  const h = html(S());
  check("A43-C03 idle form: labelled textarea, hard bound 2000, counter, disabled Run button, runs-left line, shows how it is capped",
    has(h, '<label for="try-demo-input"') && has(h, 'id="try-demo-input"') && has(h, 'maxLength="2000"') && has(h, "0 / 2000 characters")
      && /disabled/.test(buttonOf(h, "Run demo")) && has(h, "3 of 3 demo runs left today") && has(h, "Ctrl/⌘ + Enter to run"), h);
  check("A43-C04 the privacy disclosure is always visible (not shown to the seller; staff can see it)", has(h, "not to the seller") && has(h, "chatmarket staff"));
  check("A43-C05 it explains the BYOK model (blueprint runs on your own machine with your own keys)", has(h, "your own API keys"));
}
{
  const h = html(S({ text: "hello" }));
  check("A43-C06 with valid text the Run button is ENABLED and the counter updates", !/disabled/.test(buttonOf(h, "Run demo")) && has(h, "5 / 2000 characters"), buttonOf(h, "Run demo"));
  const over = html(S({ text: "a".repeat(2001) }));
  check("A43-C07 over the limit: button disabled and an inline message asks to shorten", /disabled/.test(buttonOf(over, "Run demo")) && has(over, "Please keep it under 2000 characters."));
  const hindi = html(S({ text: "अ".repeat(5) }));
  check("A43-C08 the counter counts characters, not bytes (5 Hindi letters = 5)", has(hindi, "5 / 2000 characters"));
  const custom = html(S({ text: "hey" }), { info: { ...INFO, maxInputChars: 500 } });
  check("A43-C09 the bound comes from the server's maxInputChars (500)", has(custom, 'maxLength="500"') && has(custom, "3 / 500 characters"));
}
{
  const lim = html(S({ remaining: 0 }));
  check("A43-C10 no runs left: the form is replaced by the daily-limit message (no textarea, no run button)", !has(lim, "<textarea") && !has(lim, "Run demo") && has(lim, START_ERROR_COPY.demo_daily_limit.replace("'", "&#x27;")), lim);
  const budget = html(S(), { info: { ...INFO, budgetExhausted: true } });
  check("A43-C11 platform budget used up: the 'resting for today' notice and no form", has(budget, "Demos are resting for today") && !has(budget, "<textarea"), budget);
  const anon = html(S({ remaining: null }), { info: { ...INFO, remainingToday: null } });
  check("A43-C12 when the remaining count is unknown (null) no 'runs left' line is invented", !has(anon, "demo runs left today"));
}

// ---------------------------------------------------------------- progress
{
  const st = html(S({ phase: "starting", text: "hi" }));
  check("A43-C13 starting: 'Starting…' disabled button, disabled textarea, status line", /disabled/.test(buttonOf(st, "Starting…")) && /<textarea[^>]*disabled/.test(st) && has(st, "Starting your demo…"), st);
  const q = html(S({ phase: "running", runId: "r1" }));
  check("A43-C14 running with no step info yet: queued label, both steps 'waiting', form hidden",
    has(q, "Queued — waiting for a worker…") && has(q, "Draft") && has(q, "Polish") && (q.match(/\(waiting\)/g) ?? []).length === 2 && !has(q, "<textarea"), q);
  const mid = html(S({ phase: "running", runId: "r1", run: run({ steps: [{ index: 0, status: "succeeded", text: "first draft text" }, { index: 1, status: "running", text: null }] }) }));
  check("A43-C15 mid-run: 'Running step 2 of 2', step 1 done with an expandable output, step 2 running",
    has(mid, "Running step 2 of 2…") && has(mid, "(done)") && has(mid, "(running)") && has(mid, "View this step&#x27;s output") && has(mid, "first draft text"), mid);
  check("A43-C16 accessibility: status line is a polite live region and the steps are a labelled list",
    has(mid, 'role="status"') && has(mid, 'aria-live="polite"') && has(mid, '<ol aria-label="Demo steps"'));
  const one = html(S({ phase: "running", runId: "r1", run: run({ steps: [{ index: 0, status: "succeeded", text: "only step output" }] }) }), { info: { ...INFO, stepNames: ["Only step"] } });
  check("A43-C17 a single-step demo shows no per-step output toggle (its output is the final result)", !has(one, "View this step") && !has(one, "only step output"), one);
}

// ---------------------------------------------------------------- results (success)
{
  const done = html(S({ phase: "done", runId: "r1", remaining: 2, run: run({ status: "succeeded", done: true, result: "Here is your tagline.", steps: [{ index: 0, status: "succeeded", text: "d" }, { index: 1, status: "succeeded", text: "Here is your tagline." }] }) }));
  check("A43-C18 success: Result block with the text, the AI-generated caveat, a 'Run again' button, remaining shown",
    has(done, "Result") && has(done, "Here is your tagline.") && has(done, "AI-generated sample") && has(done, "Run again") && has(done, "2 of 3 demo runs left today") && has(done, "Finished"), done);
  const evil = '<img src=x onerror=alert(1)><script>alert("xss")</script>&amp; "quoted"';
  const x = html(S({ phase: "done", runId: "r1", run: run({ status: "succeeded", done: true, result: evil, steps: [{ index: 0, status: "succeeded", text: evil }, { index: 1, status: "succeeded", text: evil }] }) }));
  check("A43-C19 UNTRUSTED OUTPUT IS ESCAPED: no raw <script>, <img or onerror= element anywhere in the markup",
    !/<script/i.test(x) && !/<img/i.test(x) && !/<[^>]+\sonerror=/i.test(x) && has(x, "&lt;img src=x onerror=alert(1)&gt;") && has(x, "&lt;script&gt;"), x);
  const emptyRes = html(S({ phase: "done", runId: "r1", run: run({ status: "succeeded", done: true, result: "", steps: [] }) }));
  check("A43-C20 an empty model answer is explained, not shown as a blank box", has(emptyRes, "The model returned an empty answer."));
  const last = html(S({ phase: "done", remaining: 0, runId: "r1", run: run({ status: "succeeded", done: true, result: "ok", steps: [] }) }));
  check("A43-C21 success on the LAST run of the day: no 'Run again' button, the daily-limit note instead", !has(last, "Run again") && has(last, "You&#x27;ve used all of your demo runs for today"), last);
}

// ---------------------------------------------------------------- results (failure)
for (const code of ["busy", "slow", "too_big", "unavailable", "cancelled", "unknown"]) {
  const f = html(S({ phase: "done", remaining: 2, runId: "r1", run: run({ status: "failed", done: true, failure: code }) }));
  const copy = FAILURE_COPY[code].replace(/'/g, "&#x27;").replace(/—/g, "—");
  check(`A43-C22 failed (${code}): friendly copy, 'Try again', NO result block, no internal tokens`,
    has(f, copy) && has(f, "Try again") && has(f, "Did not complete") && !has(f, "AI-generated sample") && !/provider_|CM0|_exceeded/.test(f), f);
}
{
  const f = html(S({ phase: "done", remaining: 2, runId: "r1", run: run({ status: "failed", done: true, failure: "not-a-real-code" }) }));
  check("A43-C23 an unrecognised failure code falls back to the generic message", has(f, FAILURE_COPY.unknown.replace(/'/g, "&#x27;")));
}

// ---------------------------------------------------------------- stalled / notices
{
  const t = html(S({ phase: "stalled", runId: "r1", notice: { kind: "poll_error", code: "timeout" } }));
  check("A43-C24 stalled (timeout): explanatory copy and a 'Check again' button", has(t, "taking longer than usual") && has(t, "Check again") && has(t, "Still working…"), t);
  const n = html(S({ phase: "stalled", runId: "r1", notice: { kind: "poll_error", code: "network" } }));
  check("A43-C25 stalled (network): connection copy and 'Check again'", has(n, "lost the connection") && has(n, "Check again"));
  const u = html(S({ phase: "stalled", runId: "r1", notice: { kind: "poll_error", code: "unauthenticated" } }));
  check("A43-C26 stalled (session expired): a login link instead of 'Check again'", has(u, 'href="/login?next=/listing/L1"') && !has(u, "Check again"), u);
  const nf = html(S({ phase: "idle", notice: { kind: "poll_error", code: "not_found" } }));
  check("A43-C27 run not found: message shown above a fresh form", has(nf, POLL_ERROR_COPY.not_found.replace(/'/g, "&#x27;")) && has(nf, "<textarea"), nf);
  const se = html(S({ phase: "idle", text: "keep my text", notice: { kind: "start_error", status: 503, reason: "demo_disabled" } }));
  check("A43-C28 a failed start shows the copy and KEEPS the typed text in the box", has(se, "Demos are paused right now") && has(se, ">keep my text</textarea>"), se);
  const g = html(S({ phase: "idle", notice: { kind: "start_error", status: 500, reason: null } }));
  check("A43-C29 an unknown start error shows the generic fallback", has(g, "Couldn&#x27;t start the demo."));
}

// ---------------------------------------------------------------- blueprint card
const card = (listing, extra = {}) => renderToStaticMarkup(React.createElement(BlueprintCard, { listing: { id: "L1", ...listing }, ...extra }));
{
  const BP = { blueprint_path: "s1/L1/my-flow.json", blueprint_format: "n8n", blueprint_sha256: "ab".repeat(32), blueprint_size_bytes: 12345 };
  const h = card(BP);
  check("A43-C30 blueprint card: format + size, enabled Download button, own-keys note, the review-before-import warning",
    has(h, "n8n workflow · 12 KB") && !/disabled/.test(buttonOf(h, "Download blueprint")) && has(h, "own API keys") && has(h, "Review a blueprint before importing"), h);
  check("A43-C31 shows the SHA-256 and copy-paste verification commands for macOS/Linux and Windows",
    has(h, "ab".repeat(32)) && has(h, "sha256sum my-flow.json") && has(h, "Get-FileHash my-flow.json -Algorithm SHA256") && has(h, 'aria-label="Copy checksum"'));
  check("A43-C32 the markup contains NO download URL and no storage path (the URL only exists after the server route says yes)", !/href="https?:/.test(h) && !/token=|signedUrl|supabase\.co|\/storage\//.test(h) && !has(h, "s1/L1"), h);
  const ref = card(BP, { refunded: true });
  check("A43-C33 refunded: the Download button is disabled and the refund message is shown", /disabled/.test(buttonOf(ref, "Download blueprint")) && has(ref, "Blueprint access ended with your refund."), ref);
  const none = card({ blueprint_path: null, blueprint_format: null, blueprint_sha256: null, blueprint_size_bytes: null });
  check("A43-C34 no blueprint attached: explains that, and offers no download button", has(none, "hasn&#x27;t attached a downloadable blueprint") && !has(none, "Download blueprint"), none);
  const evil = card({ ...BP, blueprint_path: "s1/L1/a;rm -rf ~.json" });
  check("A43-C35 a hostile file name cannot inject into the suggested commands", !/sha256sum [^<]*;/.test(evil) && !/Get-FileHash [^<]*;/.test(evil) && has(evil, "sha256sum a_rm_-rf_~.json".replace("~", "_")), evil.match(/sha256sum[^<]*/)?.[0]);
  const nohash = card({ ...BP, blueprint_sha256: null });
  check("A43-C36 without a stored hash there is no 'Verify' section (nothing invented)", !has(nohash, "Verify your download"));
  check("A43-C37 labels for other formats", has(card({ ...BP, blueprint_format: "flowise" }), "Flowise flow") && has(card({ ...BP, blueprint_format: "langflow" }), "LangFlow template"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
