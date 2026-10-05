"use client";

import { useEffect, useReducer, useRef } from "react";
import Link from "next/link";
import { Check, Circle, Loader2, Minus, Play, ShieldCheck, X } from "lucide-react";
import {
  initialState, reducer, outcome, isBusy, charCount, validateInput, canSubmit, stepViews, progressLabel,
} from "@/lib/demo/demo-state";
import { pollDemoRun } from "@/lib/demo/polling";
import { FAILURE_COPY, POLL_ERROR_COPY, describeStartError } from "@/lib/demo/failure";

// "Try it live" -- a real, capped sample run of a workflow/agent listing, for prospective buyers.
//
// All execution logic lives in THIS file and lib/demo/*; WorkflowAgentDetail only renders <TryDemo />.
// It talks to exactly two endpoints: POST /api/demo/runs (start) and GET /api/demo/runs/[id] (poll).
// Model output is untrusted text: it is rendered through React's normal escaping only -- there is no
// dangerouslySetInnerHTML anywhere in this component (a static test enforces that).
//
// `info` is the PUBLIC availability answer from public.listing_demo_info (never contains prompts).

const storageKey = (listingId) => `chatmarket:demo-run:${listingId}`;
const INK = "#14213D", MUTED = "#6B6F76", RULE = "#D8D5C9", TEAL = "#2F6F62", RED = "#B33A2E", AMBER = "#C68F2A";
const SANS = "'IBM Plex Sans', sans-serif", MONO = "'IBM Plex Mono', monospace";

function StepIcon({ status }) {
  if (status === "running") return <Loader2 size={16} className="animate-spin" color={AMBER} aria-hidden="true" />;
  if (status === "succeeded") return <Check size={16} color={TEAL} aria-hidden="true" />;
  if (status === "failed") return <X size={16} color={RED} aria-hidden="true" />;
  if (status === "skipped") return <Minus size={16} color={MUTED} aria-hidden="true" />;
  return <Circle size={16} color={RULE} aria-hidden="true" />;
}
const STATUS_WORDS = { pending: "waiting", running: "running", succeeded: "done", failed: "failed", skipped: "skipped" };

function Notice({ children, tone = "info" }) {
  const palette = tone === "error" ? { bg: "#FBEAE8", fg: RED } : { bg: "#EDEEEA", fg: "#3A3D42" };
  return (
    <div role="status" className="rounded p-3 mb-3 text-sm" style={{ background: palette.bg, color: palette.fg, fontFamily: SANS }}>
      {children}
    </div>
  );
}

