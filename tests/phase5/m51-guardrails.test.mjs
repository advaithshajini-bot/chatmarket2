// A51-G -- static guardrails for Milestone 5.1 (reads source files; no database, no network).
// Run:  node tests/phase5/m51-guardrails.test.mjs
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

const MIG = "supabase/migrations/20261012100000_add_payment_fulfilment.sql";
const m = sql(MIG);
const lower = m.toLowerCase();

// ---------------------------------------------------------------- migration: additive and locked down
check("G01 the migration file exists and sorts AFTER every earlier migration (5.2's migration may sort after it)",
  exists(MIG) && fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql") && (f < "20261013")).sort().at(-1) === path.basename(MIG));
check("G02 additive only: no DROP, TRUNCATE or DELETE statements", !/\b(drop|truncate)\s+(table|function|policy|index|column|schema|trigger|type)\b/.test(lower) && !/\bdelete\s+from\b/.test(lower) && !/\btruncate\b/.test(lower));
check("G03 every ALTER TABLE targets only the two NEW tables (and only enables RLS)",
  [...lower.matchAll(/alter\s+table\s+([\w.]+)\s+([^;]+);/g)].every((x) => /^public\.(payment_orders|webhook_events)$/.test(x[1]) && /^enable row level security$/.test(x[2].trim())), [...lower.matchAll(/alter\s+table[^;]+;/g)].map((x) => x[0]));
check("G04 the migration never UPDATEs / INSERTs into existing business tables directly (only inside the fulfil function it inserts purchases + audit_log)",
  !/\bupdate\s+public\.(purchases|listings|profiles|payouts|disputes|entitlements)\b/.test(lower));
check("G05 it does not create, drop or alter any policy on public.purchases", !/policy\s+"[^"]*"\s+on\s+public\.purchases/.test(lower) && !/on\s+public\.purchases\s+(for|to)/.test(lower));
check("G06 it never references feature flags", !/feature_flags|is_execution_enabled|phase3_execution|phase4_/.test(lower));
const fnDefs = [...lower.matchAll(/create function (public\.\w+)\(/g)].map((x) => x[1]);
check("G07 exactly the four expected functions are created", fnDefs.sort().join() === "public.begin_webhook_event,public.fulfil_captured_payment,public.finish_webhook_event,public.record_payment_order".split(",").sort().join(), fnDefs);
for (const fn of fnDefs) {
  const body = lower.slice(lower.indexOf(`create function ${fn}(`)).split(/\n\$\$;/)[0] + "\n$$;";
  check(`G08 ${fn}: SECURITY DEFINER with search_path = ''`, /security definer/.test(body) && /set search_path = ''/.test(body));
  check(`G09 ${fn}: every table it touches is schema-qualified (public.*)`,
    ![...body.matchAll(/\b(?:from|into|update|join)\s+(?!public\.|\(|pg_|jsonb_|v_)([a-z_][a-z0-9_]*)\b/g)].some((x) => !["found", "select"].includes(x[1])),
    [...body.matchAll(/\b(?:from|into|update|join)\s+(?!public\.|\(|pg_|jsonb_|v_)([a-z_][a-z0-9_]*)\b/g)].map((x) => x[1]));
  check(`G10 ${fn}: REVOKEd from public, anon, authenticated and GRANTed to service_role only`,
    new RegExp(`revoke all on function ${fn.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated;`).test(lower)
    && new RegExp(`grant execute on function ${fn.replace(".", "\\.")}\\([^)]*\\) to service_role;`).test(lower));
}
check("G11 nothing in the migration grants a function to anon or authenticated", !/grant\s+execute[^;]*\bto\s+[^;]*\b(anon|authenticated)\b/.test(lower));
check("G12 only SELECT is granted on the new tables, and only to authenticated (RLS: admins)", [...lower.matchAll(/grant\s+(\w+)\s+on\s+public\.(payment_orders|webhook_events)\s+to\s+(\w+)/g)].every((x) => x[1] === "select" && x[3] === "authenticated"));
check("G13 both new tables have RLS enabled and an admin-only SELECT policy",
  /alter table public\.payment_orders enable row level security/.test(lower) && /alter table public\.webhook_events enable row level security/.test(lower)
  && (lower.match(/for select to authenticated using \(\(select private\.is_admin\(\)\)\)/g) ?? []).length === 2);
check("G14 webhook_events stores a hash, not a payload: no payload/body/raw/json column", !/\b(payload|body|raw_body|raw_payload)\s+(jsonb|json|text)\b/.test(lower) && /payload_sha256/.test(lower));
check("G15 the new error code CM070 is used by this migration and by no OTHER migration", read(MIG).includes("CM070")
  && fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql") && f !== path.basename(MIG)).every((f) => !read(`supabase/migrations/${f}`).includes("CM070")));
check("G16 purchases are inserted in exactly ONE place in all migrations: inside fulfil_captured_payment",
  fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).flatMap((f) => [...sql(`supabase/migrations/${f}`).toLowerCase().matchAll(/insert\s+into\s+public\.purchases/g)].map(() => f)).join() === path.basename(MIG));
check("G17 amount mismatch is compared with <> against the ORDER amount, and the purchase amount is derived from the order (not a parameter)",
  /p_amount_paise <> v_order\.amount_paise/.test(lower) && /v_amount := v_order\.amount_paise \/ 100\.0/.test(lower));
check("G18 fulfilment takes an advisory lock keyed on the payment id before reading", /pg_advisory_xact_lock\(hashtextextended\('payment:' \|\| p_payment_id/.test(lower));

// ---------------------------------------------------------------- manual script
const man = "supabase/manual/phase5_close_purchase_insert_policy.sql";
check("G20 the policy-closing script is under supabase/manual (NOT a migration) and is a single transaction", exists(man) && !exists("supabase/migrations/" + path.basename(man))
  && /^\s*begin;/im.test(sql(man)) && /commit;\s*$/i.test(sql(man).trim()));
check("G21 it drops only the INSERT policy and revokes only INSERT", /drop policy if exists "users can create their own purchases" on public\.purchases;/i.test(sql(man)) && /revoke insert on public\.purchases from anon, authenticated;/i.test(sql(man)) && !/select/i.test(sql(man)));
check("G22 no migration drops that policy (it must stay a deliberate manual step)", fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).every((f) => !/drop policy[^;]*users can create their own purchases/i.test(read(`supabase/migrations/${f}`))));

// ---------------------------------------------------------------- webhook route: glue only
const wr = js("app/api/razorpay/webhook/route.js");
check("G30 the webhook route reads the RAW body with request.text() and never request.json()", /request\.text\(\)/.test(wr) && !/request\.json\(/.test(wr));
check("G31 it reads the raw body BEFORE calling the handler", wr.indexOf("request.text()") > -1 && wr.indexOf("request.text()") < wr.indexOf("handleRazorpayWebhook("));
check("G32 it is glue only: no crypto, no JSON.parse, no direct db calls", !/crypto|JSON\.parse|\.rpc\(|\.from\(/.test(wr));
check("G33 it exports POST only (no GET etc.), is dynamic, runs on node, and sends Cache-Control: no-store",
  /export async function POST/.test(wr) && !/export async function (GET|PUT|DELETE|PATCH)/.test(wr) && /dynamic = "force-dynamic"/.test(wr) && /runtime = "nodejs"/.test(wr) && /no-store/.test(wr));
check("G34 it uses RAZORPAY_WEBHOOK_SECRET (not the key secret) and fails closed with 500 when unset", /process\.env\.RAZORPAY_WEBHOOK_SECRET/.test(wr) && /\bsecret,/.test(wr) && !/secret:\s*(process\.env\.RAZORPAY_KEY_SECRET|keySecret)/.test(wr) && /!secret/.test(wr) && /status: 500/.test(wr));
check("G35 the webhook path is not behind the login middleware (middleware.js excludes /api/)", /api\//.test(read("middleware.js").split("matcher")[1] ?? ""));

// ---------------------------------------------------------------- signature + handler hygiene
const sig = js("lib/payments/webhook-signature.js"), hand = js("lib/payments/webhook-handler.js");
check("G40 signature check is constant-time (timingSafeEqual) with a length guard", /timingSafeEqual/.test(sig) && /expected\.length === given\.length/.test(sig));
check("G41 the signature is computed over the raw string with HMAC-SHA256 (not over re-serialised JSON)", /createHmac\("sha256"/.test(sig) && !/JSON\.stringify/.test(sig));
check("G42 the handler verifies the signature BEFORE parsing JSON or touching the db", hand.indexOf("verifyWebhookSignature(") > -1 && hand.indexOf("verifyWebhookSignature(") < hand.indexOf("JSON.parse") && hand.indexOf("JSON.parse") < hand.indexOf("db.beginEvent"));
check("G43 the handler never logs: no console.* anywhere in lib/payments", walk("lib/payments").every((f) => !/console\./.test(js(f))));
check("G44 only ids and the body hash are passed to the db: the handler never reads email / contact / card / vpa / notes", !/email|contact|\bcard\b|\bvpa\b|\.notes|customer/i.test(hand));
check("G45 only payment.captured and order.paid fulfil; there is no path from payment.authorized / payment.failed to fulfil", /HANDLED_EVENTS = \["payment\.captured", "order\.paid"\]/.test(hand) && /status !== "captured"/.test(hand));
check("G46 the handler cannot pass an expected user (the order row is the only authority)", /expectedUserId: null/.test(hand));

// ---------------------------------------------------------------- service client confinement
const files = [...walk("app"), ...walk("components"), ...walk("lib")].map((f) => f.replace(/\\/g, "/"));
const users = files.filter((f) => /payments\/service-client/.test(read(f)) && !f.endsWith("service-client.js"));
check("G50 the service-role client is imported ONLY from app/api route handlers", users.length > 0 && users.every((f) => f.startsWith("app/api/") && /route\.js$/.test(f)), users);
check("G51 no 'use client' file imports anything from lib/payments", files.filter((f) => /^\s*["']use client["']/m.test(read(f))).every((f) => !/lib\/payments/.test(read(f))));
check("G52 SUPABASE_SERVICE_ROLE_KEY appears only in service-client.js (+ the Edge Function that already had it), never as NEXT_PUBLIC_",
  files.filter((f) => read(f).includes("SUPABASE_SERVICE_ROLE_KEY")).map((f) => f.replace(/\\/g, "/")).join() === "lib/payments/service-client.js" && !/NEXT_PUBLIC_[A-Z_]*SERVICE/.test(files.map(read).join("\n")));
check("G53 service-client does not persist sessions", /persistSession: false/.test(js("lib/payments/service-client.js")));
check("G54 @supabase/supabase-js is a declared dependency", !!JSON.parse(read("package.json")).dependencies?.["@supabase/supabase-js"]);

// ---------------------------------------------------------------- checkout routes
const vp = js("app/api/razorpay/verify-payment/route.js"), co = js("app/api/razorpay/create-order/route.js");
check("G60 verify-payment no longer inserts purchases itself", !/\.from\(\s*["']purchases["']\s*\)/.test(vp) && !/\.insert\(/.test(vp) && /\.fulfil\(/.test(vp));
check("G61 verify-payment still checks the signature (constant-time) before doing anything else with the payment",
  /timingSafeEqual/.test(vp) && vp.indexOf("timingSafeEqual") < vp.indexOf("createServiceClient()") && vp.indexOf("timingSafeEqual") < vp.indexOf(".fulfil("));
check("G62 verify-payment passes the LOGGED-IN user as expectedUserId and takes no listing id / price / amount from the request body",
  /expectedUserId: userData\.user\.id/.test(vp) && !/listingId|\.price/.test(vp.split("const { razorpay_order_id")[1].split("\n")[0] + vp.split("fulfil(")[1]));
check("G63 verify-payment still requires a logged-in user (401)", /status: 401/.test(vp) && /auth\.getUser\(\)/.test(vp));
check("G64 create-order records the order BEFORE it returns the order id to the browser", co.indexOf("recordPaymentOrder(") > -1 && co.indexOf("recordPaymentOrder(") < co.lastIndexOf("orderId: razorpayData.id"));
check("G65 create-order refuses (no order id returned) when the order cannot be recorded", /catch \{\s*return NextResponse\.json\([^)]*status: 502/.test(co.replace(/\n/g, " ")) || /Couldn't start checkout/.test(co));
check("G66 create-order still prices from the DB and keeps the existing guards (live listing, already-owned 409)", /status !== "live"/.test(co) && /status: 409/.test(co) && /Number\(listing\.price\) \* 100/.test(co));
check("G67 NO code anywhere in app/, components/ or lib/ inserts into purchases (all purchases come from the database function)",
  files.every((f) => !/\.from\(\s*["']purchases["']\s*\)\s*\.insert/.test(read(f).replace(/\s+/g, " "))));

// ---------------------------------------------------------------- feature flags / existing surface untouched
const newCode = ["lib/payments/webhook-signature.js", "lib/payments/webhook-handler.js", "lib/payments/db.js", "lib/payments/fulfilment.js", "lib/payments/service-client.js", "app/api/razorpay/webhook/route.js"].map(js).join("\n");
check("G70 no feature flag is read or written by the new code", !/feature_flags|phase3_execution|phase4_/.test(newCode));
check("G71 PLATFORM_FEE_PCT has a single definition (lib/constants.js) and the routes import it", (read("lib/constants.js").match(/PLATFORM_FEE_PCT\s*=/g) ?? []).length === 1 && /PLATFORM_FEE_PCT/.test(vp) && /PLATFORM_FEE_PCT/.test(wr));

console.log(`\nA51-G: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
