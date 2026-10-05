// A43-G -- static source scans for the Milestone 4.3 UI boundary. Same style as tests/phase2/guardrails.test.mjs:
// regression guards that fail if a future edit quietly widens what the demo / blueprint UI is allowed to do.
// Run from the REPO ROOT:  node tests/phase4/m43-guardrails.test.mjs
import { readFileSync, existsSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
// Scans look at CODE, not prose: comments are removed with a small string-aware scanner (a regex cannot do
// this safely -- e.g. "lib/demo/*" inside a // comment looks like the start of a block comment).
function stripComments(src) {
  let out = "", i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (quote === null) {
      if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c; i++;
    } else {
      if (c === "\\") { out += c + (n ?? ""); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++;
    }
  }
  return out;
}
const read = (p) => stripComments(readFileSync(`./${p}`, "utf8"));
const readRaw = (p) => readFileSync(`./${p}`, "utf8");
const apiPaths = (src) => [...src.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)].map(m => m[1]);

// ---- the Phase 2 guardrail still holds, literally, on the file it was written for
const wad = read("components/WorkflowAgentDetail.jsx");
check("A43-G01 Phase 2 guardrail intact: WorkflowAgentDetail has no fetch(run|execute) and no run/execute handlers",
  !/fetch\(.*(run|execute)/i.test(wad) && !/onRun|onExecute|handleRun|handleExecute/.test(wad));
check("A43-G02 ...and goes further: WorkflowAgentDetail contains NO fetch( at all and no /api/ path -- execution lives only in <TryDemo />",
  !/fetch\(/.test(wad) && !/\/api\//.test(wad) && /import TryDemo from "@\/components\/TryDemo"/.test(wad) && /<TryDemo /.test(wad));
check("A43-G03 WorkflowAgentDetail stays a server component (no 'use client')", !/^\s*["']use client["']/m.test(wad));

// ---- TryDemo
const td = read("components/TryDemo.jsx");
check("A43-G00 the comment scanner keeps the code (sanity): TryDemo still has both components after stripping", /export function TryDemoView/.test(td) && /export default function TryDemo\(/.test(td) && /maxLength=\{max\}/.test(td) && td.length > readRaw("components/TryDemo.jsx").length * 0.6);
check("A43-G04 TryDemo is a client component and talks to exactly two endpoints: POST /api/demo/runs and GET /api/demo/runs/[id]",
  /^\s*"use client"/.test(td) && JSON.stringify([...new Set(apiPaths(td))].sort()) === JSON.stringify(["/api/demo/runs", "/api/demo/runs/${runId}"].sort()), apiPaths(td));
check("A43-G05 TryDemo never touches the generic run API (/api/runs) or anything that cancels/approves", !/\/api\/runs/.test(td) && !/cancel|approv/i.test(td.replace(/Don&apos;t|\/\/.*$/gm, "")));
check("A43-G06 model output is never injected as HTML: no dangerouslySetInnerHTML / innerHTML in TryDemo or BlueprintDownloadCard",
  !/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/.test(td) && !/dangerouslySetInnerHTML|innerHTML/.test(read("components/BlueprintDownloadCard.jsx")));
check("A43-G07 TryDemo does not read execution_config or any prompt/config field", !/execution_config|demo_config|\.system\b|listing_demos/.test(td));
check("A43-G08 TryDemo persists only a run id, in sessionStorage (not localStorage), and never the typed text or the result",
  /sessionStorage/.test(td) && !/localStorage/.test(td) && !/setItem\([^)]*(text|result)/.test(td));
const wrapper = td.slice(td.indexOf("export default function TryDemo("));
const viewPart = td.slice(td.indexOf("export function TryDemoView"), td.indexOf("export default function TryDemo("));
check("A43-G09 rules of hooks: in the wrapper every hook is called BEFORE its early return, and the pure view calls no hooks at all",
  wrapper.lastIndexOf("useEffect(") < wrapper.indexOf("if (!info || !info.available) return null;") && wrapper.indexOf("useReducer(") < wrapper.indexOf("if (!info || !info.available) return null;")
  && !/\buse(State|Effect|Reducer|Ref|Memo|Callback)\(/.test(viewPart));
check("A43-G10 the input box is hard-bounded (maxLength) and the submit path validates", /maxLength=\{max\}/.test(td) && /canSubmit\(state, max\)/.test(td));
check("A43-G11 TryDemo tells the user who can see their input (privacy disclosure), and the polling is abortable",
  /not to the seller/.test(readRaw("components/TryDemo.jsx")) && /new AbortController\(\)/.test(td) && /ac\.abort\(\)/.test(td));

// ---- BlueprintDownloadCard
const bd = read("components/BlueprintDownloadCard.jsx");
check("A43-G12 BlueprintDownloadCard asks ONLY the server route for a URL (no direct storage call, no service key)",
  JSON.stringify(apiPaths(bd)) === JSON.stringify(["/api/listings/${listing.id}/blueprint"]) && !/storage\.from|createSignedUrl|SERVICE_ROLE|supabase/i.test(bd), apiPaths(bd));
check("A43-G13 the library detail page keeps the Playbook ZIP download path untouched (listing-files + 'Download files (.zip)')",
  /from\("listing-files"\)/.test(read("components/LibraryDetailClient.jsx")) && /Download files \(\.zip\)/.test(read("components/LibraryDetailClient.jsx"))
  && /isBlueprintProduct \?/.test(read("components/LibraryDetailClient.jsx")));

// ---- server handlers / routes
const rh = read("lib/demo/route-handlers.js");
const g0 = rh.indexOf("export async function getDemoRunHandler");
const demoGet = rh.slice(g0);
check("A43-G14 the polling handler selects explicit columns only: no select(\"*\"), no execution_config, no input, no raw error in the response",
  g0 > 0 && !/select\(\s*["'`]\*["'`]\s*\)/.test(demoGet) && !/execution_config/.test(demoGet) && !/\binput\b/.test(demoGet.replace(/\/\/.*$/gm, "")) && /classifyDemoFailure\(run\.error\)/.test(rh));
for (const [file, handler] of [["app/api/demo/runs/route.js", "startDemoRunHandler"], ["app/api/demo/runs/[id]/route.js", "getDemoRunHandler"], ["app/api/listings/[id]/blueprint/route.js", "getBlueprintDownloadHandler"]]) {
  const src = existsSync(`./${file}`) ? read(file) : "";
  check(`A43-G15 ${file}: authenticates with getVerifiedUser, delegates to ${handler}, and makes no database call of its own`,
    /getVerifiedUser\(supabase\)/.test(src) && src.includes(handler + "(") && !/\.from\(|\.rpc\(|\.storage/.test(src), file);
}
check("A43-G16 the polling route is never cached", /no-store/.test(read("app/api/demo/runs/[id]/route.js")));
check("A43-G17 nothing in the demo/blueprint UI or handlers references a service-role key",
  ["lib/demo/route-handlers.js", "lib/demo/polling.js", "lib/demo/failure.js", "lib/demo/demo-state.js", "lib/blueprints/download.js", "lib/blueprints/format.js", "lib/domain/demos.js", "components/TryDemo.jsx", "components/BlueprintDownloadCard.jsx"]
    .every(f => !/service_role|SERVICE_ROLE|serviceKey/i.test(read(f))));

// ---- listing page + domain mapper
const page = read("app/listing/[id]/page.jsx");
check("A43-G18 the listing page still reads the product through lib/domain (Phase 2 rule) and gets demo availability through lib/domain/demos",
  /getProduct\(/.test(page) && /lib\/domain\/products/.test(page) && /getListingDemoInfo\(supabase, product\.id\)/.test(page) && !/\.rpc\(/.test(page));
const prod = read("lib/domain/products.js");
const sel = (prod.match(/const PRODUCT_SELECT_COLUMNS =\s*\n?\s*"([^"]+)"/) ?? [])[1] ?? "";
check("A43-G19 the product list/detail select exposes blueprint format + size only -- never the storage path or the hash",
  /blueprint_format/.test(sel) && /blueprint_size_bytes/.test(sel) && !/blueprint_path|blueprint_sha256/.test(sel), sel);
check("A43-G20 toProduct maps blueprint to { format, sizeBytes } or null", /blueprint: blueprint_format \? \{ format: blueprint_format, sizeBytes: blueprint_size_bytes \?\? null \} : null/.test(prod));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
