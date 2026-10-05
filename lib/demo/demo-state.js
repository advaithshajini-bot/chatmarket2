// lib/demo/demo-state.js
//
// The Try Demo widget's state machine as a PURE reducer (no React), so every transition is unit-tested
// in plain node. components/TryDemo.jsx only wires it to fetch + effects.
//
// phase:  idle      form shown (or a notice above it)
//         starting  POST /api/demo/runs in flight
//         running   run created, polling
//         stalled   polling gave up (timeout / network / session) -- the run may still finish; user can re-check
//         done      terminal run (succeeded OR failed -- see outcome())

export const MAX_INPUT_CHARS_DEFAULT = 2000;

export function initialState({ remainingToday = null } = {}) {
  return { phase: "idle", text: "", runId: null, run: null, remaining: remainingToday, notice: null };
}

export function reducer(state, action) {
  switch (action.type) {
    case "EDIT":
      return { ...state, text: action.text };

    case "START":
      return { ...state, phase: "starting", notice: null };

    case "START_FAILED": {
      const limit = action.reason === "demo_daily_limit";
      return {
        ...state, phase: "idle", runId: null, run: null,
        remaining: limit ? 0 : state.remaining,
        notice: { kind: "start_error", status: action.status, reason: action.reason ?? null },
      };
    }

    case "STARTED":
      return {
        ...state, phase: "running", runId: action.runId, run: null, notice: null,
        remaining: typeof state.remaining === "number" ? Math.max(0, state.remaining - 1) : state.remaining,
      };

    case "RESUME": // re-attach to a run (page reload / "check again"); never changes the remaining count
      return { ...state, phase: "running", runId: action.runId, notice: null };

    case "UPDATE": {
      if (!action.run || action.run.id !== state.runId || state.phase === "idle") return state; // stale update
      return { ...state, run: action.run, phase: action.run.done ? "done" : state.phase === "stalled" ? "running" : state.phase };
    }

    case "POLL_END": {
      const r = action.result;
      if (!r || r.state === "aborted") return state;
      if (r.state === "done") return { ...state, phase: "done", run: r.run, notice: null };
      if (r.state === "timeout") return { ...state, phase: "stalled", notice: { kind: "poll_error", code: "timeout" } };
      if (r.state === "unauthenticated") return { ...state, phase: "stalled", notice: { kind: "poll_error", code: "unauthenticated" } };
      if (r.state === "error") {
        // a run that cannot be found is over: drop it so the user can start fresh
        if (r.code === "not_found") return { ...state, phase: "idle", runId: null, run: null, notice: { kind: "poll_error", code: "not_found" } };
        return { ...state, phase: "stalled", notice: { kind: "poll_error", code: r.code } };
      }
      return state;
    }

    case "RECHECK":
      return state.runId ? { ...state, phase: "running", notice: null } : state;

    case "RESET":
      return { ...state, phase: "idle", text: "", runId: null, run: null, notice: null };

    default:
      return state;
  }
}

// ------------------------------------------------------------------ selectors
export const outcome = (s) => (s.phase === "done" && s.run ? (s.run.status === "succeeded" ? "succeeded" : "failed") : null);
export const isBusy = (s) => s.phase === "starting" || s.phase === "running";
export const charCount = (text) => [...(text ?? "")].length; // characters, not UTF-16 units: matches the DB's char_length
export function validateInput(text, max = MAX_INPUT_CHARS_DEFAULT) {
  const n = charCount(text);
  if (n === 0 || /^\s*$/.test(text ?? "")) return { ok: false, reason: "empty", count: n };
  if (n > max) return { ok: false, reason: "too_long", count: n };
  return { ok: true, reason: null, count: n };
}
export const canSubmit = (s, max) => !isBusy(s) && validateInput(s.text, max).ok && s.remaining !== 0;
export function stepViews(stepNames, run) {
  const byIndex = new Map((run?.steps ?? []).map((st) => [st.index, st]));
  return (stepNames ?? []).map((name, i) => {
    const st = byIndex.get(i);
    return { index: i, name, status: st?.status ?? "pending", text: st?.text ?? null };
  });
}
export function progressLabel(s, stepNames) {
  const n = (stepNames ?? []).length;
  if (s.phase === "starting") return "Starting your demo…";
  if (s.phase === "stalled") return "Still working…";
  if (s.phase === "done") return outcome(s) === "succeeded" ? "Finished" : "Did not complete";
  if (s.phase !== "running") return "";
  const views = stepViews(stepNames, s.run);
  const active = views.findIndex((v) => v.status === "running");
  if (active >= 0) return `Running step ${active + 1} of ${n}…`;
  const next = views.findIndex((v) => v.status === "pending");
  if (next >= 0 && views.some((v) => v.status === "succeeded")) return `Running step ${next + 1} of ${n}…`;
  return "Queued — waiting for a worker…";
}
