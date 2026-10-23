// A53b-G -- static guardrails for Milestone 5.3 part 2 (seller payout status). Reads source; no database, no network.
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
const MIG = "supabase/migrations/20261016100000_add_seller_payout_status.sql";
const m = stripComments(read(MIG), "sql"), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

check("G01 the migration sorts after 5.3 part 1; only the Phase 6 revoke may follow", migs.slice(migs.indexOf(path.basename(MIG)) + 1).every((f) => f === "20261017100000_revoke_self_set_payout_account.sql" || f === "20261018100000_add_vpa_payouts.sql" || /^(20261019|202610[23]\d)/.test(f)));
check("G02 additive and read-only: no DDL other than the one function, no writes", !/\b(drop\s|alter\s|truncate|insert\s+into|update\s+public|delete\s+from|create\s+(table|index|policy|trigger|extension|view|type))/.test(lower) && (lower.match(/create function/g) || []).length === 1);
check("G03 SECURITY DEFINER, search_path '', STABLE", /security definer/.test(lower) && /set search_path = ''/.test(lower) && /\bstable\b/.test(lower));
check("G04 one parameter only (a limit): no seller id can be passed", /create function public\.seller_payout_status\(p_limit integer default 100\)/.test(lower));
check("G05 identity comes from auth.uid() and anonymous callers are refused (42501) before any read", /v_uid\s+uuid := \(select auth\.uid\(\)\)/.test(lower) && lower.indexOf("v_uid is null") > 0 && lower.indexOf("v_uid is null") < lower.indexOf("from public.seller_payout_accounts"));
check("G06 every row is filtered to the caller's own listings", /where l\.seller_id = v_uid/.test(lower));
check("G07 granted to authenticated only", /revoke all on function public\.seller_payout_status\(integer\) from public, anon, authenticated;/.test(lower) && /grant execute on function public\.seller_payout_status\(integer\) to authenticated;/.test(lower) && !/to (anon|service_role|public)/.test(lower));
// the SELECT list: none of the sensitive columns may appear inside the jsonb_build_object calls that form the response
const out = lower.slice(lower.indexOf("select\n    coalesce((select jsonb_agg"));
check("G08 the response is built from an allow-list: no ids, errors, review text, dispute text or names", !/razorpay_|\.error\b|review_reason\s*[,)]\s*c\./.test(out) && !/'(razorpay|error|review|reason|note|attempts|buyer|account_id)/.test(out.replace(/'account_status'/g, "")), out.slice(0, 80));
check("G09 review_reason is only tested for NULL, never returned", !/'review_reason'/.test(lower) && /review_reason is not null/.test(lower));
check("G10 the dispute reason/note columns are never selected", !/d\.reason|d\.resolution_note|resolution_note/.test(lower));
check("G11 error code CM074 is new", /CM074/.test(m) && migs.filter((f) => f !== path.basename(MIG) && f !== "20261018100000_add_vpa_payouts.sql" && !/^(20261019|202610[23]\d)/.test(f)).every((f) => !read("supabase/migrations/" + f).includes("CM074")));
check("G12 no flag or secret is referenced", !/feature_flags|is_route_transfers_enabled|razorpay_key|webhook_secret|service_role_key|cron_secret/.test(lower));

const lib = stripComments(read("lib/domain/seller-payouts.js"), "js");
const panel = stripComments(read("components/SellerPayoutPanel.jsx"), "js");
const client = stripComments(read("components/SellerEarningsClient.jsx"), "js");
const page = stripComments(read("app/sell/earnings/page.jsx"), "js");
check("G20 the seller code calls only seller_payout_status (no admin RPCs, no direct table reads of ledger tables)", /"seller_payout_status"/.test(lib) && !/admin_/.test(lib + panel + client + page) && !/\.from\(\s*["'`](transfers|refunds|webhook_events|seller_payout_accounts|disputes)["'`]/.test(lib + panel + client + page));
check("G21 no service client in the seller code", !/service-client|SUPABASE_SERVICE_ROLE_KEY|createServiceClient/.test(lib + panel + client + page));
check("G22 the seller UI never imports admin code", !/admin-payments|AdminPayments/.test(lib + panel + client + page));
check("G23 the panel renders only status codes' words, dates and amounts; no raw error/id fields", !/\.(error_text|review_reason|razorpay\w*|attempts|reason)\b/.test(panel) && !/dangerouslySetInnerHTML/.test(panel));
check("G24 loader errors are never surfaced to the page (fixed message only)", !/error\.message|error\.details|\.message/.test(lib) && /couldn&apos;t load your payout status/.test(read("components/SellerPayoutPanel.jsx")));
check("G25 the earnings page loads settlement status through the loader and passes it on (5.5 replaced the instant-payout view)", /await getSellerSettlementStatus\(supabase\)/.test(page) && /settlement=\{settlement\}/.test(page) && /SellerPayoutPanel settlement=\{settlement\}/.test(client));
check("G26 the old 'No real payouts yet' placeholder is gone", !/PayoutsPlaceholder|No real payouts yet/.test(client));
check("G27 the needs-account state links to the payout setup page", /href="\/sell\/payout"/.test(panel));
check("G28 money is formatted from integer paise only", /from "@\/lib\/domain\/paise"/.test(panel) && !/toFixed\(|toLocaleString\(/.test(panel + lib));
check("G29 the 5.3b tests are registered in run-all", ["m53b-db", "m53b-logic", "m53b-guardrails"].every((s) => read("tests/phase5/run-all.mjs").includes(s + ".test.mjs")));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
