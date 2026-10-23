// A61 -- documentation + rehearsal-seed guardrails. Static; no database, no network.
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
const hand = read("HANDOFF.md"), readme = read("tests/phase5/README.md");

// every env var name the code reads is documented, and no retired one is presented as needed
const used = new Set();
function walk(dir) { for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) { if (!["node_modules", ".next"].includes(e.name)) walk(rel); } else if (/\.(js|jsx)$/.test(e.name)) for (const m of read(rel).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]); } }
["app", "lib", "components"].forEach(walk);
check("D01 every environment variable the app reads is named in HANDOFF.md", [...used].every((v) => hand.includes(v)), [...used].filter((v) => !hand.includes(v)));
const stale = /RAZORPAYX_ACCOUNT_NUMBER|PAYOUT_PROXY_URL|CRON_SECRET/;
const staleLines = (t) => t.split("\n").filter((l) => stale.test(l) && !/removed|no longer|retired|not needed|deleted/i.test(l));
check("D02 neither document tells you to set a retired variable (it may only be mentioned as removed)", staleLines(hand).length === 0 && staleLines(readme).length === 0, [...staleLines(hand), ...staleLines(readme)]);
const gone = ["vpa-payouts.js", "payout-events.js", "transfers/sweep", "sweep-handler", "reconcile.js", "run-mutations-52", "run-mutations-55", "m55-logic", "m55-integration", "m52-logic", "m52-integration"];
check("D03 the test README no longer documents deleted suites or files as present", gone.every((g) => !readme.includes(g) || /deleted|removed/i.test(readme.split("\n").filter((l) => l.includes(g)).join(" "))), gone.filter((g) => readme.includes(g)));
check("D04 every suite file in tests/phase5 appears in the test README", fs.readdirSync(path.join(root, "tests/phase5")).filter((f) => /^m\d+[a-z]?-.*\.test\.mjs$/.test(f)).every((f) => readme.includes(f) || readme.includes(f.split("-")[0] + "-*")), fs.readdirSync(path.join(root, "tests/phase5")).filter((f) => /^m\d+[a-z]?-.*\.test\.mjs$/.test(f) && !readme.includes(f) && !readme.includes(f.split("-")[0] + "-*")));
check("D05 HANDOFF lists every migration from 5.1 to 5.7 in order", ["20261012100000", "20261013100000", "20261014100000", "20261015100000", "20261016100000", "20261017100000", "20261018100000", "20261019100000", "20261020100000", "20261021100000"].map((m) => hand.indexOf(m)).every((v, i, a) => v > -1 && (i === 0 || v > a[i - 1])));
check("D06 HANDOFF says the monthly settlement, minimum payout, cooldown and non-recourse decisions", /monthly/i.test(hand) && /min_payout_paise/.test(hand) && /upi_cooldown_hours/.test(hand) && /non-recourse/i.test(hand));
check("D07 HANDOFF carries no secret value", !/rzp_(test|live)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}|sk-ant-|eyJ[A-Za-z0-9_-]{20,}/.test(hand + readme));

// the rehearsal seed
const seed = read("supabase/manual/rehearsal_seed.sql");
const code = seed.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n"), lower = code.toLowerCase();
check("S01 the seed is a manual script, not a migration", !fs.readdirSync(path.join(root, "supabase/migrations")).some((f) => /rehearsal/.test(f)));
const guard = lower.indexOf("refusing: this database holds"), firstWrite = lower.search(/\b(insert into|delete from|update )/);
check("S02 the real-purchase check comes before the first write and raises an exception", guard > -1 && firstWrite > guard);
check("S03 it refuses on any purchase whose payment id is not a rehearsal one (or has none)", /not like 'rehearsal\\_pay\\_%'/.test(lower) && /razorpay_payment_id is null/.test(lower));
check("S04 it refuses when the settlement migrations are missing", /to_regclass\('public\.settlement_batches'\) is null/.test(lower) && /vpa_changed_at/.test(lower));
check("S05 every account it creates is a fake: e-mails end in @rehearsal.invalid and no password or admin is created", [...code.matchAll(/'([^']*@[^']*)'/g)].map((m) => m[1]).filter((v) => /^[^ ]+@[^ ]+$/.test(v) && !/okhdfcbank|ybl|paytm|oksbi|okaxis/.test(v)).every((v) => v.endsWith("@rehearsal.invalid")) && !/encrypted_password|is_admin\s*=\s*true/.test(lower));
check("S06 it deletes only rehearsal rows (by fixed ids or the rehearsal payment prefix), never a bare delete", !/delete from [\w.]+\s*;/.test(lower));
check("S07 it covers all five scenarios: payable, below minimum, cooldown, no UPI, refunded sale", /payable/.test(seed) && /below_minimum|below minimum/i.test(seed) && /upi_in_cooldown/.test(seed) && /no_upi_id/.test(seed) && /'refunded'/.test(seed));
check("S08 it never touches feature flags, the retired payout tables or any secret", !/feature_flags|vpa_payout|transfers|razorpay_key|service_role/.test(lower));
check("S09 the header says scratch only and never production", /SCRATCH \/ LOCAL \/ BRANCH DATABASE ONLY/.test(seed) && /Never run this on production/.test(seed));

console.log(`\nA61: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
