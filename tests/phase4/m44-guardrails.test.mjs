// A44-G -- static source scans for the Milestone 4.4 boundaries (same style as m43-guardrails: regression guards that fail
// if a later edit quietly widens what the Seller Studio / Moderation Desk may do). Run from the REPO ROOT.
import { readFileSync, existsSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
// string-aware comment stripper (a naive regex swallows code that contains "//" or "/*" inside strings / URLs)
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
const must = (p) => { if (!existsSync(`./${p}`)) { check(`A44-G00 ${p} exists`, false); return ""; } return readFileSync(`./${p}`, "utf8"); };
const read = (p) => stripComments(must(p));
const apiPaths = (src) => [...new Set([...src.matchAll(/["'`](\/api\/[^"'`\s]*)["'`]/g)].map((m) => m[1]))].sort();

const M44_FILES = ["lib/blueprints/inspect.js", "lib/studio/demo-draft.js", "lib/studio/upload-flow.js", "lib/studio/route-handlers.js", "lib/studio/studio-state.js",
  "lib/admin/review-handlers.js", "lib/admin/review-state.js", "lib/admin/review-constants.js", "lib/domain/studio.js", "lib/domain/admin-reviews.js",
  "components/SellerStudio.jsx", "components/AdminReviewDesk.jsx", "app/sell/studio/[id]/page.jsx", "app/admin/reviews/page.jsx",
  "app/api/studio/models/route.js", "app/api/studio/listings/[id]/demo/route.js", "app/api/studio/listings/[id]/demo/submit/route.js", "app/api/studio/listings/[id]/blueprint/route.js",
  "app/api/admin/reviews/route.js", "app/api/admin/reviews/demos/[id]/route.js", "app/api/admin/reviews/blueprints/[id]/route.js"];
const src = Object.fromEntries(M44_FILES.map((f) => [f, read(f)]));

check("A44-G01 the comment scanner keeps code (sanity)", /export function SellerStudioView/.test(src["components/SellerStudio.jsx"]) && src["components/SellerStudio.jsx"].length > must("components/SellerStudio.jsx").length * 0.55);
check("A44-G02 no M4.4 file references a service-role key", M44_FILES.every((f) => !/service_role|SERVICE_ROLE|serviceKey|SUPABASE_SERVICE/i.test(src[f])), M44_FILES.filter((f) => /service_role|SERVICE_ROLE|serviceKey/i.test(src[f])));
check("A44-G03 no M4.4 file logs anything (a leaked key must not reach server logs)", M44_FILES.every((f) => !/console\.(log|error|warn|info|debug)/.test(src[f])));
check("A44-G04 untrusted text is never injected as HTML in either component", ["components/SellerStudio.jsx", "components/AdminReviewDesk.jsx"].every((f) => !/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src[f])));

// ---- SellerStudio
const st = src["components/SellerStudio.jsx"];
check("A44-G05 SellerStudio is a client component and calls ONLY the demo + blueprint studio endpoints",
  /^\s*"use client"/.test(st) && JSON.stringify(apiPaths(st)) === JSON.stringify(["/api/studio/listings/${listingId}/blueprint", "/api/studio/listings/${listingId}/demo"].sort()) && /`\$\{demoUrl\}\/submit`/.test(st), apiPaths(st));
check("A44-G06 SellerStudio has no direct table / RPC access and its ONLY storage call is an upload into 'listing-blueprints'",
  !/\.rpc\(|\.from\(\s*["'`](?!listing-blueprints)/.test(st) && (st.match(/\.storage\b/g) ?? []).length === 1 && /\.storage\.from\("listing-blueprints"\)\.upload\(path, file, \{ contentType: "application\/json", upsert: false \}\)/.test(st) && !/\.(download|remove|createSignedUrl|list)\(/.test(st));
check("A44-G07 SellerStudio never sends a hash/format/size to the server: the register call carries only { path }", /\{ path \}/.test(st) && !/sha256|sha-256/i.test(st.slice(st.indexOf("export default function SellerStudio"))));
check("A44-G08 SellerStudio keeps nothing in localStorage / sessionStorage", !/localStorage|sessionStorage/.test(st));
check("A44-G09 the 2-step cap comes from lib (MAX_STEPS) and the Add button is disabled at the cap", /MAX_STEPS/.test(st) && /draft\.steps\.length >= MAX_STEPS/.test(st));
check("A44-G10 upload is only offered after a clean local scan (canUploadBlueprint) and the handler re-checks it", /disabled=\{!canUploadBlueprint\(state\)\}/.test(st) && /!canUploadBlueprint\(state\)\) return/.test(st));
const view = (f, a, b) => { const s = src[f]; return s.slice(s.indexOf(a), s.indexOf(b)); };
check("A44-G11 rules of hooks: the pure views call no hooks at all", !/\buse(State|Effect|Reducer|Ref|Memo|Callback)\(/.test(view("components/SellerStudio.jsx", "export function SellerStudioView", "const post = async"))
  && !/\buse(State|Effect|Reducer|Ref|Memo|Callback)\(/.test(view("components/AdminReviewDesk.jsx", "export function AdminReviewDeskView", "const call = async")));
check("A44-G12 SellerStudio tells sellers what stays private", /instructions stay private|Instructions \(private\)/i.test(must("components/SellerStudio.jsx")));

// ---- AdminReviewDesk
const ad = src["components/AdminReviewDesk.jsx"];
check("A44-G13 AdminReviewDesk is a client component and calls ONLY the admin review endpoints (the queue and /demos|/blueprints/[id])",
  /^\s*"use client"/.test(ad) && JSON.stringify(apiPaths(ad)) === JSON.stringify(["/api/admin/reviews"]) && (ad.match(/\/api\//g) ?? []).length === 2
  && /`\/api\/admin\/reviews\/\$\{kind === "demo" \? "demos" : "blueprints"\}\/\$\{id\}`/.test(ad), apiPaths(ad));
check("A44-G14 AdminReviewDesk has no Supabase client, no storage, no RPC; it imports no server handler module", !/supabase|\.storage|\.rpc\(|\.from\(/i.test(ad) && !/review-handlers|route-handlers/.test(ad));
check("A44-G15 a demo decision carries the version the admin REVIEWED", /expectedVersion: detail\.demo\.configVersion/.test(ad));
check("A44-G16 Approve is gated by canApprove and Reject by canReject, in the markup AND in the handler", /disabled=\{!canApprove\(state\)\}/.test(ad) && /disabled=\{!canReject\(state\)\}/.test(ad) && /canApprove\(state\) : !canReject\(state\)\) return/.test(ad));
check("A44-G17 the signed download link opens with rel=noopener noreferrer", /rel="noopener noreferrer"/.test(ad));

// ---- client bundles never pull in server handler modules
check("A44-G18 neither component imports a server handler module or next/server", ["components/SellerStudio.jsx", "components/AdminReviewDesk.jsx"].every((f) => !/route-handlers|review-handlers|next\/server/.test(src[f])));

// ---- handlers
const sh = src["lib/studio/route-handlers.js"], ah = src["lib/admin/review-handlers.js"];
check("A44-G19 the handler modules are framework-free: relative imports only, no next/*, no @/ aliases", [sh, ah, src["lib/blueprints/inspect.js"], src["lib/studio/upload-flow.js"]].every((s) => !/from\s+["'](next|@\/)/.test(s)));
check("A44-G20 inspect.js has no imports at all (it runs unchanged in the browser and on the server)", !/^\s*import\s/m.test(src["lib/blueprints/inspect.js"]));
check("A44-G21 no handler or domain read uses select(\"*\")", ["lib/studio/route-handlers.js", "lib/admin/review-handlers.js", "lib/domain/studio.js", "lib/domain/admin-reviews.js"].every((f) => !/select\(\s*["'`]\*["'`]\s*\)/.test(src[f])));
check("A44-G22 neither handler ever reads a hash from the request body: hashes are always recomputed from stored bytes", !/body\??\.(sha|hash|verified|format|size)/i.test(sh) && !/body\??\.(sha|hash|verified)/i.test(ah) && /p_verified_sha256: verified/.test(ah) && /verified = v\.sha256/.test(ah));
check("A44-G23 the approve path blocks on mismatch, missing, invalid AND credentials before calling the RPC", (() => { const i = ah.indexOf("export async function reviewBlueprintHandler"); const body = ah.slice(i); const rpc = body.indexOf('rpc("review_listing_blueprint"');
  return ["missing", "invalid", "mismatch", "v.blocking.length > 0"].every((k) => { const p = body.indexOf(k); return p > 0 && p < rpc; }); })());
check("A44-G24 the registration route trusts only the storage path (and pins it to the caller's own folder)", /parts\[0\] !== String\(user\.id\)\.toLowerCase\(\)/.test(sh) && /parts\[1\] !== listingId\.toLowerCase\(\)/.test(sh) && /\.download\(path\)/.test(sh));
check("A44-G25 failed/unacceptable uploads are discarded from the private bucket", (sh.match(/await discard\(\)/g) ?? []).length >= 4);
check("A44-G26 handlers map errors through a table; raw database messages are never returned", !/error\.message/.test(sh) && !/error\.message/.test(ah) && !/json: \{ error: (e|err|error)\b/.test(sh + ah));

// ---- routes: glue only
for (const f of M44_FILES.filter((x) => x.startsWith("app/api/"))) {
  const s = src[f];
  const handlers = [...s.matchAll(/(\w+Handler)\(/g)].map((m) => m[1]);
  check(`A44-G27 ${f}: authenticates with getVerifiedUser, delegates to a handler, no DB / storage call, never cached`,
    /getVerifiedUser\(supabase\)/.test(s) && handlers.length >= 1 && !/\.from\(|\.rpc\(|\.storage/.test(s) && (s.match(/no-store/g) ?? []).length >= (s.match(/NextResponse\.json\([^)]*\{ status/g) ?? []).length - (s.match(/Invalid request body/g) ?? []).length, f);
}
check("A44-G28 route methods are exactly: models GET, demo PUT, submit POST, blueprint POST, queue GET, demo-review GET+POST, blueprint-review GET+POST", (() => {
  const m = (f) => [...src[f].matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((x) => x[1]).join();
  return m("app/api/studio/models/route.js") === "GET" && m("app/api/studio/listings/[id]/demo/route.js") === "PUT" && m("app/api/studio/listings/[id]/demo/submit/route.js") === "POST"
    && m("app/api/studio/listings/[id]/blueprint/route.js") === "POST" && m("app/api/admin/reviews/route.js") === "GET" && m("app/api/admin/reviews/demos/[id]/route.js") === "GET,POST" && m("app/api/admin/reviews/blueprints/[id]/route.js") === "GET,POST"; })());

// ---- pages
const ap = src["app/admin/reviews/page.jsx"], sp = src["app/sell/studio/[id]/page.jsx"];
check("A44-G29 the admin page draws the desk only after is_admin AND aal2 (gate.allowed), and reads through lib/domain", /getAdminGate\(supabase, user\)/.test(ap) && ap.indexOf("!gate.allowed") > 0 && ap.indexOf("!gate.allowed") < ap.indexOf("<AdminReviewDesk") && !/\.rpc\(|\.from\(/.test(ap));
check("A44-G30 the studio page reads through lib/domain/studio and treats 'not yours' as 'not found'", /getStudioState\(supabase, params\.id, user\.id\)/.test(sp) && !/\.rpc\(|\.from\(/.test(sp));
check("A44-G31 both pages are dynamic (never statically cached)", /dynamic = "force-dynamic"/.test(ap) && /dynamic = "force-dynamic"/.test(sp));
check("A44-G32 the studio domain read uses explicit column lists (no blueprint path or hash is selected for the page)", !/blueprint_path|storage_path/.test(src["lib/domain/studio.js"]) && /SUBMISSION_COLUMNS = "id, format, size_bytes, status, review_note, submitted_at"/.test(src["lib/domain/studio.js"]));

// ---- migration
const mig = must("supabase/migrations/20260930100800_add_seller_admin_review.sql");
const migCode = mig.replace(/--.*$/gm, "");
const fnBlocks = [...migCode.matchAll(/create (?:or replace )?function (public\.\w+)\(([\s\S]*?)\n\$\$;/g)].map((m) => ({ name: m[1], body: m[0] }));
const adminFns = fnBlocks.filter((b) => /^public\.(admin_|review_listing_|set_listing_demo_approval)/.test(b.name));
check("A44-G33 every admin RPC (admin_*, review_listing_*, set_listing_demo_approval) calls private.is_admin_mfa() as its FIRST statement", adminFns.length === 6 && adminFns.every((b) => { const after = b.body.slice(b.body.indexOf("\nbegin") + 6).trimStart(); return /^if not private\.is_admin_mfa\(\) then\s+raise exception using errcode = '42501'/.test(after); }), adminFns.map((b) => b.name));
check("A44-G34 every public function in the migration is SECURITY DEFINER with search_path = ''", fnBlocks.length >= 10 && fnBlocks.every((b) => /security definer set search_path = ''/.test(b.body)), fnBlocks.filter((b) => !/security definer set search_path = ''/.test(b.body)).map((b) => b.name));
check("A44-G35 no new public function is granted to anon or service_role", !/grant\s+execute[^;]*\bto\b[^;]*\b(anon|service_role)\b/i.test(migCode.replace(/revoke[^;]*;/gi, "")));
check("A44-G36 the migration never writes to private.demo_settings / model_pricing / feature_flags", !/(insert into|update|delete from)\s+private\.(demo_settings|model_pricing|feature_flags)/i.test(migCode));
check("A44-G37 the migration is additive: no DROP TABLE / DROP COLUMN / TRUNCATE; DROP POLICY only for the two storage policies it re-creates", !/drop\s+(table|column|schema)|truncate/i.test(migCode) && (migCode.match(/drop policy/gi) ?? []).length === 2 && /drop policy "Buyers can download blueprints they paid for"/.test(migCode) && /drop policy "Sellers can delete their own blueprints"/.test(migCode));
check("A44-G38 every new table has RLS enabled and its API-role privileges revoked first", ["public.review_audit", "public.blueprint_submissions"].every((t) => new RegExp(`alter table ${t} enable row level security`).test(migCode) && new RegExp(`revoke all on ${t} from public, anon, authenticated, service_role`).test(migCode)));
check("A44-G39 feature flags are untouched (all remain OFF until activated)", !/feature_flags/.test(migCode));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
