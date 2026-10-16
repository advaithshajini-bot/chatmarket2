// Mutation check for Milestone 5.3 part 2 (seller payout status). Run as the postgres OS user:  node run-mutations-53b.mjs <repoDir>
// Needs template DB m53btpl = stub + every migration EXCEPT 20261016100000.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/tmp/m53bmut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261016100000_add_seller_payout_status.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const URL = "postgres://postgres@/m53bmut?host=/var/run/postgresql";
const SQLM = [
  ["anon not refused", "if v_uid is null then", "if false then"],
  ["rows not limited to the caller", "where l.seller_id = v_uid", "where true"],
  ["limit validation removed", "if p_limit is null or p_limit < 1 or p_limit > 500 then", "if false then"],
  ["limit cap removed", "p_limit < 1 or p_limit > 500", "p_limit < 1"],
  ["limit ignored", "                   limit p_limit\n", ""],
  ["legacy sales without payment id listed", "       and p.razorpay_payment_id is not null\n", ""],
  ["refunded purchase not reversed", "when s.pstatus = 'refunded' or s.tstatus = 'reversed'", "when s.tstatus = 'reversed'"],
  ["reversed transfer not reversed", "when s.pstatus = 'refunded' or s.tstatus = 'reversed'", "when s.pstatus = 'refunded'"],
  ["open dispute not shown", "when s.dstatus = 'open'                                                                then 'dispute'", "when false then 'dispute'"],
  ["no account not flagged", "when s.tid is null and v_account is null                                               then 'needs_account'", "when false then 'needs_account'"],
  ["pending account not flagged", "when s.tid is null and v_account = 'pending'                                           then 'account_pending'", "when false then 'account_pending'"],
  ["suspended account not reviewed", "when s.tid is null and v_account = 'suspended'                                         then 'under_review'", "when false then 'under_review'"],
  ["parked transfer shown as normal", "when s.review_reason is not null                                                       then 'under_review'", "when false then 'under_review'"],
  ["failed shown to seller as processing -> held", "when s.tstatus in ('creating', 'failed')                                               then 'processing'", "when false then 'processing'"],
  ["settled not paid", "when s.settlement_status = 'settled'                                                   then 'paid'", "when false then 'paid'"],
  ["expired hold still held", "when s.on_hold and s.hold_until is not null and s.hold_until > now()                   then 'held'", "when s.on_hold and s.hold_until is not null then 'held'"],
  ["indefinite hold released", "when s.on_hold and s.hold_until is null                                                then 'processing'", "when false then 'processing'"],
  ["release date leaks on other states", "'release_date', case when c.code = 'held' then c.hold_until else null end", "'release_date', c.hold_until"],
  ["share ignores the fee", "(round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100))::bigint as share", "round(p.amount * 100)::bigint as share"],
  ["paid ignores partial reversals", "sum(c.share - coalesce(c.amount_reversed_paise, 0)) filter (where c.code = 'paid')", "sum(c.share) filter (where c.code = 'paid')"],
  ["dispute not counted as held", "filter (where c.code in ('held', 'dispute'))", "filter (where c.code in ('held'))"],
  ["queued not counted", "filter (where c.code in ('releasing', 'processing', 'queued'))", "filter (where c.code in ('releasing', 'processing'))"],
  ["waiting not counted", "filter (where c.code in ('needs_account', 'account_pending', 'under_review'))", "filter (where c.code in ('needs_account'))"],
  ["newest first lost", "jsonb_agg(x.j order by x.purchased_at desc, x.purchase_id)", "jsonb_agg(x.j order by x.purchased_at asc, x.purchase_id)"],
  ["LEAK: transfer error added", "'status', c.code, 'share_paise', c.share,", "'status', c.code, 'share_paise', c.share, 'error', (select t2.error from public.transfers t2 where t2.id = c.tid),"],
  ["LEAK: review reason added", "'status', c.code, 'share_paise', c.share,", "'status', c.code, 'share_paise', c.share, 'review', c.review_reason,"],
  ["LEAK: transfer id added", "'status', c.code, 'share_paise', c.share,", "'status', c.code, 'share_paise', c.share, 'transfer', (select t2.razorpay_transfer_id from public.transfers t2 where t2.id = c.tid),"],
  ["LEAK: dispute reason added", "'status', c.code, 'share_paise', c.share,", "'status', c.code, 'share_paise', c.share, 'why', (select d2.reason from public.disputes d2 where d2.purchase_id = c.purchase_id),"],
  ["grant to anon", "grant execute on function public.seller_payout_status(integer) to authenticated;", "grant execute on function public.seller_payout_status(integer) to authenticated, anon;"],
  ["VOLATILE", "returns jsonb\nlanguage plpgsql\nstable", "returns jsonb\nlanguage plpgsql\nvolatile"],
];
const JSM = [
  ["wording: held without the date", "lib/domain/seller-payouts.js", "label: item.release_date ? `Held until ${fmtDate(item.release_date)}` : \"Held\"", "label: \"Held\""],
  ["wording: dispute", "lib/domain/seller-payouts.js", "\"On hold: dispute raised\"", "\"Dispute\""],
  ["wording: internal term leaks", "lib/domain/seller-payouts.js", "\"We're looking at this payout. You don't need to do anything.\"", "\"Transfer parked by the ledger sweep.\""],
  ["wording: needs_account no action", "lib/domain/seller-payouts.js", "\"Action needed: link your payout account\"", "\"No account\""],
  ["loader surfaces the error text", "lib/domain/seller-payouts.js", "if (error || !data || !Array.isArray(data.items)) return empty;", "if (error) return { ...empty, message: error.message }; if (!data || !Array.isArray(data.items)) return empty;"],
  ["loader sends a seller id", "lib/domain/seller-payouts.js", "{ p_limit: 100 }", "{ p_limit: 100, p_seller_id: \"x\" }"],
  ["account banner: suspended needs no action", "lib/domain/seller-payouts.js", "tone: \"red\", needsAction: true };\n    default", "tone: \"red\", needsAction: false };\n    default"],
  ["panel drops the payout-setup link", "components/SellerPayoutPanel.jsx", "href=\"/sell/payout\"", "href=\"/sell\""],
  ["panel prints the raw reason", "components/SellerPayoutPanel.jsx", "<p className=\"text-sm truncate\" style={{ color: \"#14213D\", fontWeight: 500 }}>{i.listing_title}</p>", "<p className=\"text-sm truncate\" style={{ color: \"#14213D\", fontWeight: 500 }}>{i.listing_title}{i.reason}</p>"],
  ["earnings page stops loading payouts", "app/sell/earnings/page.jsx", "const payouts = await getSellerPayoutStatus(supabase);", "const payouts = null;"],
  ["placeholder restored", "components/SellerEarningsClient.jsx", "<SellerPayoutPanel payouts={payouts} />", "<p>No real payouts yet</p>"],
];
const resetDb = (t) => { sh(`dropdb --if-exists m53bmut; createdb -T m53btpl m53bmut`); fs.writeFileSync("/tmp/_mut_mig_53b.sql", t); return sh(`psql -v ON_ERROR_STOP=1 -q -d m53bmut -f /tmp/_mut_mig_53b.sql`); };
const suites = {
  db: () => sh(`DATABASE_URL='${URL}' ${node} tests/phase5/m53b-db.test.mjs`, work),
  logic: () => sh(`${node} tests/phase5/m53b-logic.test.mjs`, work),
  guard: () => sh(`${node} tests/phase5/m53b-guardrails.test.mjs`, work),
};
const runUntilDead = (order) => { for (const k of order) { const r = suites[k](); const out = `${r.stdout}${r.stderr}`; if (r.status !== 0 || /^FAIL:/m.test(out)) return `${k}:${out.match(/^FAIL: (\S+)/m)?.[1] ?? "error"}`; } return null; };
let killed = 0, total = 0; const survivors = [];
const report = (label, kind, by) => { total++; if (by) killed++; else survivors.push(label); console.log(`${by ? "killed  " : "SURVIVED"}  [${kind}] ${label}${by ? "  <- " + by : ""}`); };
const SRC = orig(MIG);
for (const [label, from, to] of SQLM) {
  if (!SRC.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  const mutated = SRC.replace(from, to);
  fs.writeFileSync(path.join(work, MIG), mutated);
  if (resetDb(mutated).status !== 0) { report(label, "sql", "migration no longer applies"); fs.writeFileSync(path.join(work, MIG), SRC); continue; }
  report(label, "sql", runUntilDead(["db", "guard"]));
  fs.writeFileSync(path.join(work, MIG), SRC);
}
for (const [label, file, from, to] of JSM) {
  const src = orig(file);
  if (!src.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  fs.writeFileSync(path.join(work, file), src.replace(from, to));
  report(label, "js", runUntilDead(["logic", "guard"]));
  fs.writeFileSync(path.join(work, file), src);
}
console.log(`\nmutants killed: ${killed}/${total}`); if (survivors.length) console.log("survivors:", survivors);
