// Mutation check for Milestone 5.1: break the code on purpose; the suites MUST fail. Run as the postgres OS user:
//   node run-mutations.mjs <repoDir>   (needs template DB m5tpl = stub + the real pre-5.1 migrations)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/home/claude/work/m5/mut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261012100000_add_payment_fulfilment.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const SQLM = [
  ["amount check weakened (<> -> <)", "p_amount_paise <> v_order.amount_paise", "p_amount_paise < v_order.amount_paise", "db"],
  ["user-mismatch check removed", "elsif p_expected_user_id is not null and p_expected_user_id <> v_order.user_id then", "elsif false then", "db"],
  ["listing-live check removed", "if not found or v_listing.status <> 'live' then", "if not found then", "db"],
  ["already-fulfilled lookup disabled", "select p.id into v_purchase from public.purchases p where p.razorpay_payment_id = p_payment_id;\n  if found then", "select p.id into v_purchase from public.purchases p where false;\n  if found then", "db"],
  ["duplicate_payment branch disabled", "if found then\n          v_outcome := 'duplicate_payment';", "if false then\n          v_outcome := 'duplicate_payment';", "db"],
  ["fulfil granted to authenticated", "uuid, text) to service_role;", "uuid, text) to service_role, authenticated;", "db"],
  ["fulfil_captured_payment not SECURITY DEFINER", "returns jsonb\nlanguage plpgsql\nsecurity definer", "returns jsonb\nlanguage plpgsql\nsecurity invoker", "db"],
  ["platform fee not applied", "round(v_amount * p_fee_pct, 2)", "v_amount", "db"],
  ["needs_review events retried instead of deduped", "if v_status in ('processed', 'ignored', 'needs_review') then", "if v_status in ('processed', 'ignored') then", "db"],
  ["finish_webhook_event can overwrite a finished event", "   and e.status in ('received', 'failed');\nend;\n$$;\n\n-- ----------------------------------------------------------------", "   ;\nend;\n$$;\n\n-- ----------------------------------------------------------------", "db"],
  ["admin-only SELECT policy opened to everyone (webhook_events)", "create policy \"Admins can view webhook events\" on public.webhook_events\n  for select to authenticated using ((select private.is_admin()));", "create policy \"Admins can view webhook events\" on public.webhook_events\n  for select to authenticated using (true);", "db"],
  ["event status mapping flipped", "case when v_outcome in ('fulfilled', 'already_fulfilled') then 'processed' else 'needs_review' end", "case when v_outcome in ('fulfilled', 'already_fulfilled') then 'needs_review' else 'processed' end", "db"],
  ["purchase amount taken from the request instead of the order", "v_amount := v_order.amount_paise / 100.0;", "v_amount := p_amount_paise / 100.0;", "db"],
  ["currency check removed", "or p_currency is distinct from 'INR'", "", "db"],
  ["advisory lock removed from begin_webhook_event AND unique violation unhandled is NOT testable here", null],
];
const JSM = [
  ["signature check accepts a missing header", "lib/payments/webhook-signature.js", 'if (!/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;', 'if (!signatureHeader) return true;', "logic"],
  ["signature compare not constant-time", "lib/payments/webhook-signature.js", "crypto.timingSafeEqual(expected, given)", "expected.equals(given)", "guard"],
  ["event-type gate removed AND payload ungated", "lib/payments/webhook-handler.js", "const payment = HANDLED_EVENTS.includes(eventType) ? extractPayment(body) : null;", "const payment = extractPayment(body);", "logic", ["if (!HANDLED_EVENTS.includes(eventType)) {", "if (false) {"]],
  ["event-type gate removed only", "lib/payments/webhook-handler.js", "if (!HANDLED_EVENTS.includes(eventType)) {", "if (false) {", "logic"],
  ["non-captured payments accepted", "lib/payments/webhook-handler.js", 'if (p.status !== "captured") return null;', "", "logic"],
  ["db failure answered 200 (Razorpay would never retry)", "lib/payments/webhook-handler.js", 'return { status: 500, json: { error: "temporary failure" } };', 'return { status: 200, json: { ok: true } };', "logic"],
  ["duplicate events processed again", "lib/payments/webhook-handler.js", 'if (begun === "duplicate") return', 'if (begun === "never") return', "logic"],
  ["body size cap removed", "lib/payments/webhook-handler.js", "> MAX_BODY_BYTES", "> Infinity", "logic"],
  ["signature verified AFTER parsing", "lib/payments/webhook-handler.js", 'if (!verifyWebhookSignature(rawBody, h("x-razorpay-signature"), secret)) return { status: 400, json: { error: "invalid signature" } };', "", "logic"],
  ["unknown-order outcome reported as success to the buyer", "lib/payments/fulfilment.js", 'if (outcome === "order_unknown") return { status: 404,', 'if (outcome === "order_unknown") return { status: 200,', "logic"],
  ["isSuccess accepts duplicate_payment", "lib/payments/fulfilment.js", 'export const SUCCESS_OUTCOMES = ["fulfilled", "already_fulfilled"];', 'export const SUCCESS_OUTCOMES = ["fulfilled", "already_fulfilled", "duplicate_payment"];', "logic"],
  ["db wrapper drops the expected-user parameter", "lib/payments/db.js", "p_expected_user_id: expectedUserId ?? null, ", "", "logic"],
  ["db wrapper swallows rpc errors", "lib/payments/db.js", "if (error) { const e = new Error(error.message || \"rpc_error\"); e.code = error.code; throw e; }", "if (error) return null;", "logic"],
  ["webhook route parses JSON instead of raw text", "app/api/razorpay/webhook/route.js", "const rawBody = await request.text();", "const rawBody = JSON.stringify(await request.json());", "guard"],
  ["verify-payment inserts purchases itself again", "app/api/razorpay/verify-payment/route.js", "const service = createServiceClient();", "const service = createServiceClient(); await supabase.from(\"purchases\").insert({});", "guard"],
  ["create-order returns the order before recording it", "app/api/razorpay/create-order/route.js", "await createPaymentsDb(service).recordPaymentOrder({", "void (async()=>{})({", "guard"],
  ["webhook handler logs the payload", "lib/payments/webhook-handler.js", "const eventId = str(", "console.log(rawBody); const eventId = str(", "guard"],
  ["verify-payment stops passing the logged-in user", "app/api/razorpay/verify-payment/route.js", "expectedUserId: userData.user.id,", "expectedUserId: null,", "guard"],
  ["service client imported from a client component", null, null, null, "special"],
];
const run = (kind) => {
  if (kind === "db") {
    sh(`dropdb --if-exists m5mut; createdb -T m5tpl m5mut; psql -v ON_ERROR_STOP=1 -q -d m5mut -f ${work}/${MIG}`);
    return sh(`DATABASE_URL='postgres://postgres@/m5mut?host=/var/run/postgresql' ${node} tests/phase5/m51-db.test.mjs`, work);
  }
  if (kind === "logic") return sh(`${node} tests/phase5/m51-logic.test.mjs`, work);
  return sh(`${node} tests/phase5/m51-guardrails.test.mjs`, work);
};
let killed = 0, total = 0; const survivors = [];
const mutate = (file, from, to, kind, label, extra) => {
  const src = orig(file);
  if (!src.includes(from) || (extra && !src.includes(extra[0]))) { console.log(`!! ${label}: pattern NOT FOUND (fix the mutation)`); survivors.push(`${label} (pattern missing)`); total++; return; }
  let mutated = src.replace(from, to); if (extra) mutated = mutated.replace(extra[0], extra[1]);
  fs.writeFileSync(path.join(work, file), mutated);
  const r = run(kind);
  fs.writeFileSync(path.join(work, file), src);
  const out = `${r.stdout}${r.stderr}`; const dead = r.status !== 0 || /^FAIL:/m.test(out);
  total++; if (dead) killed++; else survivors.push(label);
  console.log(`${dead ? "killed  " : "SURVIVED"}  [${kind}] ${label}${dead ? "  <- " + (out.match(/^FAIL: (\S+)/m)?.[1] ?? "error") : ""}`);
};
for (const [label, from, to, kind] of SQLM) { if (from === null) continue; mutate(MIG, from, to, kind, label); }
for (const [label, file, from, to, kind, extra] of JSM) {
  if (kind === "special") continue;
  mutate(file, from, to, kind, label, extra);
}
// special: a 'use client' component importing the service client
{
  const f = "components/__mut_client.jsx"; fs.writeFileSync(path.join(work, f), `"use client";\nimport { createServiceClient } from "@/lib/payments/service-client";\nexport default function X(){return null}\n`);
  const r = run("guard"); fs.rmSync(path.join(work, f)); const dead = r.status !== 0; total++; if (dead) killed++; else survivors.push("service client in client component");
  console.log(`${dead ? "killed  " : "SURVIVED"}  [guard] service client imported from a client component`);
}
console.log(`\nmutants killed: ${killed}/${total}`); if (survivors.length) console.log("survivors:", survivors);
