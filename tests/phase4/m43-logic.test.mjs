// A43-L -- Milestone 4.3 client logic: failure classification + copy, the polling endpoint handler,
// and the poll loop (fake clock, no timers, no network, no DB).
// Run:  node tests/phase4/m43-logic.test.mjs
import { classifyDemoFailure, FAILURE_COPY, START_ERROR_COPY, describeStartError, POLL_ERROR_COPY } from "../../lib/demo/failure.js";
import { pollDemoRun, nextDelayMs, POLL_DELAYS_MS, DEFAULT_MAX_WAIT_MS, MAX_CONSECUTIVE_ERRORS, isTerminal } from "../../lib/demo/polling.js";
import { getDemoRunHandler, toPublicDemoRun, startDemoRunHandler } from "../../lib/demo/route-handlers.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const RID = "11111111-1111-4111-8111-111111111111";
const user = { id: "u1" };

// ------------------------------------------------------------------ failure classification
{
  const cases = [
    ["provider_http_429", "busy"], ["provider_http_500", "busy"], ["provider_http_529", "busy"], ["provider_http_503", "busy"],
    ["provider_timeout", "busy"], ["provider_network_error", "busy"], ["provider_bad_response", "busy"],
    ["stale_worker_recovered", "slow"], ["internal_budget_exceeded", "slow"],
    ["preflight_budget_exceeded", "too_big"], ["cost_limit_exceeded", "too_big"], ["output_limit_exceeded:bytes", "too_big"],
    ["run_cancelled", "cancelled"],
    ["provider_http_401", "unavailable"], ["provider_http_403", "unavailable"], ["provider_unconfigured", "unavailable"], ["demo_disabled", "unavailable"],
    ["approvals_disabled", "unavailable"], ["context_unavailable:model_not_allowed", "unavailable"], ["context_malformed", "unavailable"],
    ["config_invalid_for_execution:steps[0]", "unavailable"], ["demo_budget_exhausted", "unavailable"],
    ["provider_http_400", "unknown"], ["provider_http_404", "unknown"], ["something new", "unknown"], ["", "unknown"], [null, "unknown"], [undefined, "unknown"], [42, "unknown"],
  ];
  for (const [input, want] of cases) check(`A43-F01 classify ${JSON.stringify(input)} -> ${want}`, classifyDemoFailure(input) === want, classifyDemoFailure(input));
  check("A43-F02 every public failure code has user-facing copy, and the copy never contains an internal token",
    ["busy", "slow", "too_big", "unavailable", "cancelled", "unknown"].every(c => typeof FAILURE_COPY[c] === "string" && FAILURE_COPY[c].length > 10)
      && Object.values(FAILURE_COPY).every(t => !/provider_|http|CM0|budget_exceeded|_/.test(t)), FAILURE_COPY);
  const reasons = ["demo_daily_limit", "demo_budget_exhausted", "demo_disabled", "execution_disabled", "demo_not_available", "product_not_live", "invalid_demo_input"];
  check("A43-F03 every machine start-error reason maps to friendly copy", reasons.every(r => START_ERROR_COPY[r] && !/_/.test(START_ERROR_COPY[r])), Object.keys(START_ERROR_COPY));
  check("A43-F04 describeStartError: 401 asks to log in; known reason wins; 429 without a reason = daily limit; unknown = fallback",
    /Log in/.test(describeStartError({ status: 401 })) && describeStartError({ status: 503, reason: "demo_budget_exhausted" }) === START_ERROR_COPY.demo_budget_exhausted
      && describeStartError({ status: 429 }) === START_ERROR_COPY.demo_daily_limit && /Couldn't start/.test(describeStartError({ status: 500 })) && /Couldn't start/.test(describeStartError()));
  check("A43-F05 poll error copy exists for every poll failure code", ["unauthenticated", "not_found", "network", "bad_request", "timeout"].every(c => POLL_ERROR_COPY[c]));
}

