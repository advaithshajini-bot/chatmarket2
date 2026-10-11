// A43-S -- the Try Demo reducer + display helpers (pure; no React, no network, no DB).
// Run:  node tests/phase4/m43-state.test.mjs
import { initialState, reducer, outcome, isBusy, charCount, validateInput, canSubmit, stepViews, progressLabel } from "../../lib/demo/demo-state.js";
import { formatLabel, formatBytes, checksumCommands, describeBlueprintError } from "../../lib/blueprints/format.js";
import { toDemoInfo, getListingDemoInfo } from "../../lib/domain/demos.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const run = (over = {}) => ({ id: "r1", status: "running", done: false, failure: null, steps: [], result: null, ...over });
const step = (reducerState, ...actions) => actions.reduce(reducer, reducerState);
const NAMES = ["Draft", "Polish"];

// ------------------------------------------------------------------ reducer
{
  const s0 = initialState({ remainingToday: 3 });
  check("A43-R01 initial: idle, empty, no run, remaining from the server", s0.phase === "idle" && s0.text === "" && s0.runId === null && s0.run === null && s0.remaining === 3 && s0.notice === null);
  check("A43-R02 anonymous: remaining null stays null through a start", step(initialState({ remainingToday: null }), { type: "STARTED", runId: "r1" }).remaining === null);
  const started = step(s0, { type: "EDIT", text: "hi" }, { type: "START" }, { type: "STARTED", runId: "r1" });
  check("A43-R03 START -> STARTED: running, runId set, remaining decremented 3 -> 2", started.phase === "running" && started.runId === "r1" && started.remaining === 2 && isBusy(started));
  check("A43-R04 START alone is 'starting' and busy", step(s0, { type: "START" }).phase === "starting" && isBusy(step(s0, { type: "START" })));
  check("A43-R05 remaining never goes below 0", step(initialState({ remainingToday: 0 }), { type: "STARTED", runId: "r" }).remaining === 0);
  const upd = reducer(started, { type: "UPDATE", run: run({ status: "running", steps: [{ index: 0, status: "running", text: null }] }) });
  check("A43-R06 UPDATE with a non-terminal run stores it and keeps running", upd.phase === "running" && upd.run.steps.length === 1);
  const fin = reducer(upd, { type: "UPDATE", run: run({ status: "succeeded", done: true, result: "x" }) });
  check("A43-R07 UPDATE with a terminal run moves to done", fin.phase === "done" && outcome(fin) === "succeeded" && !isBusy(fin));
  check("A43-R08 a STALE update for a different run is ignored", reducer(started, { type: "UPDATE", run: run({ id: "other", done: true, status: "succeeded" }) }) === started);
  check("A43-R09 an update after RESET (idle) is ignored", reducer(reducer(fin, { type: "RESET" }), { type: "UPDATE", run: run({ done: true, status: "succeeded" }) }).phase === "idle");
  const failed = reducer(started, { type: "UPDATE", run: run({ status: "failed", done: true, failure: "busy" }) });
  check("A43-R10 a failed run is phase 'done' with outcome 'failed'", failed.phase === "done" && outcome(failed) === "failed");
  check("A43-R11 outcome is null while not done", outcome(started) === null && outcome(s0) === null);
}
{
  const s0 = initialState({ remainingToday: 3 });
  const sf = reducer(step(s0, { type: "START" }), { type: "START_FAILED", status: 429, reason: "demo_daily_limit" });
  check("A43-R12 START_FAILED(daily limit): back to idle, remaining forced to 0, notice kept", sf.phase === "idle" && sf.remaining === 0 && sf.notice.reason === "demo_daily_limit" && sf.notice.status === 429);
  const sf2 = reducer(step(s0, { type: "START" }), { type: "START_FAILED", status: 503, reason: "demo_budget_exhausted" });
  check("A43-R13 START_FAILED(other): remaining unchanged, notice kept", sf2.remaining === 3 && sf2.notice.reason === "demo_budget_exhausted");
  check("A43-R14 the typed text survives a failed start (the user does not lose their input)", reducer(step(s0, { type: "EDIT", text: "keep me" }, { type: "START" }), { type: "START_FAILED", status: 500 }).text === "keep me");
  const started = step(s0, { type: "START" }, { type: "STARTED", runId: "r1" });
  check("A43-R15 POLL_END timeout -> stalled with a timeout notice, runId kept", reducer(started, { type: "POLL_END", result: { state: "timeout" } }).phase === "stalled" && reducer(started, { type: "POLL_END", result: { state: "timeout" } }).runId === "r1");
  check("A43-R16 POLL_END network error -> stalled; unauthenticated -> stalled with that code",
    reducer(started, { type: "POLL_END", result: { state: "error", code: "network" } }).notice.code === "network" && reducer(started, { type: "POLL_END", result: { state: "unauthenticated" } }).notice.code === "unauthenticated");
  const nf = reducer(started, { type: "POLL_END", result: { state: "error", code: "not_found" } });
  check("A43-R17 POLL_END not_found drops the run: idle, no runId, notice", nf.phase === "idle" && nf.runId === null && nf.notice.code === "not_found");
  check("A43-R18 POLL_END aborted changes nothing (same object)", reducer(started, { type: "POLL_END", result: { state: "aborted" } }) === started && reducer(started, { type: "POLL_END", result: null }) === started);
  const dn = reducer(started, { type: "POLL_END", result: { state: "done", run: run({ status: "succeeded", done: true, result: "ok" }) } });
  check("A43-R19 POLL_END done stores the final run", dn.phase === "done" && dn.run.result === "ok");
  const stalled = reducer(started, { type: "POLL_END", result: { state: "timeout" } });
  const rc = reducer(stalled, { type: "RECHECK" });
  check("A43-R20 RECHECK resumes polling the same run and clears the notice; no-op without a run", rc.phase === "running" && rc.runId === "r1" && rc.notice === null && reducer(s0, { type: "RECHECK" }) === s0);
  const rs = reducer(initialState({ remainingToday: 2 }), { type: "RESUME", runId: "r9" });
  check("A43-R21 RESUME (page reload) re-attaches WITHOUT spending a run: running, remaining unchanged", rs.phase === "running" && rs.runId === "r9" && rs.remaining === 2);
  const reset = reducer(dn, { type: "RESET" });
  check("A43-R22 RESET clears text, run, runId, notice but keeps remaining", reset.phase === "idle" && reset.text === "" && reset.run === null && reset.runId === null && reset.remaining === dn.remaining);
  check("A43-R23 an update arriving while 'stalled' revives it to running", reducer(stalled, { type: "UPDATE", run: run({}) }).phase === "running");
  check("A43-R24 unknown actions are ignored", reducer(s0, { type: "WHAT" }) === s0);
}

