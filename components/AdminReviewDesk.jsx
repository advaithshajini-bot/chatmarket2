"use client";

import { useReducer } from "react";
import { AlertTriangle, CheckCircle2, FileJson, Loader2, MessageSquare, XCircle } from "lucide-react";
import { deskReducer, initialDeskState, canApprove, canReject, noteLength } from "@/lib/admin/review-state";
import { MIN_REJECT_NOTE } from "@/lib/admin/review-constants";
import { formatBytes, formatLabel } from "@/lib/blueprints/format";

// Admin Moderation Desk: the queue of seller demos and blueprints waiting for approval.
//
// Talks to exactly these endpoints (a static test enforces it):
//   GET  /api/admin/reviews                            the queue
//   GET  /api/admin/reviews/demos/[id]                 a demo with its prompts (the reviewer must see what they approve)
//   POST /api/admin/reviews/demos/[id]                 approve | reject  (carries the version the admin reviewed)
//   GET  /api/admin/reviews/blueprints/[id]            a submission + live re-verification of the stored file
//   POST /api/admin/reviews/blueprints/[id]            approve | reject  (the SERVER re-hashes the stored bytes first)
// Admin + MFA is enforced inside every RPC; this page only decides what to draw. Seller text (prompts, sample input,
// names) is rendered through React's escaping as plain text -- never as HTML.

const INK = "#14213D", MUTED = "#6B6F76", RULE = "#D8D5C9", TEAL = "#2F6F62", RED = "#B33A2E", AMBER = "#C68F2A", GOLD = "#E2A83E";
const SANS = "'IBM Plex Sans', sans-serif", MONO = "'IBM Plex Mono', monospace";
const card = { background: "#FFFFFF", border: `1px solid ${RULE}` };
const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return ""; } };
const VERIFY_WORDS = {
  match: ["Stored file re-checked: matches what the seller submitted.", TEAL],
  mismatch: ["The stored file has CHANGED since it was submitted. Do not approve.", RED],
  missing: ["The stored file could not be found.", RED],
  invalid: ["The stored file is no longer a valid blueprint.", RED],
};
const pre = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: MONO, fontSize: 12, background: "#F7F7F4", border: `1px solid ${RULE}`, padding: 8, borderRadius: 4, color: INK };

function Findings({ items, tone }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-1 space-y-1">
      {items.map((f) => (
        <li key={`${f.type}@${f.path}`} className="text-xs flex items-start gap-1.5" style={{ color: tone === "error" ? RED : "#7A5A12", fontFamily: SANS }}>
          <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span><strong>{String(f.type).replace(/_/g, " ")}</strong> at <code style={{ fontFamily: MONO }}>{f.path}</code></span>
        </li>
      ))}
    </ul>
  );
}

function DemoDetail({ demo }) {
  const steps = Array.isArray(demo.demoConfig?.steps) ? demo.demoConfig.steps : [];
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ fontFamily: SANS, color: INK }}><strong>{demo.title}</strong> - by {demo.sellerName} - version {demo.configVersion}{demo.isEnabled ? "" : " (disabled by seller)"}</p>
      <div>
        <p className="text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>Example input buyers can use</p>
        <div style={pre}>{demo.sampleInput ?? "(none)"}</div>
      </div>
      {steps.map((s, i) => (
        <div key={i}>
          <p className="text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>
            Step {i + 1}{s.name ? ` - ${s.name}` : ""} - {s.model} - max {s.maxOutputTokens} tokens - {s.timeoutSeconds ?? 30}s
          </p>
          <div style={pre}>{s.system}</div>
        </div>
      ))}
    </div>
  );
}

