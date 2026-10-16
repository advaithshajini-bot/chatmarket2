// A52-G -- static guardrails for Milestone 5.2 (Route transfers) (reads source files; no database, no network).
// Run:  node tests/phase5/m52-guardrails.test.mjs
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

const MIG = "supabase/migrations/20261013100000_add_route_transfers.sql";
const m = sql(MIG), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql"));

// ---------------------------------------------------------------- migration
check("G01 the 5.2 migration exists and only the 5.2c and 5.3 migrations sort after it", exists(MIG) && migs.filter((f) => f > path.basename(MIG)).every((f) => f.startsWith("20261014") || f.startsWith("20261015")));
check("G02 additive only: no DROP / TRUNCATE / DELETE statements", !/\b(drop|truncate)\s+(table|function|policy|index|column|schema|trigger|type)\b/.test(lower) && !/\bdelete\s+from\b/.test(lower) && !/\btruncate\b/.test(lower));
check("G03 every ALTER TABLE targets only the two NEW tables and only enables RLS",
  [...lower.matchAll(/alter\s+table\s+([\w.]+)\s+([^;]+);/g)].every((x) => /^public\.(seller_payout_accounts|transfers)$/.test(x[1]) && /^enable row level security$/.test(x[2].trim())), [...lower.matchAll(/alter\s+table[^;]+;/g)].map((x) => x[0]));