// ------------------------------------------------------------------ input validation + submit gating
{
  check("A43-V01 charCount counts characters, not UTF-16 units (emoji = 1, Hindi 2000 chars = 2000)", charCount("😀") === 1 && charCount("अ".repeat(2000)) === 2000 && charCount("") === 0 && charCount(null) === 0);
  const v = (t, m) => validateInput(t, m);
  check("A43-V02 validateInput: empty and whitespace-only are rejected", v("").reason === "empty" && v("   \n\t ").reason === "empty" && v(null).reason === "empty");
  check("A43-V03 validateInput: exactly the max is fine, one over is 'too_long'", v("a".repeat(2000)).ok && v("a".repeat(2001)).reason === "too_long" && v("a".repeat(5), 5).ok && v("a".repeat(6), 5).reason === "too_long");
  const base = initialState({ remainingToday: 3 });
  const withText = (t, over = {}) => ({ ...base, text: t, ...over });
  check("A43-V04 canSubmit: needs valid text, not busy, and runs left", canSubmit(withText("hi")) && !canSubmit(withText("")) && !canSubmit(withText("hi", { phase: "running" })) && !canSubmit(withText("hi", { phase: "starting" })) && !canSubmit(withText("hi", { remaining: 0 })));
  check("A43-V05 canSubmit allows anonymous-null remaining (the server decides) and respects a custom max", canSubmit(withText("hi", { remaining: null })) && !canSubmit(withText("abcdef"), 5));
}

// ------------------------------------------------------------------ step viewer
{
  const sv = (run) => stepViews(NAMES, run);
  check("A43-W01 stepViews with no run: every step pending, names in order", JSON.stringify(sv(null).map(s => [s.name, s.status])) === JSON.stringify([["Draft", "pending"], ["Polish", "pending"]]));
  const mid = sv(run({ steps: [{ index: 0, status: "succeeded", text: "draft!" }, { index: 1, status: "running", text: null }] }));
  check("A43-W02 stepViews merges server statuses and text by index", mid[0].status === "succeeded" && mid[0].text === "draft!" && mid[1].status === "running" && mid[1].text === null);
  check("A43-W03 stepViews tolerates missing names / extra server steps", stepViews(undefined, run()).length === 0 && stepViews(["Only"], run({ steps: [{ index: 0, status: "running" }, { index: 5, status: "running" }] })).length === 1);
  const s = (phase, r) => ({ ...initialState(), phase, run: r });
  check("A43-W04 progressLabel: starting / queued / step n of m / between steps / finished / did not complete / stalled",
    progressLabel(s("starting", null), NAMES) === "Starting your demo…"
      && progressLabel(s("running", null), NAMES) === "Queued — waiting for a worker…"
      && progressLabel(s("running", run({ steps: [{ index: 0, status: "running" }] })), NAMES) === "Running step 1 of 2…"
      && progressLabel(s("running", run({ steps: [{ index: 0, status: "succeeded", text: "x" }, { index: 1, status: "pending" }] })), NAMES) === "Running step 2 of 2…"
      && progressLabel(s("done", run({ status: "succeeded", done: true })), NAMES) === "Finished"
      && progressLabel(s("done", run({ status: "failed", done: true })), NAMES) === "Did not complete"
      && progressLabel(s("stalled", null), NAMES) === "Still working…"
      && progressLabel(s("idle", null), NAMES) === "");
}