function BlueprintDetail({ detail }) {
  const { blueprint: b, verification: v, downloadUrl } = detail;
  const [word, colour] = VERIFY_WORDS[v?.status] ?? ["Not verified.", RED];
  return (
    <div className="space-y-3">
      <p className="text-sm" style={{ fontFamily: SANS, color: INK }}><strong>{b.title}</strong> - by {b.sellerName} - {formatLabel(b.format)} - {formatBytes(b.sizeBytes)}</p>
      <div>
        <p className="text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>SHA-256 recorded at submission</p>
        <div style={pre}>{b.sha256}</div>
      </div>
      <p role="status" className="text-sm flex items-start gap-1.5" style={{ color: colour, fontFamily: SANS }}>
        {v?.status === "match" ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" aria-hidden="true" /> : <XCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />}
        {word}
      </p>
      {v?.status === "match" && <p className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>{v.nodeCount} node{v.nodeCount === 1 ? "" : "s"}</p>}
      {v?.blocking?.length > 0 && (<><p className="text-xs" style={{ color: RED, fontFamily: SANS }}>Looks like credentials - this can&apos;t be approved:</p><Findings items={v.blocking} tone="error" /></>)}
      {v?.warnings?.length > 0 && (<><p className="text-xs" style={{ color: "#7A5A12", fontFamily: SANS }}>Worth a look:</p><Findings items={v.warnings} tone="warn" /></>)}
      {downloadUrl && (
        <a href={downloadUrl} rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm" style={{ color: INK, textDecoration: "underline", fontFamily: SANS }}>
          <FileJson size={14} color={GOLD} aria-hidden="true" /> Download to inspect (link expires in 60 seconds)
        </a>
      )}
    </div>
  );
}

// Pure presentation (no hooks): every state of the desk can be rendered and tested without a browser.
export function AdminReviewDeskView({ state, dispatch, onSelect, onDecide }) {
  const { queue, selected, detail, detailPhase, decisionPhase } = state;
  const nothing = queue.demos.length === 0 && queue.blueprints.length === 0;
  const need = MIN_REJECT_NOTE - noteLength(state);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Moderation desk</h1>
        <p className="text-sm mt-1" style={{ color: MUTED, fontFamily: SANS }}>Demos and blueprints waiting for approval. Nothing reaches buyers until you approve it.</p>
      </header>

      {state.notice && (
        <div role="status" aria-live="polite" className="rounded p-3 text-sm"
          style={{ background: state.notice.kind === "ok" ? "#E4F1EC" : "#FBEAE8", color: state.notice.kind === "ok" ? TEAL : RED, fontFamily: SANS }}>
          {state.notice.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="rounded-md p-4 lg:col-span-1" style={card} aria-labelledby="desk-queue-title">
          <h2 id="desk-queue-title" className="text-base mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Queue</h2>
          {nothing && <p className="text-sm" style={{ color: MUTED, fontFamily: SANS }}>Nothing is waiting. Nice.</p>}
          {queue.demos.length > 0 && <p className="text-xs uppercase tracking-wide mt-2 mb-1" style={{ fontFamily: MONO, color: MUTED }}>Demos ({queue.demos.length})</p>}
          <ul className="space-y-1">
            {queue.demos.map((d) => (
              <li key={d.listingId}>
                <button type="button" onClick={() => onSelect("demo", d.listingId)} aria-current={selected?.id === d.listingId ? "true" : undefined}
                  className="w-full text-left rounded p-2 text-sm" style={{ border: `1px solid ${selected?.id === d.listingId ? INK : RULE}`, fontFamily: SANS, color: INK }}>
                  <span className="block" style={{ fontWeight: 600 }}>{d.title}</span>
                  <span className="block text-xs" style={{ color: MUTED }}>{d.sellerName} - {d.stepCount} step{d.stepCount === 1 ? "" : "s"} - {when(d.submittedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          {queue.blueprints.length > 0 && <p className="text-xs uppercase tracking-wide mt-3 mb-1" style={{ fontFamily: MONO, color: MUTED }}>Blueprints ({queue.blueprints.length})</p>}
          <ul className="space-y-1">
            {queue.blueprints.map((b) => (
              <li key={b.submissionId}>
                <button type="button" onClick={() => onSelect("blueprint", b.submissionId)} aria-current={selected?.id === b.submissionId ? "true" : undefined}
                  className="w-full text-left rounded p-2 text-sm" style={{ border: `1px solid ${selected?.id === b.submissionId ? INK : RULE}`, fontFamily: SANS, color: INK }}>
                  <span className="block" style={{ fontWeight: 600 }}>{b.title}</span>
                  <span className="block text-xs" style={{ color: MUTED }}>{b.sellerName} - {formatLabel(b.format)} - {formatBytes(b.sizeBytes)} - {when(b.submittedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md p-4 lg:col-span-2" style={card} aria-labelledby="desk-detail-title">
          <h2 id="desk-detail-title" className="text-base mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Review</h2>
          {!selected && <p className="text-sm" style={{ color: MUTED, fontFamily: SANS }}>Pick an item from the queue.</p>}
          {selected && detailPhase === "loading" && <p className="text-sm flex items-center gap-2" style={{ color: MUTED, fontFamily: SANS }}><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading…</p>}
          {selected && detailPhase === "ready" && detail && (
            <>
              {selected.kind === "demo" ? <DemoDetail demo={detail.demo} /> : <BlueprintDetail detail={detail} />}
              <div className="mt-5">
                <label htmlFor="desk-note" className="flex items-center gap-1 text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>
                  <MessageSquare size={12} aria-hidden="true" /> Note to the seller (required to reject)
                </label>
                <textarea id="desk-note" rows={3} maxLength={1000} value={state.note} disabled={decisionPhase === "submitting"}
                  onChange={(e) => dispatch({ type: "NOTE", value: e.target.value })} className="w-full px-3 py-2 rounded text-sm outline-none resize-y"
                  style={{ border: `1px solid ${RULE}`, fontFamily: SANS, color: INK }} />
                {need > 0 && state.note.length > 0 && <p className="text-xs mt-1" style={{ color: MUTED, fontFamily: SANS }}>{need} more character{need === 1 ? "" : "s"} to enable Reject.</p>}
                <div className="flex flex-wrap items-center gap-3 mt-3">
                  <button type="button" onClick={() => onDecide("approve")} disabled={!canApprove(state)} className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm"
                    style={{ background: canApprove(state) ? TEAL : "#C9CCD1", color: "#FFFFFF", fontFamily: SANS }}>
                    {decisionPhase === "submitting" && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Approve
                  </button>
                  <button type="button" onClick={() => onDecide("reject")} disabled={!canReject(state)} className="px-4 py-2 rounded text-sm"
                    style={{ background: "#FFFFFF", border: `1px solid ${RED}`, color: RED, fontFamily: SANS, opacity: canReject(state) ? 1 : 0.5 }}>
                    Reject
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

const call = async (url, method, body) => {
  const res = await fetch(url, { method, cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json };
};
const detailUrl = (kind, id) => `/api/admin/reviews/${kind === "demo" ? "demos" : "blueprints"}/${id}`;

export default function AdminReviewDesk({ initialQueue }) {
  const [state, dispatch] = useReducer(deskReducer, initialQueue, initialDeskState);

  const load = async (kind, id) => {
    const r = await call(detailUrl(kind, id), "GET");
    dispatch(r.ok ? { type: "DETAIL_OK", id, detail: r.json } : { type: "DETAIL_FAIL", id, error: r.json?.error ?? "Could not load this item." });
  };
  const refreshQueue = async () => {
    const r = await call("/api/admin/reviews", "GET");
    if (r.ok && r.json?.queue) dispatch({ type: "QUEUE", queue: r.json.queue });
  };
  const onSelect = (kind, id) => { dispatch({ type: "SELECT", kind, id }); load(kind, id); };

  const onDecide = async (decision) => {
    const { selected, detail } = state;
    if (!selected || state.decisionPhase !== "idle") return;
    if (decision === "approve" ? !canApprove(state) : !canReject(state)) return;
    dispatch({ type: "DECIDE_START" });
    const body = selected.kind === "demo"
      ? { decision, expectedVersion: detail.demo.configVersion, note: state.note }
      : { decision, note: state.note };
    const r = await call(detailUrl(selected.kind, selected.id), "POST", body);
    if (r.ok) { dispatch({ type: "DECIDE_OK", decision }); return; }
    dispatch({ type: "DECIDE_FAIL", status: r.status, error: r.json?.error ?? "Could not record the decision." });
    if (r.status === 409) { refreshQueue(); load(selected.kind, selected.id); }     // the item changed under us: show the new state
  };

  return <AdminReviewDeskView state={state} dispatch={dispatch} onSelect={onSelect} onDecide={onDecide} />;
}