// ------------------------------------------------------------------ polling endpoint handler
function dbClient({ run = { id: RID, status: "running", error: null, cost: "0", is_demo: true }, runErr = null, steps = [], stepsErr = null, recoverErr = null } = {}) {
  const log = { rpc: [], from: [], select: [], eq: [], order: [] };
  return {
    log,
    rpc: async (fn, args) => { log.rpc.push({ fn, args }); return { data: null, error: recoverErr }; },
    from(table) {
      log.from.push(table);
      const chain = {
        select(cols) { log.select.push(cols); return chain; },
        eq(c, v) { log.eq.push([c, v]); return chain; },
        order(c, o) { log.order.push([c, o]); return chain; },
        maybeSingle: async () => ({ data: runErr ? null : run, error: runErr }),
        then(resolve) { resolve({ data: stepsErr ? null : steps, error: stepsErr }); },
      };
      return chain;
    },
  };
}
{
  const c = dbClient();
  const r = await getDemoRunHandler({ supabase: c, user: null, runId: RID });
  check("A43-H01 not logged in: 401, no database access", r.status === 401 && c.log.from.length === 0 && c.log.rpc.length === 0);
  for (const bad of [undefined, null, 5, "", "nope", `${RID}/x`, "11111111-1111-4111-8111-11111111111g"]) {
    const c2 = dbClient(); const r2 = await getDemoRunHandler({ supabase: c2, user, runId: bad });
    check(`A43-H02 invalid run id ${JSON.stringify(bad)}: 404, no database access`, r2.status === 404 && c2.log.from.length === 0 && c2.log.rpc.length === 0);
  }
}
{
  const c = dbClient({ steps: [{ step_index: 0, status: "running", output: null }] });
  const r = await getDemoRunHandler({ supabase: c, user, runId: RID });
  check("A43-H03 recovery-on-read runs first, with the run id", c.log.rpc.length === 1 && c.log.rpc[0].fn === "worker_recover_stale_run" && c.log.rpc[0].args.p_run_id === RID, c.log.rpc);
  check("A43-H04 reads ONLY the columns the widget needs (never execution_config / input / select *), steps ordered by index",
    c.log.select[0] === "id, status, error, cost, is_demo" && c.log.select[1] === "step_index, status, output"
      && c.log.order[0][0] === "step_index" && c.log.eq[0][1] === RID, c.log);
  check("A43-H05 a running run: 200, done=false, no failure, no result", r.status === 200 && r.json.run.done === false && r.json.run.failure === null && r.json.run.result === null
    && r.json.run.steps.length === 1 && r.json.run.steps[0].status === "running" && r.json.run.steps[0].text === null, r.json);
}
{
  const r = await getDemoRunHandler({ supabase: dbClient({ run: { id: RID, status: "succeeded", error: null, cost: "0.34120000", is_demo: true },
    steps: [{ step_index: 0, status: "succeeded", output: { mode: "demo", text: "draft", usage: { input_tokens: 5 }, idempotency_key: "k" } }, { step_index: 1, status: "succeeded", output: { text: "final answer" } }] }), user, runId: RID });
  check("A43-H06 succeeded: done, result = the LAST step's text, steps carry text only, cost rounded to 4dp",
    r.json.run.done && r.json.run.status === "succeeded" && r.json.run.result === "final answer" && r.json.run.costInr === 0.3412
      && JSON.stringify(r.json.run.steps) === JSON.stringify([{ index: 0, status: "succeeded", text: "draft" }, { index: 1, status: "succeeded", text: "final answer" }]), r.json);
  check("A43-H07 nothing internal leaks: no usage, idempotency key, model, or raw output object in the response",
    !/usage|idempotency|input_tokens|execution_config|"output"/.test(JSON.stringify(r.json)), r.json);
}
{
  const fails = [["provider_http_529", "busy"], ["stale_worker_recovered", "slow"], ["preflight_budget_exceeded", "too_big"], ["provider_unconfigured", "unavailable"], ["weird_new_error", "unknown"]];
  for (const [err, code] of fails) {
    const r = await getDemoRunHandler({ supabase: dbClient({ run: { id: RID, status: "failed", error: err, cost: 0, is_demo: true }, steps: [{ step_index: 0, status: "failed", output: null }] }), user, runId: RID });
    check(`A43-H08 failed(${err}) -> failure '${code}'; the raw error string is NOT in the response`, r.json.run.failure === code && r.json.run.done && !JSON.stringify(r.json).includes(err), r.json);
  }
  const cancelled = await getDemoRunHandler({ supabase: dbClient({ run: { id: RID, status: "cancelled", error: null, cost: 0, is_demo: true } }), user, runId: RID });
  const timed = await getDemoRunHandler({ supabase: dbClient({ run: { id: RID, status: "timed_out", error: null, cost: 0, is_demo: true } }), user, runId: RID });
  check("A43-H09 cancelled -> 'cancelled', timed_out -> 'slow', both done", cancelled.json.run.failure === "cancelled" && timed.json.run.failure === "slow" && cancelled.json.run.done && timed.json.run.done);
}
{
  const nd = await getDemoRunHandler({ supabase: dbClient({ run: { id: RID, status: "running", error: null, cost: 0, is_demo: false } }), user, runId: RID });
  check("A43-H10 a NON-demo run is a 404 here (this endpoint is not a generic run reader)", nd.status === 404, nd);
  const none = await getDemoRunHandler({ supabase: dbClient({ run: null }), user, runId: RID });
  check("A43-H11 a run the user cannot see (RLS returns no row): 404", none.status === 404);
  const err = await getDemoRunHandler({ supabase: dbClient({ runErr: { message: "db internals" } }), user, runId: RID });
  check("A43-H12 run lookup failure: generic 500, internals not echoed", err.status === 500 && !JSON.stringify(err.json).includes("internals"), err);
  const degraded = await getDemoRunHandler({ supabase: dbClient({ stepsErr: { message: "x" } }), user, runId: RID });
  check("A43-H13 a steps read failure degrades to the run status with no steps (still 200)", degraded.status === 200 && degraded.json.run.steps.length === 0);
  const rec = await getDemoRunHandler({ supabase: dbClient({ recoverErr: { message: "recover failed" } }), user, runId: RID });
  check("A43-H14 a recovery RPC error is logged but does not fail the poll", rec.status === 200);
  const long = toPublicDemoRun({ id: RID, status: "succeeded", error: null, cost: 0, is_demo: true }, [{ step_index: 0, status: "succeeded", output: { text: "z".repeat(50_000) } }]);
  check("A43-H15 step text is capped at 20,000 characters", long.steps[0].text.length === 20000 && long.result.length === 20000);
  const odd = toPublicDemoRun({ id: RID, status: "succeeded", error: null, cost: null, is_demo: true }, [{ step_index: 0, status: "succeeded", output: { text: 5 } }, { step_index: 1, status: "succeeded", output: null }]);
  check("A43-H16 non-string / missing outputs yield null text and no result; null cost -> 0", odd.result === null && odd.costInr === 0 && odd.steps.every(s => s.text === null));
}
{
  const r = await startDemoRunHandler({ supabase: { rpc: async () => ({ data: null, error: { code: "CM033", message: "demo_daily_limit" } }) }, user, body: { listingId: RID, text: "x" } });
  check("A43-H17 start errors now carry the machine `reason` for the UI (429 + demo_daily_limit)", r.status === 429 && r.json.reason === "demo_daily_limit" && r.json.error === "demo_daily_limit", r);
  const g = await startDemoRunHandler({ supabase: { rpc: async () => ({ data: null, error: { code: "XX000", message: "internal detail" } }) }, user, body: { listingId: RID, text: "x" } });
  check("A43-H18 an unknown start error stays a generic 500 with NO reason", g.status === 500 && g.json.reason === undefined && !JSON.stringify(g.json).includes("internal detail"), g);
}

