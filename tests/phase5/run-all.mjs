// tests/phase5/run-all.mjs -- single command for the Milestone 5.1 + 5.2 + 5.2c + 5.3 + 5.4 (UPI payouts) gate:
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
// PREFLIGHT: these suites create and delete their own rows (the concurrency/integration ones COMMIT first). Refuse to touch a database that
// already holds real purchases -- that is almost certainly production or a populated branch. Override only on purpose.
if (process.env.DATABASE_URL && process.env.PHASE5_ALLOW_NONEMPTY !== "1") {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await c.connect();
    const { rows } = await c.query("select (select count(*) from public.purchases)::int as purchases, (select count(*) from public.listings)::int as listings");
    if (rows[0].purchases > 0 || rows[0].listings > 0) {
      console.log(`REFUSING TO RUN: this database already has ${rows[0].purchases} purchases and ${rows[0].listings} listings. Point DATABASE_URL at an EMPTY scratch database or branch, or set PHASE5_ALLOW_NONEMPTY=1 if you are certain it is a throwaway.`);
      process.exit(2);
    }
  } catch (e) {
    console.log(`PREFLIGHT: could not inspect the database (${e.code || e.message}); continuing -- the suites will report their own connection errors.`);
  } finally { await c.end().catch(() => {}); }
}
suite("M51  payment fulfilment (live DB, real schema)", "m51-db.test.mjs");
suite("M51  concurrency (live DB, commits then deletes)", "m51-concurrency.test.mjs");
suite("M51  signature, webhook handler, outcomes (no DB)", "m51-logic.test.mjs");
suite("M51  source + migration guardrails (static)", "m51-guardrails.test.mjs");
suite("M52  Route transfers ledger + state machine (live DB, real schema)", "m52-db.test.mjs");
suite("M52  source + migration guardrails (static)", "m52-guardrails.test.mjs");
suite("M52c disputes -> hold / release / reverse / refund (live DB, real schema)", "m52c-db.test.mjs");
suite("M52c integration: real DB + refund orchestration + fake Razorpay + races (commits then deletes)", "m52c-integration.test.mjs");
suite("M52c refund client, orchestration, sync handler, refund webhook (no DB)", "m52c-logic.test.mjs");
suite("M52c source + migration guardrails (static)", "m52c-guardrails.test.mjs");
suite("M53  admin payout reporting (live DB, real schema)", "m53-db.test.mjs");
suite("M53  admin payments desk helpers (no DB)", "m53-logic.test.mjs");
suite("M53  source + migration guardrails (static)", "m53-guardrails.test.mjs");
suite("M53b seller payout status (live DB, real schema)", "m53b-db.test.mjs");
suite("M53b seller payout wording + loader (no DB)", "m53b-logic.test.mjs");
suite("M53b source + migration guardrails (static)", "m53b-guardrails.test.mjs");
suite("M54  revoke self-service payout account (live DB, real schema)", "m54-db.test.mjs");
suite("M54  revoke migration + preflight guardrails (static)", "m54-guardrails.test.mjs");
suite("M55  retired UPI payouts: ledger kept, dormant (live DB, real schema)", "m55-db.test.mjs");
suite("M55  source + migration guardrails (static)", "m55-guardrails.test.mjs");
suite("M56  monthly settlement: ledger, batches, seller view, non-recourse (live DB, real schema)", "m56-db.test.mjs");
suite("M56  settlement helpers: CSV safety, IST periods, wording, loaders (no DB)", "m56-logic.test.mjs");
suite("M56  source + migration guardrails (static)", "m56-guardrails.test.mjs");
suite("M57  minimum payout threshold (live DB, real schema)", "m57-db.test.mjs");
suite("M60  UPI-change cooldown (live DB, real schema)", "m60-db.test.mjs");
suite("M60  cooldown wording, loaders, source + migration guardrails (no DB)", "m60-logic.test.mjs");
suite("M61  docs + rehearsal seed guardrails (no DB)", "m61-docs.test.mjs");
suite("M62  generation type: columns + constraints (live DB, real schema)", "m62-db.test.mjs");
suite("M62  generation type: helper, form and migration guardrails (no DB)", "m62-logic.test.mjs");
suite("M63  direct seller-to-buyer UPI payments (live DB, real schema)", "m63-db.test.mjs");
suite("M63  direct UPI: helpers, screens, migration guardrails (no DB)", "m63-logic.test.mjs");
suite("M58  Tier 1 clean-up: payout code retired, nothing reaches it (no DB)", "m58-tier1.test.mjs");
suite("M59  Tier 2 clean-up: Route transfers + sweep retired, refunds and disputes kept (no DB)", "m59-tier2.test.mjs");
console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed${notPassed ? ", with skipped suites (NOT a pass)" : ""}`);
process.exit(totalFail || notPassed ? 1 : 0);
