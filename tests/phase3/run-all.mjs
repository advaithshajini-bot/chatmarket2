// tests/phase3/run-all.mjs
//
// Single command for the whole Phase 3 gate:
//     node tests/phase3/run-all.mjs
//
// Why this exists instead of `node --test tests/phase3/*.test.mjs`:
//   - cmd.exe doesn't expand `*` globs, so Node would receive the literal
//     string.
//   - These files are plain scripts using a hand-rolled check() (matching
//     the Phase 1/2 test convention in this repo), not node:test suites,
//     so `node --test` could only report per-FILE pass/fail, not the real
//     per-check counts.
// This runner executes each file as a child process, counts the real
// PASS/FAIL lines each one prints, and applies the file's exit code.
//
// SKIPPED counts as NOT PASSED by default. Several files skip themselves
// (exit 0) when DATABASE_URL / EXECUTION_WORKER_URL / WORKER_SHARED_SECRET
// are unset -- without this rule, a run with no credentials would look
// green while testing nothing against the database. Pass --allow-skip only
// if you deliberately want a partial, no-credentials run.
//
// Flags:  --verbose   print every test line, not just failures
//         --allow-skip   don't treat SKIPPED as a failure

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const verbose = process.argv.includes("--verbose");
const allowSkip = process.argv.includes("--allow-skip");

const FILES = [
  ["L1  validation (pure JS)",            "l1-validation.test.mjs"],
  ["L2  database assertion (live DB)",    "l2-database-assertion.test.mjs"],
  ["L3  runtime fail-closed (live DB)",   "l3-runtime-failclosed.test.mjs"],
  ["L3  ceilings, txn-rollback (live DB)", "l3-ceilings.test.mjs"],
  ["L3  route handlers (mocked client)",  "l3-route-handlers.test.mjs"],
  ["W1  worker boundary (live DB+worker)", "w1-worker-boundary.test.mjs"],
];

let totalPass = 0, totalFail = 0, totalSkipped = 0, anyBadExit = false;
const rows = [];

for (const [label, file] of FILES) {
  const res = spawnSync(process.execPath, [path.join(here, file)], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
  });

  const lines = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.split(/\r?\n/);
  const passLines = lines.filter((l) => l.startsWith("PASS"));
  const failLines = lines.filter((l) => l.startsWith("FAIL"));
  const skipLines = lines.filter((l) => l.trim().startsWith("SKIPPED"));
  const crashed = res.status !== 0 && failLines.length === 0; // e.g. import error, thrown exception, timeout

  totalPass += passLines.length;
  totalFail += failLines.length + (crashed ? 1 : 0);
  totalSkipped += skipLines.length;
  if (res.status !== 0) anyBadExit = true;

  rows.push({ label, pass: passLines.length, fail: failLines.length, skipped: skipLines.length, crashed, status: res.status });

  if (verbose) {
    console.log(`\n===== ${label} (${file}) =====`);
    console.log(res.stdout);
    if (res.stderr) console.log(res.stderr);
  } else {
    for (const l of failLines) console.log(`  [${file}] ${l}`);
    for (const l of skipLines) console.log(`  [${file}] ${l.trim()}`);
    if (crashed) console.log(`  [${file}] CRASHED (exit ${res.status}):\n${(res.stderr || res.stdout || "").split("\n").slice(0, 6).join("\n")}`);
  }
}

console.log("\n" + "-".repeat(78));
console.log("Phase 3 gate summary");
console.log("-".repeat(78));
for (const r of rows) {
  const state = r.crashed ? "CRASHED" : r.fail > 0 ? "FAILED" : r.skipped > 0 ? "SKIPPED*" : "ok";
  console.log(`${r.label.padEnd(40)} pass ${String(r.pass).padStart(2)}  fail ${String(r.fail).padStart(2)}  skipped-notes ${r.skipped}  ${state}`);
}
console.log("-".repeat(78));
console.log(`TOTAL  pass ${totalPass}   fail ${totalFail}   skip-notes ${totalSkipped}`);
console.log("(check counts are individual assertions, not the 48 matrix IDs -- see tests/phase3/README.md for the ID -> check mapping)");

let ok = totalFail === 0 && !anyBadExit;
if (totalSkipped > 0 && !allowSkip) {
  console.log("\nNOT A FULL PASS: some tests were SKIPPED (missing env vars) and skipped tests don't count as passed.");
  console.log("Set DATABASE_URL, EXECUTION_WORKER_URL and WORKER_SHARED_SECRET, or rerun with --allow-skip for a deliberately partial run.");
  ok = false;
}
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: NOT PASSED");
process.exitCode = ok ? 0 : 1;