// ------------------------------------------------------------------ poll loop with a fake clock
function harness({ responses, hidden = [], maxWaitMs, maxConsecutiveErrors }) {
  let t = 0; const delays = []; const fetches = []; const updates = []; let i = 0, h = 0;
  const sleep = async (ms) => { delays.push(ms); t += ms; };
  const fetchRun = async () => {
    fetches.push(t);
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  const opts = { fetchRun, onUpdate: (r) => updates.push(r), sleep, now: () => t, maxWaitMs, maxConsecutiveErrors,
    isHidden: () => hidden.length ? hidden[Math.min(h++, hidden.length - 1)] : false,
    whenVisible: async () => { t += 600_000; } };
  return { opts, delays, fetches, updates, get t() { return t; } };
}
const run = (status, done = false, extra = {}) => ({ status: 200, json: { run: { id: RID, status, done, steps: [], ...extra } } });
{
  check("A43-P01 backoff schedule: 0.8, 1.2, 1.8, 2.5, 3.5, 5 s then stays at 5 s", [0, 1, 2, 3, 4, 5, 6, 20].map(nextDelayMs).join() === "800,1200,1800,2500,3500,5000,5000,5000" && POLL_DELAYS_MS.length === 6);
  check("A43-P01b nextDelayMs clamps negatives", nextDelayMs(-3) === 800);
  const h = harness({ responses: [run("queued"), run("running"), run("running"), run("succeeded", true, { result: "ok" })] });
  const res = await pollDemoRun(h.opts);
  check("A43-P02 polls until done: 4 fetches, delays follow the schedule, onUpdate saw every view, resolves {state:'done', run}",
    res.state === "done" && res.run.result === "ok" && h.fetches.length === 4 && h.delays.join() === "800,1200,1800,2500" && h.updates.length === 4, { res, delays: h.delays });
  const quick = harness({ responses: [run("succeeded", true)] });
  const q1 = await pollDemoRun(quick.opts);
  check("A43-P03 a run that is already done on the first poll resolves after ONE delay and ONE fetch", q1.state === "done" && quick.fetches.length === 1 && quick.delays.length === 1);
  check("A43-P04 terminal statuses recognised", ["succeeded", "failed", "cancelled", "timed_out"].every(isTerminal) && !["queued", "running", "waiting_for_approval", undefined].some(isTerminal));
}
{
  const h = harness({ responses: [run("running")], maxWaitMs: 10_000 });
  const res = await pollDemoRun(h.opts);
  check("A43-P05 never-finishing run: gives up with {state:'timeout'} once maxWaitMs of visible time has passed (and not before)", res.state === "timeout" && h.t > 10_000 && h.t < 10_000 + 6_000, h.t);
  check("A43-P05b the default maximum wait is 3 minutes", DEFAULT_MAX_WAIT_MS === 180_000);
}
{
  const ctl = new AbortController();
  const h = harness({ responses: [run("running")] });
  h.opts.signal = ctl.signal;
  h.opts.sleep = async (ms) => { h.delays.push(ms); if (h.delays.length === 2) ctl.abort(); };
  const res = await pollDemoRun(h.opts);
  check("A43-P06 abort (component unmounted / new run started): resolves {state:'aborted'} and stops fetching", res.state === "aborted" && h.fetches.length <= 1, { res, fetches: h.fetches.length });
  const pre = new AbortController(); pre.abort();
  const h2 = harness({ responses: [run("running")] }); h2.opts.signal = pre.signal;
  const r2 = await pollDemoRun(h2.opts);
  check("A43-P07 already-aborted signal: no sleep, no fetch", r2.state === "aborted" && h2.fetches.length === 0 && h2.delays.length === 0);
}
{
  const a = await pollDemoRun(harness({ responses: [{ status: 401, json: {} }] }).opts);
  const b = await pollDemoRun(harness({ responses: [{ status: 404, json: {} }] }).opts);
  const c = await pollDemoRun(harness({ responses: [{ status: 400, json: {} }] }).opts);
  const d = await pollDemoRun(harness({ responses: [{ status: 200, json: {} }] }).opts);
  check("A43-P08 401 -> unauthenticated; 404 -> not_found; other 4xx / malformed 200 -> bad_request (no retry storm)",
    a.state === "unauthenticated" && b.state === "error" && b.code === "not_found" && c.code === "bad_request" && d.code === "bad_request", { a, b, c, d });
}
{
  const h = harness({ responses: [{ status: 503, json: {} }, new Error("net"), { status: 429, json: {} }, run("running"), { status: 500, json: {} }, new Error("net"), run("succeeded", true)] });
  const res = await pollDemoRun(h.opts);
  check("A43-P09 transient failures (5xx / 429 / network) are retried and the error counter RESETS after a good response", res.state === "done" && h.fetches.length === 7, { res, n: h.fetches.length });
  const bad = harness({ responses: [{ status: 503, json: {} }] });
  const r2 = await pollDemoRun(bad.opts);
  check(`A43-P10 ${MAX_CONSECUTIVE_ERRORS} consecutive failures give up with {state:'error', code:'network'}`, r2.state === "error" && r2.code === "network" && bad.fetches.length === MAX_CONSECUTIVE_ERRORS, { r2, n: bad.fetches.length });
  const thrown = harness({ responses: [new Error("offline")] });
  const r3 = await pollDemoRun(thrown.opts);
  check("A43-P11 a fetch that always throws also gives up as 'network'", r3.state === "error" && r3.code === "network" && thrown.fetches.length === MAX_CONSECUTIVE_ERRORS);
  const custom = harness({ responses: [{ status: 503, json: {} }], maxConsecutiveErrors: 2 });
  const r4 = await pollDemoRun(custom.opts);
  check("A43-P12 the failure budget is configurable", r4.code === "network" && custom.fetches.length === 2);
}
{
  // hidden tab: no requests while hidden, and hidden time is not counted against maxWaitMs
  const h = harness({ responses: [run("running"), run("succeeded", true)], hidden: [true, false], maxWaitMs: 20_000 });
  const res = await pollDemoRun(h.opts);
  check("A43-P13 a tab that is hidden pauses polling (waits for visibility, no request while hidden) and the 10-minute hidden stretch does NOT cause a timeout",
    res.state === "done" && h.fetches.length === 2 && h.t >= 600_000, { res, t: h.t });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
