// A53-G -- static guardrails for Milestone 5.3 part 1 (admin payments reporting + desk). Reads source; no database, no network.
// Run:  node tests/phase5/m53-guardrails.test.mjs
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
function stripComments(src, kind) {
  let out = "", i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) { out += c; if (c === "\\" && kind === "js") { out += n ?? ""; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === "'" || (kind === "js" && (c === '"' || c === "`"))) { q = c; out += c; i++; continue; }
    if (kind === "sql" && c === "-" && n === "-") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (kind === "js" && c === "/" && n === "/" && src[i - 1] !== ":") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
const MIG = "supabase/migrations/20261015100000_add_payout_reporting.sql";
const m = stripComments(read(MIG), "sql"), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const PUB = ["admin_payment_attention_count", "admin_payment_attention", "admin_transfers_ledger", "admin_disputes_refunds", "admin_purchase_timeline", "admin_seller_balances"];
const bodyOf = (name) => { const a = lower.indexOf(`create function public.${name}(`); const b = lower.indexOf("\n$$;", a); return a < 0 ? "" : lower.slice(a, b); };

// ---------------------------------------------------------------- migration
check("G01 the migration sorts after 20261014100000 and is the newest", migs.at(-1) === path.basename(MIG) && migs.at(-2) === "20261014100000_add_dispute_actions.sql");
check("G02 additive: no DROP/ALTER/TRUNCATE and no new table, index, policy, trigger or extension",
  !/\b(drop\s+(table|column|policy|trigger|function)|alter\s+(table|function)|truncate|create\s+(table|index|policy|trigger|extension|unique|type|view))\b/.test(lower));
for (const f of PUB) {
  const b = bodyOf(f);
  check(`G10 ${f}: exists, SECURITY DEFINER, search_path '', STABLE`, b.includes("security definer") && b.includes("set search_path = ''") && /\bstable\b/.test(b));
  const first = b.slice(b.indexOf("begin") + 5).trimStart();
  check(`G11 ${f}: the FIRST statement is the admin + MFA check (42501)`, /^if not \(select private\.is_admin_mfa\(\)\) then\s+raise exception using errcode = '42501'/.test(first), first.slice(0, 120));
  check(`G12 ${f}: revoked from public/anon/authenticated and granted to authenticated ONLY`,
    new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`).test(lower) &&
    new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to authenticated;`).test(lower) &&
    !new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to (anon|service_role|public)`).test(lower));
  check(`G13 ${f}: no write statements in the body`, !/\b(insert\s+into|update\s+public|delete\s+from|truncate|perform\s+set_config)\b/.test(b));
}
check("G14 helpers are not executable by anyone", /revoke execute on function private\.transfer_bucket\(text, text, boolean, text\) from public, anon, authenticated, service_role/.test(lower) &&
  /revoke execute on function private\.payment_attention_rows\(\) from public, anon, authenticated, service_role/.test(lower) && !/grant execute on function private\./.test(lower));
check("G15 no feature flag is read or changed", !/feature_flags|is_route_transfers_enabled|is_auto_refunds_enabled/.test(lower));
check("G16 error code CM073 is used here and nowhere in earlier migrations", /CM073/.test(m) && migs.filter((f) => f !== path.basename(MIG)).every((f) => !read("supabase/migrations/" + f).includes("CM073")));
check("G17 webhook payloads / hashes are never selected", !/payload_sha256|\bpayload\b/.test(lower));
check("G18 no secret names appear", !/razorpay_key|webhook_secret|service_role_key|cron_secret/.test(lower));
check("G19 the migration names only existing relations", ["transfers", "refunds", "disputes", "purchases", "listings", "profiles", "webhook_events", "audit_log", "seller_payout_accounts"].every((t) => lower.includes(`public.${t}`)));

// ---------------------------------------------------------------- app code
const lib = stripComments(read("lib/domain/admin-payments.js"), "js");
const page = stripComments(read("app/admin/payments/page.jsx"), "js");
const desk = stripComments(read("components/AdminPaymentsDesk.jsx"), "js");
const admin = stripComments(read("app/admin/page.jsx"), "js");
const rpcs = [...(lib + desk + page).matchAll(/["'](admin_[a-z_]+)["']/g)].map((x) => x[1]);
check("G30 every RPC the UI calls is one of the 5.3 reporting functions or the two existing admin actions",
  rpcs.length > 0 && rpcs.every((r) => PUB.includes(r) || r === "admin_clear_transfer_review" || r === "admin_set_seller_payout_account"), [...new Set(rpcs)]);
check("G31 the desk performs no direct table writes and no service client", !/\.from\(\s*["'`]\w+["'`]\s*\)\s*\.(insert|update|delete|upsert)/.test(lib + desk + page) && !/service-client|SUPABASE_SERVICE_ROLE_KEY|createServiceClient/.test(lib + desk + page + admin));
check("G32 no Razorpay call and no reconcile button from the desk", !/razorpay\.com|razorpay-client|\breconcile\b|runReconciliation|fetch\(/i.test(lib + desk + page));
check("G33 the page gates on login, admin and aal2 before loading any data", /getAdminGate/.test(page) && page.indexOf("gate.allowed") > 0 && page.indexOf("gate.allowed") < page.indexOf("getAttention(") && page.indexOf("gate.isAdmin") > 0 && page.indexOf("gate.isAdmin") < page.indexOf("getAttention(") && page.indexOf("gate.allowed") > page.indexOf("gate.isAdmin"));
check("G34 the page is dynamic (never cached)", /export const dynamic = "force-dynamic"/.test(page));
check("G35 the nav badge calls the count helper, renders it only when positive, and links to /admin/payments", /await getAttentionCount\(supabase\)/.test(admin) && /paymentAttention > 0/.test(admin) && /href="\/admin\/payments"/.test(admin));
check("G36 the desk does not use dangerouslySetInnerHTML", !/dangerouslySetInnerHTML/.test(desk));
check("G37 clearing a review is wired only to parked transfers", /i\.kind === "parked_transfer"[\s\S]{0,200}clearReview/.test(desk));
check("G38 the desk states the figures are not reconciled with Razorpay", /not reconciled against Razorpay/.test(read("components/AdminPaymentsDesk.jsx")));
check("G39 money is formatted from integers only", /Number\.isInteger\(paise\)/.test(lib) && !/toFixed\(/.test(lib + desk));
check("G40 the desk does not print internal secrets or call env vars", !/process\.env/.test(lib + desk + page));
check("G41 the 5.3 tests are registered in run-all", ["m53-db", "m53-logic", "m53-guardrails"].every((s) => read("tests/phase5/run-all.mjs").includes(s + ".test.mjs")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
