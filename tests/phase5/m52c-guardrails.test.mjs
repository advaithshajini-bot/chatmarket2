// A52c-G -- static guardrails for Milestone 5.2c (disputes -> transfers / refunds) (reads source files; no database, no network).
// Run:  node tests/phase5/m52c-guardrails.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

// string-aware comment stripper (SQL: -- and /* */ ; JS: // and /* */). Quotes protect comment markers.
function stripComments(src, kind) {
  let out = "", i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      out += c;
      if (c === "\\" && kind === "js") { out += n ?? ""; i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === "'" || (kind === "js" && (c === '"' || c === "`"))) { q = c; out += c; i++; continue; }
    if (kind === "sql" && c === "-" && n === "-") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (kind === "js" && c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
const sql = (p) => stripComments(read(p), "sql");
const js = (p) => stripComments(read(p), "js");
const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === ".git") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, acc); else if (/\.(js|jsx|mjs|ts)$/.test(e.name)) acc.push(rel.replace(/\\/g, "/"));;
  }
  return acc;
};

const MIG = "supabase/migrations/20261014100000_add_dispute_actions.sql";
const m = sql(MIG), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql"));

// ---------------------------------------------------------------- migration
check("G01 the 5.2c migration exists and is the LAST-sorted migration", exists(MIG) && migs.sort().at(-1) === path.basename(MIG));
check("G02 additive only: no DROP / TRUNCATE / DELETE statements", !/\b(drop|truncate)\s+(table|function|policy|index|column|schema|trigger|type)\b/.test(lower) && !/\bdelete\s+from\b/.test(lower) && !/\btruncate\b/.test(lower));
const alters = [...lower.matchAll(/alter\s+table\s+([\w.]+)\s+([^;]+);/g)];
check("G03 ALTER TABLE only enables RLS on the new refunds table or ADDS the four columns to public.transfers", alters.length === 2
  && alters.every((x) => (x[1] === "public.refunds" && /^enable row level security$/.test(x[2].trim())) || (x[1] === "public.transfers" && /^add column review_reason[\s\S]*add column action_next_attempt_at/.test(x[2].trim()) && !/\bdrop\b|\balter column\b|\brename\b/.test(x[2]))), alters.map((x) => x[0]));
check("G04 it creates exactly one table (refunds) and one flag row (phase5_auto_refunds, OFF)", [...lower.matchAll(/create table ([\w.]+)/g)].map((x) => x[1]).join() === "public.refunds"
  && [...lower.matchAll(/insert into private\.feature_flags[^;]*;/g)].length === 1 && /values \('phase5_auto_refunds', false\)/.test(lower) && !/update private\.feature_flags/.test(lower));
