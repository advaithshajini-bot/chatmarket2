// A54-G -- static guardrails for the Phase 6 revoke migration and the preflight guard in run-all.
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
const MIG = "supabase/migrations/20261017100000_revoke_self_set_payout_account.sql";
const sql = read(MIG).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

check("G01 the migration sorts directly before the 5.4 UPI migration (only later additive milestones follow)", migs.indexOf("20261018100000_add_vpa_payouts.sql") === migs.indexOf(path.basename(MIG)) + 1 && migs.slice(migs.indexOf("20261018100000_add_vpa_payouts.sql") + 1).every((f) => /^20261019/.test(f)));
check("G02 it contains exactly one statement: a REVOKE on that one function", sql.trim().split(";").filter((s) => s.trim()).length === 1 && /^revoke all on function public\.set_seller_payout_account\(text, text\) from public, anon, authenticated$/.test(sql.trim().replace(/;$/, "")), sql);
check("G03 it never grants, drops, alters or creates", !/\b(grant|drop|alter|create|insert|update|delete)\b/.test(sql));
check("G04 nothing in the app calls the revoked function (admin variant excluded)", ["app", "components", "lib"].every((d) => {
  const walk = (p) => fs.readdirSync(path.join(root, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]);
  return walk(d).filter((f) => /\.(js|jsx|mjs|ts|tsx)$/.test(f)).every((f) => !/[^_]set_seller_payout_account/.test(read(f).replace(/admin_set_seller_payout_account/g, "")));
}));
const ra = read("tests/phase5/run-all.mjs");
check("G10 run-all has a preflight that refuses a database holding real purchases unless explicitly allowed", /PHASE5_ALLOW_NONEMPTY/.test(ra) && /public\.purchases/.test(ra));
check("G11 the preflight runs before any suite", ra.indexOf("PHASE5_ALLOW_NONEMPTY") < ra.indexOf('suite("M51'));
check("G12 the m54 tests are registered", ["m54-db", "m54-guardrails"].every((s) => ra.includes(s + ".test.mjs")));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
