// tests/phase4/run-all.mjs -- single command for the Milestone 4.0 gate:
//     DATABASE_URL=... node tests/phase4/run-all.mjs
// Same rules as tests/phase3/run-all.mjs: SKIPPED counts as NOT passed unless
// --allow-skip. Needs `deno` on PATH for the worker contract suite.
//   PHASE4_DESTRUCTIVE_TESTS=1  also runs the two-connection / temp-trigger checks
//   (M40-S07, M40-S08) -- scratch DB or quiet window only.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const verbose = process.argv.includes("--verbose");
const allowSkip = process.argv.includes("--allow-skip");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
let totalPass = 0, totalFail = 0, notPassed = false;

function report(label, r, counts) {
  const out = strip(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (r.error) { console.log(`${label}: could not start (${r.error.message})`); totalFail++; notPassed = true; return; }
  if (/^SKIPPED/m.test(out)) {
    console.log(`${label}: SKIPPED${allowSkip ? "" : " (counts as NOT passed)"}`);
    if (!allowSkip) notPassed = true;
    return;
  }
  const { pass, fail } = counts(out);
  totalPass += pass; totalFail += fail;
  console.log(`${label}: ${pass} passed, ${fail} failed${r.status ? ` (exit ${r.status})` : ""}`);
  if (fail || r.status || verbose) console.log(out.split("\n").filter((l) => verbose || /FAIL|error|Error/.test(l)).join("\n"));
  if (r.status && !fail) { totalFail++; }
}

report("M40  dispatch trigger + sweep + payload drift (live DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m40-dispatch-sweep.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

report("M41  approval-resume engine (live DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m41-approvals.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

report("M42  demo engine + pricing (live DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m42-demo.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

report("M42  blueprint storage + policies (live DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m42-blueprints.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

report("M42  route handlers (mocked client, no DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m42-routes.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

report("M43  demo availability + privacy (live DB)",
  spawnSync(process.execPath, [path.join(root, "tests/phase4/m43-db.test.mjs")], { cwd: root, encoding: "utf8", env: process.env }),
  (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));

for (const [label, file] of [["M43  client logic: polling, failure copy, handlers (no DB)", "m43-logic.test.mjs"], ["M43  Try Demo reducer + helpers (no DB)", "m43-state.test.mjs"],
  ["M43  UI source guardrails (static)", "m43-guardrails.test.mjs"], ["M43  component render tests (needs esbuild)", "m43-components.test.mjs"]]) {
  report(label, spawnSync(process.execPath, [path.join(root, "tests/phase4", file)], { cwd: root, encoding: "utf8", env: process.env }),
    (o) => ({ pass: (o.match(/^PASS:/gm) ?? []).length, fail: (o.match(/^FAIL:/gm) ?? []).length }));
}

report("WC   worker contract (Deno, mocked RPC)",
  spawnSync("deno", ["test", "--config", "tests/phase4/worker-contract/deno.json", "--allow-env", "--allow-read", "--no-lock", "tests/phase4/worker-contract/"],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" }),
  (o) => { const m = o.match(/(\d+) passed \| (\d+) failed/); return { pass: m ? +m[1] : 0, fail: m ? +m[2] : 1 }; });

console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed${notPassed ? ", with skipped/unstarted suites" : ""}`);
process.exit(totalFail || notPassed ? 1 : 0);