check("G05 the only existing function it re-defines is plan_transfer (CREATE OR REPLACE, nothing else)", [...lower.matchAll(/create or replace function ([\w.]+)/g)].map((x) => x[1]).join() === "public.plan_transfer");
const fnDefs = [...lower.matchAll(/create function ((?:public|private)\.\w+)\(/g)].map((x) => x[1]);
check("G06 every new function is SECURITY DEFINER with search_path = ''", fnDefs.length === 9 && [...lower.matchAll(/create (?:or replace )?function[\s\S]*?\$\$;/g)].every((b) => /security definer/.test(b[0]) && /set search_path = ''/.test(b[0])), fnDefs);
const pubFns = fnDefs.filter((f) => f.startsWith("public."));
check("G07 every public function revokes from public/anon/authenticated", pubFns.every((f) => new RegExp(`revoke all on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated`).test(lower)), pubFns);
check("G08 private functions are revoked from every API role", fnDefs.filter((f) => f.startsWith("private.")).every((f) => new RegExp(`revoke execute on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role`).test(lower)));
const grants = [...lower.matchAll(/grant execute on function (public\.\w+)\([^)]*\) to (\w+)/g)].map((x) => [x[1], x[2]]);
check("G09 only service_role executes the dispute/refund functions; only the admin RPC goes to authenticated", grants.length === 7 && grants.every(([f, r]) => (f === "public.admin_clear_transfer_review" ? r === "authenticated" : r === "service_role")), grants);
check("G10 the admin RPC checks admin + MFA first and writes an audit row", /create function public\.admin_clear_transfer_review[\s\S]*?begin\s+if not \(select private\.is_admin_mfa\(\)\)/.test(lower) && /transfer_review_cleared/.test(lower));
check("G11 authenticated users get SELECT only on refunds; RLS enabled; buyer + admin policies only", /revoke all on public\.refunds from anon, authenticated/.test(lower) && /grant select on public\.refunds to authenticated/.test(lower) && !/grant\s+(insert|update|delete|all)[^;]*on\s+public\.refunds/.test(lower)
  && [...lower.matchAll(/create policy\s+"[^"]*"\s+on\s+([\w.]+)/g)].every((x) => x[1] === "public.refunds"));
check("G12 one refund per purchase is enforced by the database (purchase_id NOT NULL UNIQUE; refund id unique)", /purchase_id\s+uuid not null unique references public\.purchases/.test(lower) && /razorpay_refund_id\s+text unique/.test(lower));
check("G13 the migration writes to no existing business table (purchases / listings / disputes / profiles): only transfers (own), refunds, audit_log, webhook_events",
  !/\b(update|insert into)\s+public\.(listings|profiles|disputes|payouts|entitlements|payment_orders)\b/.test(lower) && [...lower.matchAll(/update public\.purchases pu\s+set\s+([^;]*?)\s+where/gs)].every((x) => /^transfer_status\s*=\s*private\.purchase_transfer_status\([^)]*\)$/.test(x[1].trim())));
check("G14 error code CM072 is used by this migration and by no OTHER migration", read(MIG).includes("CM072") && migs.filter((f) => f !== path.basename(MIG)).every((f) => !read(`supabase/migrations/${f}`).includes("CM072")));
check("G15 the migration carries rollback SQL in its header", /rollback/i.test(read(MIG).slice(0, 4000)) && /drop table public\.refunds/.test(read(MIG)));
check("G16 the derived-need rule: hold/flag/reverse never depend on a flag; release needs the transfers flag; refund needs the refund flag",
  /v_d = 'resolved_denied'[\s\S]*?private\.is_route_transfers_enabled\(\)[\s\S]*?return 'release'/.test(lower) && /not private\.is_auto_refunds_enabled\(\)/.test(lower)
  && !/is_route_transfers_enabled\(\)[\s\S]{0,80}return 'hold'/.test(lower) && !/is_route_transfers_enabled\(\)[\s\S]{0,80}return 'reverse'/.test(lower));
check("G17 a refund is only offered after the transfer is out of the way (reversed/failed/none) and never while a reversal is parked", /v_live and v_t\.amount_reversed_paise < v_t\.amount_paise then\s+return 'reverse'/.test(lower) && /v_t\.review_reason is not null then\s+return null/.test(lower) && /v_tfound and v_t\.status = 'creating' then\s+return null/.test(lower));
check("G18 claim/finish/plan take the SAME per-purchase advisory lock as plan_transfer", (lower.match(/hashtextextended\('transfer_purchase:'/g) ?? []).length >= 4);
check("G19 plan_refund also refuses unless the derived need is exactly 'refund' and the flag is on", /create function public\.plan_refund[\s\S]*?is_auto_refunds_enabled\(\)[\s\S]*?'disabled'[\s\S]*?dispute_action_needed\(p_purchase_id\) is distinct from 'refund'/.test(lower));
check("G20 a processed or failed refund is terminal; a refund never moves backwards", /v_r\.status in \('processed', 'failed'\) then\s+v_outcome := 'stale'/.test(lower) && /v_rank_n < v_rank_o/.test(lower));
check("G21 amounts are integer paise (round(amount * 100)); the release restores, never shortens, the original 48h window", /round\(v_p\.amount \* 100\)/.test(lower) && /purchased_at \+ interval '48 hours'/.test(lower) && /v_end > now\(\) \+ interval '5 minutes'/.test(lower));
check("G22 a settled transfer is never put back on hold by a late result", /if v_t\.settlement_status is distinct from 'settled' then/.test(lower));
check("G23 plan_transfer keeps its 5.2 shape and now reports adopt_only (refunded => adopt, never create)", /'adopt_only', coalesce\(v_dispute = 'resolved_refunded', false\)/.test(lower) && /'adopt_only', false/.test(lower));

// ---------------------------------------------------------------- app code
const dis = js("lib/payments/disputes.js"), cl = js("lib/payments/razorpay-client.js");
const appFiles = [...walk("lib"), ...walk("app"), ...(exists("middleware.js") ? ["middleware.js"] : [])];
const newFiles = ["lib/payments/disputes.js", "lib/payments/dispute-sync-handler.js", "lib/payments/reconcile.js", "lib/payments/refund-events.js", "app/api/payments/disputes/sync/route.js"];
check("G30 the Razorpay refund / reversal API is spoken only by razorpay-client.js", appFiles.filter((f) => /\/v1\/transfers\/[^"'`]*reversals|\/v1\/payments\/[^"'`]*\/refunds?\b/.test(js(f)) && !/^app\/api\/razorpay\//.test(f)).join() === "lib/payments/razorpay-client.js", appFiles.filter((f) => /\/v1\/transfers\/[^"'`]*reversals|\/v1\/payments\/[^"'`]*\/refunds?\b/.test(js(f))));
check("G31 no console.*, fetch, env var or Supabase access in the dispute logic files", ["lib/payments/disputes.js", "lib/payments/dispute-sync-handler.js", "lib/payments/reconcile.js", "lib/payments/refund-events.js"].every((f) => !/console\.|\bfetch\(|process\.env|supabase|service-client/i.test(js(f))));
check("G32 no console.* in the new route and no secret literal anywhere new", !/console\./.test(js("app/api/payments/disputes/sync/route.js")) && !newFiles.some((f) => /rzp_(test|live)_[A-Za-z0-9]{6,}|whsec_|sk_(live|test)_/.test(read(f))));
check("G33 the refund is created from exactly one place, and only AFTER the payment's refunds were listed", (dis.match(/\.createRefund\(/g) ?? []).length === 1 && dis.indexOf("listPaymentRefunds(") > -1 && dis.indexOf("listPaymentRefunds(") < dis.indexOf("rzp.createRefund(") && appFiles.filter((f) => f !== "lib/payments/disputes.js" && f !== "lib/payments/razorpay-client.js").every((f) => !/\.createRefund\(/.test(js(f))));
check("G34 a refund is only attempted after planRefund returns 'claimed'", dis.indexOf('plan?.outcome !== "claimed"') > -1 && dis.indexOf('plan?.outcome !== "claimed"') < dis.indexOf("listPaymentRefunds("));
check("G35 the reversal is sized from Razorpay's own numbers (fetchTransfer before reverseTransfer), and reverseTransfer is called from one place", (dis.match(/\.reverseTransfer\(/g) ?? []).length === 1 && dis.indexOf("rzp.fetchTransfer(id)") > -1 && dis.indexOf("rzp.fetchTransfer(id)") < dis.indexOf("rzp.reverseTransfer("));
check("G36 every action goes through claimDisputeAction (hold, flag, release, reverse) or planRefund before any Razorpay call", ["hold", "flag", "release", "reverse"].every((a) => new RegExp(`claimDisputeAction\\(\\{ purchaseId, action: "${a}" \\}\\)`).test(dis)) && /planRefund\(\{ purchaseId \}\)/.test(dis));
check("G37 the hold PATCH has no end date (indefinite); release uses only what the database returned", /setTransferHold\(c\.razorpay_transfer_id, true, null\)/.test(dis) && /setTransferHold\(c\.razorpay_transfer_id, !!c\.on_hold, c\.hold_until_epoch \?\? null\)/.test(dis));
check("G38 the browser-triggered route authenticates the session, checks the dispute under the CALLER's RLS, and takes nothing but a purchase id", /auth\.getUser\(\)/.test(js("app/api/payments/disputes/sync/route.js")) && /userId: userData\?\.user\?\.id \?\? null,/.test(js("app/api/payments/disputes/sync/route.js")) && /from\("disputes"\)/.test(js("app/api/payments/disputes/sync/route.js")) && /body\?\.purchaseId/.test(js("app/api/payments/disputes/sync/route.js")) && !/body\?\.(action|status|amount|outcome)/.test(js("app/api/payments/disputes/sync/route.js")));
check("G39 the sync route is glue: small, nodejs, POST only", js("app/api/payments/disputes/sync/route.js").split("\n").length < 45 && /runtime = "nodejs"/.test(js("app/api/payments/disputes/sync/route.js")) && !/export (const|async function) GET/.test(js("app/api/payments/disputes/sync/route.js")));
check("G40 the handler validates a UUID before any lookup and never echoes detail", /UUID_RE\.test\(purchaseId\)/.test(js("lib/payments/dispute-sync-handler.js")) && !/json: \{[^}]*(outcome|error: String|message)/.test(js("lib/payments/dispute-sync-handler.js").replace(/error: "[^"]*"/g, "")));
check("G41 the sweep route runs the whole reconciliation (disputes first)", /runReconciliation\(/.test(js("app/api/payments/transfers/sweep/route.js")) && /runDisputeSweep\([\s\S]*runTransferSweep\(/.test(js("lib/payments/reconcile.js")));
check("G42 the webhook handler reads refund events from the entity (no event-name logic) and never reads notes beyond the entity helper", /REFUND_EVENT_RE\.test\(eventType\)/.test(js("lib/payments/webhook-handler.js")) && !/eventType\s*===\s*["']refund\./.test(js("lib/payments/webhook-handler.js")) && !/\.notes/.test(js("lib/payments/webhook-handler.js")));
check("G43 the two browser hooks are fire-and-forget (.catch) and send only the purchase id", /disputes\/sync[\s\S]{0,200}JSON\.stringify\(\{ purchaseId: [\w.]+ \}\) \}\)\.catch\(/.test(read("components/PurchaseHistoryClient.jsx")) && /disputes\/sync[\s\S]{0,200}JSON\.stringify\(\{ purchaseId: [\w.]+ \}\) \}\)\.catch\(/.test(read("components/AdminDisputesClient.jsx")));
check("G44 the dispute-filing and resolution UI still go through the same RLS insert / resolve_dispute RPC as before", /from\("disputes"\)/.test(read("components/PurchaseHistoryClient.jsx")) && /rpc\("resolve_dispute"/.test(read("components/AdminDisputesClient.jsx")));
check("G45 neither flag is referenced by app code (database kill switches only)", appFiles.every((f) => !/phase5_auto_refunds|phase5_route_transfers/.test(js(f))));
check("G46 the 5.2c service client stays inside app/api routes", appFiles.filter((f) => /service-client/.test(js(f)) && !f.endsWith("service-client.js")).every((f) => f.startsWith("app/api/") && /route\.js$/.test(f)));

console.log(`\nA52c-G: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
