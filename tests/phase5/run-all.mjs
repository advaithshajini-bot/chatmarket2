// tests/phase5/run-all.mjs -- single command for the Milestone 5.1 gate:
//     DATABASE_URL=... node tests/phase5/run-all.mjs
// SKIPPED counts as NOT passed unless --allow-skip.
//   PHASE5_CONCURRENCY_TESTS=1  also runs the multi-connection race tests (they COMMIT then delete rows: scratch DB only)
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowSkip = process.argv.includes("--allow-skip");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let totalPass = 0, totalFail = 0, notPassed = false;
function suite(label, file) {
  const r = spawnSync(process.execPath, [path.join(root, "tests/phase5", file)], { cwd: root, encoding: "utf8", env: process.env });
  const out = strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (/^SKIPPED/m.test(out)) { console.log(`${label}: SKIPPED${allowSkip ? "" : " (counts as NOT passed)"}`); if (!allowSkip) notPassed = true; return; }
  const pass = (out.match(/^PASS:/gm) ?? []).length, fail = (out.match(/^FAIL:/gm) ?? []).length;
  totalPass += pass; totalFail += fail + (r.status && !fail ? 1 : 0);
  console.log(`${label}: ${pass} passed, ${fail} failed${r.status ? ` (exit ${r.status})` : ""}`);
  if (fail || r.status) console.log(out.split("\n").filter((l) => /FAIL|rror/.test(l)).join("\n"));
}
suite("M51  payment fulfilment (live DB, real schema)", "m51-db.test.mjs");
suite("M51  concurrency (live DB, commits then deletes)", "m51-concurrency.test.mjs");
suite("M51  signature, webhook handler, outcomes (no DB)", "m51-logic.test.mjs");
suite("M51  source + migration guardrails (static)", "m51-guardrails.test.mjs");
console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed${notPassed ? ", with skipped suites (NOT a pass)" : ""}`);
process.exit(totalFail || notPassed ? 1 : 0);