check("G04 it creates exactly two tables", [...lower.matchAll(/create table ([\w.]+)/g)].map((x) => x[1]).sort().join() === "public.seller_payout_accounts,public.transfers");
check("G05 it creates no policy on, and never alters, any pre-existing table", [...lower.matchAll(/create policy\s+"[^"]*"\s+on\s+([\w.]+)/g)].every((x) => /^public\.(seller_payout_accounts|transfers)$/.test(x[1])));
const purchUpdates = [...lower.matchAll(/update public\.purchases pu\s+set\s+([^;]*?)\s+where/gs)].map((x) => x[1]);
check("G06 the only write to an existing business table is purchases.razorpay_transfer_id / transfer_status",
  purchUpdates.length >= 1 && purchUpdates.every((s) => [...s.matchAll(/(\w+)\s*=/g)].map((x) => x[1]).every((c) => ["razorpay_transfer_id", "transfer_status"].includes(c)))
  && !/\b(update|insert into)\s+public\.(listings|profiles|payouts|disputes|entitlements|payment_orders)\b/.test(lower), purchUpdates);
check("G07 the flag is seeded OFF and is the only feature_flags row touched; it is never updated",
  [...lower.matchAll(/insert into private\.feature_flags[^;]*;/g)].length === 1 && /values \('phase5_route_transfers', false\)/.test(lower) && !/update private\.feature_flags/.test(lower));
check("G08 the flag read fails closed (is_route_transfers_enabled coalesces to false)", /coalesce\([^)]*enabled[^)]*false\)|coalesce\(\(select[^;]*false\)/s.test(lower) || /is_route_transfers_enabled\(\)[\s\S]{0,400}coalesce/.test(lower));
const fnDefs = [...lower.matchAll(/create function ((?:public|private)\.\w+)\(/g)].map((x) => x[1]);
check("G09 every function pins search_path = ''; all are SECURITY DEFINER except the pure immutable status mapper", fnDefs.length === 8 && [...lower.matchAll(/create function[\s\S]*?\$\$;/g)].every((b) => /set search_path = ''/.test(b[0]) && (/security definer/.test(b[0]) || /create function private\.purchase_transfer_status[\s\S]*immutable/.test(b[0]))), fnDefs);
const pubFns = fnDefs.filter((f) => f.startsWith("public."));
check("G10 every public function revokes from public/anon/authenticated", pubFns.every((f) => new RegExp(`revoke all on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated`).test(lower)), pubFns);
check("G11 every private function revokes from everyone", fnDefs.filter((f) => f.startsWith("private.")).every((f) => new RegExp(`revoke execute on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role`).test(lower)));
const grants = [...lower.matchAll(/grant execute on function (public\.\w+)\([^)]*\) to (\w+)/g)].map((x) => [x[1], x[2]]);
check("G12 only service_role may execute the transfer functions; only the admin RPC is granted to authenticated",
  grants.length === 6 && grants.every(([f, r]) => (f === "public.admin_set_seller_payout_account" ? r === "authenticated" : r === "service_role")), grants);
check("G13 the admin RPC checks admin + MFA (aal2) as its first statement", /create function public\.admin_set_seller_payout_account[\s\S]*?begin\s+if not \(select private\.is_admin_mfa\(\)\)/.test(lower));
check("G14 the admin RPC writes an audit_log row", /admin_set_seller_payout_account[\s\S]*?insert into public\.audit_log[\s\S]*?payout_account_set/.test(lower));
check("G15 authenticated users get SELECT only on the new tables (no insert/update/delete)", !/grant\s+(insert|update|delete|all)[^;]*on\s+public\.(transfers|seller_payout_accounts)[^;]*to\s+(authenticated|anon)/.test(lower) && /revoke all on public\.transfers from anon, authenticated/.test(lower) && /revoke all on public\.seller_payout_accounts from anon, authenticated/.test(lower));
check("G16 RLS is enabled on both tables", /alter table public\.transfers enable row level security/.test(lower) && /alter table public\.seller_payout_accounts enable row level security/.test(lower));
check("G17 one transfer per purchase is enforced by the database: transfers.purchase_id is NOT NULL UNIQUE", /purchase_id\s+uuid not null unique references public\.purchases/.test(lower));
check("G18 razorpay_transfer_id is unique", /razorpay_transfer_id text unique/.test(lower));
check("G19 the account id format is constrained to acc_...", /razorpay_account_id\s+text[^,]*check \(razorpay_account_id ~ '\^acc_/.test(lower));
check("G20 the new error code CM071 is used by this migration and by no OTHER migration (5.2c may re-state plan_transfer)", read(MIG).includes("CM071")
  && migs.filter((f) => f !== path.basename(MIG) && !f.startsWith("20261014")).every((f) => !read(`supabase/migrations/${f}`).includes("CM071")));
check("G21 eligibility never reads the self-service profiles.razorpay_linked_account_id", !/razorpay_linked_account_id|razorpay_account_status/.test(lower));
check("G22 the migration carries rollback SQL in its header", /rollback/i.test(read(MIG).slice(0, 3000)) && /drop table public\.transfers/.test(read(MIG)));
check("G23 plan_transfer checks the flag before doing anything else", /create function public\.plan_transfer[\s\S]*?is_route_transfers_enabled\(\)[\s\S]*?'disabled'/.test(lower));
check("G24 the state machine refuses to leave terminal states (failed, reversed) and never moves a rank backwards", /v_t\.status in \('failed', 'reversed'\)/.test(lower) && /v_rank_new < v_rank_old/.test(lower));
check("G25 a settled transfer stays settled and released", /v_t\.settlement_status = 'settled' then 'settled'/.test(lower) && /v_t\.settlement_status = 'settled' then false/.test(lower));

// ---------------------------------------------------------------- app code
const clientSrc = js("lib/payments/razorpay-client.js");
const appFiles = [...walk("lib"), ...walk("app"), ...(exists("middleware.js") ? ["middleware.js"] : [])];
const withRoute = appFiles.filter((f) => /\/v1\/transfers|\/v1\/payments\/[^`"']*\/transfers/.test(js(f)));
check("G30 the Route API (/v1/payments/:id/transfers, /v1/transfers/:id) is spoken in exactly one file (razorpay-client.js)", withRoute.length === 1 && withRoute[0] === "lib/payments/razorpay-client.js", withRoute);
check("G31 the Razorpay client takes an injectable fetch, never reads env vars, never logs", /fetchImpl/.test(clientSrc) && !/process\.env/.test(clientSrc) && !/console\./.test(clientSrc));
check("G32 the Razorpay client authenticates with Basic auth built from the injected id/secret only", /Basic /.test(clientSrc) && /keyId\}:\$\{keySecret/.test(clientSrc));
const newLibs = ["lib/payments/razorpay-client.js", "lib/payments/transfers.js", "lib/payments/transfer-events.js", "lib/payments/sweep-handler.js", "lib/payments/db.js", "lib/payments/webhook-handler.js"];
check("G33 no console.* anywhere in the new payment code or routes", [...newLibs, "app/api/payments/transfers/sweep/route.js", "app/api/razorpay/webhook/route.js"].every((f) => !/console\./.test(js(f))));
check("G34 transfers.js and sweep-handler.js never touch fetch, env vars, the service client or Supabase directly", ["lib/payments/transfers.js", "lib/payments/sweep-handler.js", "lib/payments/transfer-events.js"].every((f) => !/\bfetch\(|process\.env|service-client|supabase/i.test(js(f))));
const sw = js("app/api/payments/transfers/sweep/route.js");
check("G35 the sweep route is glue only: small, CRON_SECRET, GET and POST, nodejs, no raw SQL, no logging", sw.split("\n").length < 40 && /process\.env\.CRON_SECRET/.test(sw) && /export const GET/.test(sw) && /export const POST/.test(sw) && /runtime = "nodejs"/.test(sw) && !/\.from\(|\.sql|console\./.test(sw));
check("G36 the sweep authenticates BEFORE it touches anything (handleSweepRequest wraps the sweep)", /handleSweepRequest\(/.test(sw) && sw.indexOf("handleSweepRequest(") < sw.indexOf("runReconciliation("));
const sh = js("lib/payments/sweep-handler.js");
check("G37 the bearer check hashes both sides and compares in constant time, and needs a >= 16 char secret", /timingSafeEqual/.test(sh) && /createHash\("sha256"\)/.test(sh) && /length < 16/.test(sh));
check("G38 the sweep fails closed (500) when CRON_SECRET is not configured", /!secret \|\| secret\.length < 16\) return \{ status: 500/.test(sh));
const users = appFiles.filter((f) => /service-client/.test(js(f)) && !f.endsWith("service-client.js"));
check("G39 the service-role client is imported ONLY from app/api route handlers", users.length > 0 && users.every((f) => f.startsWith("app/api/") && /route\.js$/.test(f)), users);
check("G40 the new routes are not in a client component and expose no NEXT_PUBLIC secret", !/NEXT_PUBLIC_[A-Z_]*(SECRET|SERVICE|KEY_SECRET)/.test([sw, js("app/api/razorpay/webhook/route.js")].join("\n")) && !/"use client"/.test(sw));
check("G41 no key, secret or webhook secret literal in the new code", ![...newLibs, "app/api/payments/transfers/sweep/route.js"].some((f) => /rzp_(test|live)_[A-Za-z0-9]{6,}|whsec_|sk_(live|test)_/.test(read(f))));
check("G42 the feature flag is toggled nowhere in app code (it is a database kill switch only)", appFiles.every((f) => !/phase5_route_transfers/.test(js(f))));
const wh = js("lib/payments/webhook-handler.js");
check("G43 transfer webhooks use only ids / statuses / amounts (the handler never reads notes, email, contact, card, vpa)", !/email|contact|\bcard\b|\bvpa\b|\.notes|customer/i.test(wh));
check("G44 transfer state is read from the entity, not from the event name", !/eventType\s*===\s*["']transfer\./.test(wh) && /TRANSFER_EVENT_RE\.test\(eventType\)/.test(wh));
check("G45 the after-fulfilment hook runs only after fulfilled / already_fulfilled and its failure is swallowed", /result\?\.outcome === "fulfilled" \|\| result\?\.outcome === "already_fulfilled"/.test(wh) && /try \{ await afterFulfil\(\{ purchaseId: result\.purchase_id \}\); \} catch/.test(wh));
const tr = js("lib/payments/transfers.js");
check("G46 creating a transfer is only reachable through a claim: createTransfer is called after planTransfer returns 'claimed'", tr.indexOf("planTransfer(") > -1 && tr.indexOf('plan?.outcome !== "claimed"') > -1 && tr.indexOf('plan?.outcome !== "claimed"') < tr.indexOf("rzp.createTransfer("));
check("G47 a possibly-reached attempt lists before it creates (lookup_first branch precedes createTransfer)", tr.indexOf("plan.lookup_first") > -1 && tr.indexOf("listPaymentTransfers(") < tr.indexOf("rzp.createTransfer("));
check("G48 createTransfer is called from exactly one place", (tr.match(/\.createTransfer\(/g) ?? []).length === 1 && appFiles.filter((f) => f !== "lib/payments/transfers.js" && f !== "lib/payments/razorpay-client.js").every((f) => !/\.createTransfer\(/.test(js(f))));
check("G49 the notes sent to Razorpay carry only the purchase id", /notes: \{ purchase_id: purchaseId \}/.test(tr));
check("G51 payment amounts are integer paise end to end in the migration (round(... * 100))", /round\(v_p\.amount \* 100\)/.test(lower) && /round\(coalesce\(v_p\.platform_fee, 0\) \* 100\)/.test(lower));
const wroute = js("app/api/razorpay/webhook/route.js");
check("G53 the webhook route wires the transfer hook: afterFulfil -> createTransferForPurchase, passed to the handler", /createTransferForPurchase\(\{ db, rzp, purchaseId \}\)/.test(wroute) && /const afterFulfil = rzp \?/.test(wroute) && /\bafterFulfil,/.test(wroute));
check("G54 BOTH new tables reject a malformed account id themselves (check constraint on razorpay_account_id)", (lower.match(/razorpay_account_id\s+text not null check \(razorpay_account_id ~ '\^acc_/g) ?? []).length === 2);

console.log(`\nA52-G: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