// ------------------------------------------------------------------ blueprint helpers
{
  check("A43-B01 formatLabel", formatLabel("n8n") === "n8n workflow" && formatLabel("flowise") === "Flowise flow" && formatLabel("langflow") === "LangFlow template" && formatLabel("zapier") === "Blueprint" && formatLabel(undefined) === "Blueprint");
  check("A43-B02 formatBytes", formatBytes(0) === "0 B" && formatBytes(1023) === "1023 B" && formatBytes(1024) === "1.0 KB" && formatBytes(5120) === "5.0 KB" && formatBytes(20480) === "20 KB" && formatBytes(5242880) === "5.0 MB" && formatBytes(-1) === "" && formatBytes(NaN) === "" && formatBytes("x") === "");
  const c = checksumCommands("my flow.json");
  check("A43-B03 checksum commands sanitise the file name (no spaces / shell metacharacters)", c.unix === "sha256sum my_flow.json" && c.windows === "Get-FileHash my_flow.json -Algorithm SHA256");
  const evil = checksumCommands("a;rm -rf ~.json");
  check("A43-B04 a hostile file name cannot inject a command", !/[;\s]rm|;/.test(evil.unix) && !/;/.test(evil.windows), evil);
  check("A43-B05 describeBlueprintError: 401 / 403 (buyer vs refunded) / 404 / other",
    /Log in/.test(describeBlueprintError({ status: 401 })) && /buyers/.test(describeBlueprintError({ status: 403 })) && /refund/.test(describeBlueprintError({ status: 403, refunded: true }))
      && /hasn't attached/.test(describeBlueprintError({ status: 404 })) && /try again/i.test(describeBlueprintError({ status: 500 })) && /try again/i.test(describeBlueprintError()));
}

// ------------------------------------------------------------------ domain: demo info normaliser
{
  const good = { available: true, stepNames: ["A", "B"], maxInputChars: 2000, runsPerDay: 3, remainingToday: 2, budgetExhausted: false };
  check("A43-D01 toDemoInfo keeps a well-formed answer", JSON.stringify(toDemoInfo(good)) === JSON.stringify(good));
  for (const [label, raw] of [["null", null], ["undefined", undefined], ["string", "x"], ["available false", { available: false }], ["available 'true' string", { available: "true" }],
    ["no step names", { available: true, stepNames: [] }], ["step names not an array", { available: true, stepNames: "x" }], ["only non-string names", { available: true, stepNames: [1, null] }]]) {
    check(`A43-D02 toDemoInfo(${label}) -> { available:false }`, toDemoInfo(raw).available === false);
  }
  check("A43-D03 anonymous remainingToday null stays null; junk numbers fall back safely; step names capped at 2",
    toDemoInfo({ ...good, remainingToday: null }).remainingToday === null && toDemoInfo({ ...good, remainingToday: -4 }).remainingToday === 0
      && toDemoInfo({ ...good, maxInputChars: "x" }).maxInputChars === 2000 && toDemoInfo({ ...good, stepNames: ["a", "b", "c"] }).stepNames.length === 2 && toDemoInfo({ ...good, budgetExhausted: "yes" }).budgetExhausted === false);
  const calls = [];
  const ok = await getListingDemoInfo({ rpc: async (fn, args) => { calls.push({ fn, args }); return { data: good, error: null }; } }, "L1");
  check("A43-D04 getListingDemoInfo calls the right RPC with the right argument", ok.available && calls[0].fn === "listing_demo_info" && calls[0].args.p_listing_id === "L1", calls);
  const e1 = await getListingDemoInfo({ rpc: async () => ({ data: null, error: { message: "boom" } }) }, "L1");
  const e2 = await getListingDemoInfo({ rpc: async () => { throw new Error("network"); } }, "L1");
  check("A43-D05 an RPC error or a thrown exception never propagates: { available:false } (the listing page must always render)", e1.available === false && e2.available === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