// Pure presentation of one reducer state. Exported so every phase can be rendered and tested without a browser.
export function TryDemoView({ state, dispatch, info, isLoggedIn, listingId, onSubmit, onKeyDown }) {
  const max = info?.maxInputChars ?? 2000;
  const names = info?.stepNames ?? [];
  if (!info || !info.available) return null;

  const validity = validateInput(state.text, max);
  const count = charCount(state.text);
  const out = outcome(state);
  const views = stepViews(names, state.run);
  const showForm = state.phase === "idle" || state.phase === "starting";
  const showProgress = state.phase === "starting" || state.phase === "running" || state.phase === "stalled" || state.phase === "done";
  const limitReached = state.remaining === 0;

  return (
    <section aria-labelledby="try-demo-title" className="mb-8">
      <h2 id="try-demo-title" className="text-lg mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>
        Try it live
      </h2>
      <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: `1px solid ${RULE}` }}>
        <p className="text-sm mb-3" style={{ color: "#3A3D42", fontFamily: SANS }}>
          Run a real, capped sample of this workflow right here — free, no setup. The blueprint you would buy runs on your own
          machine with your own API keys.
        </p>

        {info.budgetExhausted && state.phase === "idle" && (
          <Notice>{describeStartError({ status: 503, reason: "demo_budget_exhausted" })}</Notice>
        )}

        {!isLoggedIn ? (
          <Link
            href={`/login?next=/listing/${listingId}`}
            className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm"
            style={{ background: INK, color: "#F7F7F4", fontFamily: SANS, fontWeight: 500 }}
          >
            <Play size={14} aria-hidden="true" /> Log in to try the demo
          </Link>
        ) : (
          <>
            {state.notice?.kind === "start_error" && <Notice tone="error">{describeStartError(state.notice)}</Notice>}
            {state.notice?.kind === "poll_error" && (
              <Notice tone={state.notice.code === "timeout" ? "info" : "error"}>
                {POLL_ERROR_COPY[state.notice.code] ?? POLL_ERROR_COPY.network}{" "}
                {state.notice.code === "unauthenticated" ? (
                  <Link href={`/login?next=/listing/${listingId}`} style={{ textDecoration: "underline" }}>Log in</Link>
                ) : (
                  state.runId && (
                    <button type="button" onClick={() => dispatch({ type: "RECHECK" })} style={{ textDecoration: "underline" }}>
                      Check again
                    </button>
                  )
                )}
              </Notice>
            )}

            {showForm && !info.budgetExhausted && !limitReached && (
              <div>
                <label htmlFor="try-demo-input" className="block text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>
                  Your input
                </label>
                <textarea
                  id="try-demo-input"
                  value={state.text}
                  onChange={(e) => dispatch({ type: "EDIT", text: e.target.value })}
                  onKeyDown={onKeyDown}
                  maxLength={max}
                  rows={4}
                  disabled={isBusy(state)}
                  aria-describedby="try-demo-hint"
                  placeholder="Paste or type a sample input for this workflow…"
                  className="w-full px-3 py-2 rounded text-sm outline-none resize-y"
                  style={{ border: `1px solid ${RULE}`, fontFamily: SANS, background: "#FFFFFF", color: INK }}
                />
                <div id="try-demo-hint" className="flex flex-wrap items-center justify-between gap-2 mt-1 text-xs" style={{ color: MUTED, fontFamily: SANS }}>
                  <span style={{ color: count > max * 0.95 ? AMBER : MUTED }}>{count} / {max} characters</span>
                  <span>Ctrl/⌘ + Enter to run</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 mt-3">
                  <button
                    type="button"
                    onClick={onSubmit}
                    disabled={!canSubmit(state, max)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm"
                    style={{
                      background: canSubmit(state, max) ? INK : RULE, color: "#F7F7F4", fontFamily: SANS, fontWeight: 500,
                      cursor: canSubmit(state, max) ? "pointer" : "not-allowed",
                    }}
                  >
                    {state.phase === "starting" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                    {state.phase === "starting" ? "Starting…" : "Run demo"}
                  </button>
                  {typeof state.remaining === "number" && (
                    <span className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>
                      {state.remaining} of {info.runsPerDay} demo runs left today
                    </span>
                  )}
                </div>
                {!validity.ok && validity.reason === "too_long" && (
                  <p className="text-xs mt-2" style={{ color: RED }}>Please keep it under {max} characters.</p>
                )}
              </div>
            )}

            {showForm && !info.budgetExhausted && limitReached && state.phase === "idle" && !state.notice && (
              <Notice>{describeStartError({ status: 429, reason: "demo_daily_limit" })}</Notice>
            )}

            {showProgress && (
              <div className="mt-1">
                <p role="status" aria-live="polite" className="text-sm mb-2" style={{ color: INK, fontFamily: SANS, fontWeight: 500 }}>
                  {progressLabel(state, names)}
                </p>
                <ol aria-label="Demo steps" className="space-y-2">
                  {views.map((v) => (
                    <li key={v.index} className="text-sm" style={{ color: "#3A3D42", fontFamily: SANS }}>
                      <div className="flex items-center gap-2">
                        <StepIcon status={v.status} />
                        <span>{v.name}</span>
                        <span className="text-xs" style={{ color: MUTED }}>({STATUS_WORDS[v.status] ?? v.status})</span>
                      </div>
                      {v.status === "succeeded" && v.text && views.length > 1 && v.index < views.length - 1 && (
                        <details className="mt-1 ml-6">
                          <summary className="text-xs cursor-pointer" style={{ color: MUTED }}>View this step&apos;s output</summary>
                          <div className="mt-1 p-2 rounded text-xs" style={{ background: "#FFFFFF", border: `1px solid ${RULE}`, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {v.text}
                          </div>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {state.phase === "done" && (
              <div className="mt-4">
                {out === "succeeded" ? (
                  <div>
                    <p className="text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>Result</p>
                    <div
                      className="p-3 rounded text-sm"
                      style={{ background: "#FFFFFF", border: `1px solid ${RULE}`, color: INK, fontFamily: SANS, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                    >
                      {state.run.result || "The model returned an empty answer."}
                    </div>
                    <p className="text-xs mt-2" style={{ color: MUTED, fontFamily: SANS }}>
                      AI-generated sample. Results from your own setup with your own keys may differ.
                    </p>
                  </div>
                ) : (
                  <Notice tone="error">{FAILURE_COPY[state.run?.failure] ?? FAILURE_COPY.unknown}</Notice>
                )}
                <div className="flex flex-wrap items-center gap-3 mt-3">
                  {limitReached ? (
                    <span className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>
                      {describeStartError({ status: 429, reason: "demo_daily_limit" })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "RESET" })}
                      className="px-4 py-2 rounded text-sm"
                      style={{ border: `1px solid ${RULE}`, color: INK, fontFamily: SANS, fontWeight: 500, background: "#FFFFFF" }}
                    >
                      {out === "succeeded" ? "Run again" : "Try again"}
                    </button>
                  )}
                  {typeof state.remaining === "number" && !limitReached && (
                    <span className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>
                      {state.remaining} of {info.runsPerDay} demo runs left today
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        <p className="flex items-start gap-1.5 mt-4 text-xs" style={{ color: MUTED, fontFamily: SANS }}>
          <ShieldCheck size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Don&apos;t enter passwords or personal data. Your input and the result are visible only to you and chatmarket staff
            (for abuse prevention) — not to the seller.
          </span>
        </p>
      </div>
    </section>
  );
}

export default function TryDemo({ listingId, info, isLoggedIn }) {
  const [state, dispatch] = useReducer(reducer, { remainingToday: info?.remainingToday ?? null }, initialState);
  const submitting = useRef(false);
  const max = info?.maxInputChars ?? 2000;
  const names = info?.stepNames ?? [];

  // Re-attach to a run that was in flight when the page was reloaded (does not spend another run).
  useEffect(() => {
    if (!isLoggedIn) return;
    try {
      const id = window.sessionStorage.getItem(storageKey(listingId));
      if (id) dispatch({ type: "RESUME", runId: id });
    } catch { /* storage unavailable: nothing to resume */ }
  }, [isLoggedIn, listingId]);

  // The poll loop. Re-runs only when the phase or run changes; cleanup aborts it (unmount, new run, done).
  useEffect(() => {
    if (state.phase !== "running" || !state.runId) return undefined;
    const ac = new AbortController();
    const runId = state.runId;
    const whenVisible = (signal) =>
      new Promise((resolve) => {
        if (!document.hidden) return resolve();
        const cleanup = () => { document.removeEventListener("visibilitychange", onChange); signal?.removeEventListener("abort", onAbort); };
        const onChange = () => { if (!document.hidden) { cleanup(); resolve(); } };
        const onAbort = () => { cleanup(); resolve(); };
        document.addEventListener("visibilitychange", onChange);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    pollDemoRun({
      fetchRun: async () => {
        const res = await fetch(`/api/demo/runs/${runId}`, { cache: "no-store", signal: ac.signal });
        let json = {};
        try { json = await res.json(); } catch { /* non-JSON error page */ }
        return { status: res.status, json };
      },
      onUpdate: (run) => dispatch({ type: "UPDATE", run }),
      signal: ac.signal,
      isHidden: () => typeof document !== "undefined" && document.hidden,
      whenVisible,
    }).then((result) => { if (!ac.signal.aborted) dispatch({ type: "POLL_END", result }); });
    return () => ac.abort();
  }, [state.phase, state.runId]);

  // Forget the stored run id once nothing is in flight.
  useEffect(() => {
    if (state.phase === "done" || (state.phase === "idle" && !state.runId)) {
      try { window.sessionStorage.removeItem(storageKey(listingId)); } catch { /* ignore */ }
    }
  }, [state.phase, state.runId, listingId]);

  if (!info || !info.available) return null;

  const submit = async () => {
    if (submitting.current || !canSubmit(state, max)) return;
    submitting.current = true;
    dispatch({ type: "START" });
    let res;
    let json = {};
    try {
      res = await fetch("/api/demo/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, text: state.text }),
      });
      try { json = await res.json(); } catch { /* ignore */ }
    } catch {
      submitting.current = false;
      dispatch({ type: "START_FAILED", status: 0 });
      return;
    }
    submitting.current = false;
    if (res.status === 201 && json.runId) {
      try { window.sessionStorage.setItem(storageKey(listingId), json.runId); } catch { /* ignore */ }
      dispatch({ type: "STARTED", runId: json.runId });
    } else {
      dispatch({ type: "START_FAILED", status: res.status, reason: json.reason });
    }
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  };

  return (
    <TryDemoView
      state={state}
      dispatch={dispatch}
      info={info}
      isLoggedIn={isLoggedIn}
      listingId={listingId}
      onSubmit={submit}
      onKeyDown={onKeyDown}
    />
  );
}
