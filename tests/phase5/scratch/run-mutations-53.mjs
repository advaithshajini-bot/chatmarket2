// Mutation check for Milestone 5.3 (part 1): break the code on purpose; the suites MUST fail. Run as the postgres OS user:
//   node run-mutations-53.mjs <repoDir>
// Needs template DB m53tpl = stub + every migration EXCEPT the 5.3 one.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/tmp/m53mut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261015100000_add_payout_reporting.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const URL = "postgres://postgres@/m53mut?host=/var/run/postgresql";
const SQLM = [
  ["parked bucket loses priority", "when p_review_reason is not null then 'parked'", "when false then 'parked'"],
  ["failed not its own bucket", "when p_status = 'failed'         then 'failed'", "when false then 'failed'"],
  ["settled not recognised", "when p_settlement = 'settled'    then 'settled'", "when false then 'settled'"],
  ["held/releasing swapped", "when p_on_hold                   then 'held'", "when not p_on_hold           then 'held'"],
  ["parked transfers dropped from attention", "where t.review_reason is not null\n      or t.status = 'failed'", "where t.status = 'failed'"],
  ["failed transfers dropped from attention", "      or t.status = 'failed'\n      or (t.status = 'creating'", "      or (t.status = 'creating'"],
  ["stuck threshold removed", "(t.status = 'creating' and t.updated_at < now() - interval '15 minutes')", "(t.status = 'creating')"],
  ["failed refunds dropped", "   where r.status = 'failed'\n      or (r.status = 'creating'", "   where (r.status = 'creating'"],
  ["pending refund threshold removed", "(r.status = 'pending'  and r.updated_at < now() - interval '1 day')", "(r.status = 'pending')"],
  ["processed refunds listed", "   where r.status = 'failed'\n      or (r.status = 'creating'", "   where true or (r.status = 'creating'"],
  ["dispute: hold check inverted", "and (t.on_hold is not true or t.hold_until is not null)", "and (t.on_hold is true and t.hold_until is null)"],
  ["dispute: age threshold removed", "and d.created_at < now() - interval '10 minutes'", ""],
  ["dispute: parked transfers also listed here", "     and t.review_reason is null\n     and t.status in", "     and t.status in"],
  ["webhook: 30-day window removed", "(w.status = 'needs_review' and w.received_at > now() - interval '30 days')", "(w.status = 'needs_review')"],
  ["webhook: failed listed immediately", "(w.status = 'failed' and w.received_at < now() - interval '1 hour' and w.received_at > now() - interval '30 days')", "(w.status = 'failed')"],
  ["attention: total is the capped length", "select count(*)::integer into v_total from private.payment_attention_rows();", "select least(count(*), p_limit)::integer into v_total from private.payment_attention_rows();"],
  ["attention: newest first", "jsonb_agg(x.j order by x.since asc)", "jsonb_agg(x.j order by x.since desc)"],
  ["attention: limit ignored", "       order by r.since asc\n       limit p_limit", "       order by r.since asc"],
  ["ledger: filter ignored in items", "       where p_bucket is null\n          or private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) = p_bucket\n       order by t.created_at desc, t.id", "       order by t.created_at desc, t.id"],
  ["ledger: total ignores filter", "   where p_bucket is null\n      or private.transfer_bucket(t.status, t.settlement_status, t.on_hold, t.review_reason) = p_bucket;", "   where true;"],
  ["ledger: offset ignored", "limit p_limit offset p_offset\n    ) x;\n\n  return jsonb_build_object('total', v_total, 'items', v_items);\nend;\n$$;\n\n-- ---------------------------------------------------------------- disputes", "limit p_limit\n    ) x;\n\n  return jsonb_build_object('total', v_total, 'items', v_items);\nend;\n$$;\n\n-- ---------------------------------------------------------------- disputes"],
  ["ledger: bucket allow-list removed", "(p_bucket is not null and p_bucket not in ('held', 'releasing', 'settled', 'reversed', 'failed', 'parked', 'creating'))", "false"],
  ["ledger: limit cap removed", "if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset is null or p_offset < 0\n     or (p_bucket", "if p_limit is null or p_limit < 1 or p_offset is null or p_offset < 0\n     or (p_bucket"],
  ["disputes: status filter ignored in items", "       where p_status is null or d.status = p_status\n       order by d.created_at desc, d.id", "       order by d.created_at desc, d.id"],
  ["disputes: refund join dropped", "left join public.refunds r on r.purchase_id = d.purchase_id", "left join public.refunds r on false"],
  ["timeline: webhook events of other purchases leak", "where w.purchase_id = p_purchase_id\n            or (v_p.razorpay_payment_id is not null and w.razorpay_payment_id = v_p.razorpay_payment_id)", "where true"],
  ["timeline: audit of other purchases leak", "where a.target_type = 'purchase' and a.target_id = p_purchase_id", "where a.target_type = 'purchase'"],
  ["timeline: unknown purchase raises instead of found=false", "return jsonb_build_object('found', false);", "raise exception 'x';"],
  ["balances: reversed counted as held", "coalesce(sum(net) filter (where b = 'held'), 0)      as held,", "coalesce(sum(net) filter (where b in ('held','reversed')), 0)      as held,"],
  ["balances: settled gross of reversals", "(t.amount_paise - t.amount_reversed_paise)::bigint as net", "t.amount_paise::bigint as net"],
  ["balances: failed not in attention", "filter (where b in ('failed', 'parked', 'creating')), 0) as needs_attention", "filter (where b in ('parked', 'creating')), 0) as needs_attention"],
  ["balances: awaiting counts purchases that already have a transfer", "and not exists (select 1 from public.transfers t where t.purchase_id = p.id)", ""],
  ["balances: awaiting counts unpaid", "where p.status = 'paid' and p.razorpay_payment_id is not null and l.seller_id is not null", "where l.seller_id is not null"],
  ["balances: payout-account-only sellers dropped", "    union select user_id from public.seller_payout_accounts\n", ""],
  ["balances: total is the capped length", "select (select count(*)::integer from sellers),", "select least((select count(*)::integer from sellers), p_limit),"],
  ["balances: attention sellers not first", "order by 1 desc, 2 desc, 3, 4\n       limit p_limit", "order by 3, 4\n       limit p_limit"],
  ["grant: attention to anon", "grant execute on function public.admin_payment_attention(integer) to authenticated;", "grant execute on function public.admin_payment_attention(integer) to authenticated, anon;"],
  ["grant: ledger to service_role", "grant execute on function public.admin_transfers_ledger(text, integer, integer) to authenticated;", "grant execute on function public.admin_transfers_ledger(text, integer, integer) to authenticated, service_role;"],
  ["grant: helper executable by authenticated", "revoke execute on function private.payment_attention_rows() from public, anon, authenticated, service_role;", ""],
  ["VOLATILE reporting function", "create function public.admin_seller_balances(p_limit integer default 200)\nreturns jsonb\nlanguage plpgsql\nstable", "create function public.admin_seller_balances(p_limit integer default 200)\nreturns jsonb\nlanguage plpgsql\nvolatile"],
];
// every MFA check removal, one per public function
for (const fn of ["admin_payment_attention_count()", "admin_payment_attention(p_limit integer default 200)", "admin_transfers_ledger(p_bucket text default null, p_limit integer default 100, p_offset integer default 0)",
  "admin_disputes_refunds(p_status text default null, p_limit integer default 100, p_offset integer default 0)", "admin_purchase_timeline(p_purchase_id uuid)", "admin_seller_balances(p_limit integer default 200)"]) {
  SQLM.push([`MFA check removed: ${fn.split("(")[0]}`, `create function public.${fn}`, `create function public.${fn}`, "mfa"]);
}
const JSM = [
  ["formatPaise uses floats", "lib/domain/paise.js", "if (!Number.isInteger(paise)) return \"—\";", "if (typeof paise !== \"number\") return \"—\";"],
  ["formatPaise drops the paise padding", "lib/domain/paise.js", "String(abs % 100).padStart(2, \"0\")", "String(abs % 100)"],
  ["ledger 'all' not mapped to null", "lib/domain/admin-payments.js", "p_bucket: bucket === \"all\" ? null : bucket", "p_bucket: bucket"],
  ["loader errors thrown, not soft", "lib/domain/admin-payments.js", "if (error || data == null) return { ...fallback, error: true };", "if (data == null) return { ...fallback, error: true };"],
  ["count trusts a non-integer", "lib/domain/admin-payments.js", "return error || !Number.isInteger(data) ? null : data;", "return error ? null : data;"],
  ["clear review hits the wrong RPC", "lib/domain/admin-payments.js", "\"admin_clear_transfer_review\"", "\"admin_set_seller_payout_account\""],
  ["page loads data before the aal2 gate", "app/admin/payments/page.jsx", "if (!gate.allowed) {", "if (false) {"],
  ["page not admin-gated", "app/admin/payments/page.jsx", "if (!gate.isAdmin) {", "if (false) {"],
  ["page cached", "app/admin/payments/page.jsx", "export const dynamic = \"force-dynamic\";", ""],
  ["Clear review offered on every row", "components/AdminPaymentsDesk.jsx", "{i.kind === \"parked_transfer\" && (", "{true && ("],
  ["nav badge removed", "app/admin/page.jsx", "const paymentAttention = await getAttentionCount(supabase);", "const paymentAttention = null;"],
  ["desk drops the reconciliation disclaimer", "components/AdminPaymentsDesk.jsx", "They are not reconciled against Razorpay.", "They are exact."],
];
const resetDb = (migText) => {
  sh(`dropdb --if-exists m53mut; createdb -T m53tpl m53mut`);
  fs.writeFileSync("/tmp/_mut_mig_53.sql", migText);
  return sh(`psql -v ON_ERROR_STOP=1 -q -d m53mut -f /tmp/_mut_mig_53.sql`);
};
const suites = {
  db: () => sh(`DATABASE_URL='${URL}' ${node} tests/phase5/m53-db.test.mjs`, work),
  logic: () => sh(`${node} tests/phase5/m53-logic.test.mjs`, work),
  guard: () => sh(`${node} tests/phase5/m53-guardrails.test.mjs`, work),
};
const runUntilDead = (order) => {
  for (const k of order) {
    const r = suites[k](); const out = `${r.stdout}${r.stderr}`;
    if (r.status !== 0 || /^FAIL:/m.test(out)) return `${k}:${out.match(/^FAIL: (\S+)/m)?.[1] ?? "error"}`;
  }
  return null;
};
let killed = 0, total = 0; const survivors = [];
const report = (label, kind, by) => { total++; if (by) killed++; else survivors.push(label); console.log(`${by ? "killed  " : "SURVIVED"}  [${kind}] ${label}${by ? "  <- " + by : ""}`); };
const MIGSRC = orig(MIG);
// "mfa" mutants remove the first-statement admin check of the named function (the text after its `begin`)
const removeMfa = (src, header) => {
  const a = src.indexOf(header); const b = src.indexOf("begin", a) + 5;
  const c = src.indexOf("end if;", b) + 7;
  return src.slice(0, b) + src.slice(c);
};
for (const [label, from, to, mode] of SQLM) {
  let mutated;
  if (mode === "mfa") mutated = removeMfa(MIGSRC, from);
  else {
    if (!MIGSRC.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
    mutated = MIGSRC.replace(from, to);
  }
  fs.writeFileSync(path.join(work, MIG), mutated);
  const r = resetDb(mutated);
  if (r.status !== 0) { report(label, "sql", "migration no longer applies"); fs.writeFileSync(path.join(work, MIG), MIGSRC); continue; }
  report(label, "sql", runUntilDead(["db", "guard"]));
  fs.writeFileSync(path.join(work, MIG), MIGSRC);
}
resetDb(MIGSRC);
for (const [label, file, from, to] of JSM) {
  const src = orig(file);
  if (!src.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  fs.writeFileSync(path.join(work, file), src.replace(from, to));
  report(label, "js", runUntilDead(["logic", "guard"]));
  fs.writeFileSync(path.join(work, file), src);
}
console.log(`\nmutants killed: ${killed}/${total}`); if (survivors.length) console.log("survivors:", survivors);
