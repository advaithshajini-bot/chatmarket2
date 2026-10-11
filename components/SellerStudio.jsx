"use client";

import { useReducer, useRef } from "react";
import { AlertTriangle, CheckCircle2, FileJson, Loader2, Plus, ShieldCheck, Trash2, Upload } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LIMITS, MAX_STEPS, reviewLabel, validateDraft } from "@/lib/studio/demo-draft";
import { previewBlueprint, runBlueprintUpload } from "@/lib/studio/upload-flow";
import {
  studioReducer, initialStudioState, isDirty, isBusy, canSubmitDemo, canUploadBlueprint, editingWithdraws,
} from "@/lib/studio/studio-state";
import { formatBytes, formatLabel } from "@/lib/blueprints/format";

// Seller Studio: attach a blueprint and author a "try it live" demo for ONE listing, then submit both for admin review.
//
// Boundaries (a static test enforces them): this component talks to exactly three endpoints --
//   PUT  /api/studio/listings/[id]/demo            save the draft
//   POST /api/studio/listings/[id]/demo/submit     send it to the review queue
//   POST /api/studio/listings/[id]/blueprint       register an uploaded blueprint (the server re-inspects it)
// plus one Storage upload into the private 'listing-blueprints' bucket under the seller's OWN session (Storage RLS
// is the access check). No service key, no direct table or RPC access, no HTML injection. The hash and format shown
// here come from the browser and are a convenience: the server recomputes both from the stored bytes.

const INK = "#14213D", MUTED = "#6B6F76", RULE = "#D8D5C9", TEAL = "#2F6F62", RED = "#B33A2E", AMBER = "#C68F2A", GOLD = "#E2A83E";
const SANS = "'IBM Plex Sans', sans-serif", MONO = "'IBM Plex Mono', monospace";
const card = { background: "#FFFFFF", border: `1px solid ${RULE}` };
const field = { border: `1px solid ${RULE}`, fontFamily: SANS, background: "#FFFFFF", color: INK };
const STATUS_TONE = { draft: "#EDEEEA", pending_admin_approval: "#FFF4DC", approved: "#E4F1EC", rejected: "#FBEAE8", pending: "#FFF4DC", superseded: "#EDEEEA" };
const SUBMISSION_WORDS = { pending: "Waiting for admin review", approved: "Approved - live", rejected: "Changes requested", superseded: "Replaced" };

function Chip({ status, children }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded text-xs" style={{ background: STATUS_TONE[status] ?? "#EDEEEA", color: INK, fontFamily: SANS }}>
      {children}
    </span>
  );
}
function FieldError({ id, message }) {
  return message ? <p id={id} role="alert" className="text-xs mt-1" style={{ color: RED, fontFamily: SANS }}>{message}</p> : null;
}
function Findings({ items, tone }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-2 space-y-1">
      {items.map((f) => (
        <li key={`${f.type}@${f.path}`} className="text-xs flex items-start gap-1.5" style={{ color: tone === "error" ? RED : "#7A5A12", fontFamily: SANS }}>
          <AlertTriangle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span><strong>{String(f.type).replace(/_/g, " ")}</strong> at <code style={{ fontFamily: MONO }}>{f.path}</code></span>
        </li>
      ))}
    </ul>
  );
}

// Pure presentation of one reducer state (no hooks) so every state can be rendered and tested without a browser.
export function SellerStudioView({ state, dispatch, title, models, eligible, onPickFile, onUpload, onSave, onSubmit }) {
  const allowed = models.map((m) => m.model);
  const busy = isBusy(state);
  const bp = state.blueprint;
  const { draft, errors } = state;
  const submitOk = canSubmitDemo(state, allowed);
  const validity = validateDraft(draft, allowed);

  if (!eligible) {
    return (
      <section className="rounded-md p-5" style={card} aria-labelledby="studio-title">
        <h1 id="studio-title" className="text-xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Seller Studio</h1>
        <p className="text-sm" style={{ color: "#3A3D42", fontFamily: SANS }}>Demos and blueprints are available for workflow and agent listings only.</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 id="studio-title" className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Seller Studio</h1>
        <p className="text-sm mt-1" style={{ color: MUTED, fontFamily: SANS }}>{title}</p>
      </header>

      {state.notice && (
        <div role="status" aria-live="polite" className="rounded p-3 text-sm"
          style={{ background: state.notice.kind === "ok" ? "#E4F1EC" : "#FBEAE8", color: state.notice.kind === "ok" ? TEAL : RED, fontFamily: SANS }}>
          {state.notice.text}
        </div>
      )}

      {/* ------------------------------------------------------------- blueprint */}
      <section className="rounded-md p-5" style={card} aria-labelledby="studio-bp-title">
        <h2 id="studio-bp-title" className="flex items-center gap-2 text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>
          <FileJson size={18} color={GOLD} aria-hidden="true" /> Blueprint file
        </h2>
        <p className="text-xs mb-3" style={{ color: MUTED, fontFamily: SANS }}>
          Upload the .json export from n8n, Flowise or LangFlow (max 5 MB). Remove API keys and passwords first - files that contain credentials are refused.
          Buyers can only download it after an admin approves it.
        </p>
        {state.liveBlueprint && (
          <p className="text-xs mb-3" style={{ color: TEAL, fontFamily: SANS }}>
            <CheckCircle2 size={13} className="inline mr-1" aria-hidden="true" />
            Live now: {formatLabel(state.liveBlueprint.format)}{state.liveBlueprint.sizeBytes ? ` (${formatBytes(state.liveBlueprint.sizeBytes)})` : ""}
          </p>
        )}
        <label htmlFor="studio-file" className="block text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>Choose file</label>
        <input id="studio-file" type="file" accept=".json,application/json" disabled={busy} onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          className="block text-sm" style={{ fontFamily: SANS }} />

        {bp.phase === "error" && (
          <div role="alert" className="mt-3 text-sm" style={{ color: RED, fontFamily: SANS }}>
            {bp.error}
            <Findings items={bp.findings} tone="error" />
          </div>
        )}
        {(bp.phase === "ready" || bp.phase === "done") && bp.inspection && (
          <div className="mt-3 rounded p-3 text-sm" style={{ background: "#F7F7F4", border: `1px solid ${RULE}`, fontFamily: SANS, color: INK }}>
            <p><strong>{formatLabel(bp.inspection.format)}</strong> - {formatBytes(bp.inspection.sizeBytes)} - {bp.inspection.nodeCount} node{bp.inspection.nodeCount === 1 ? "" : "s"}</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>SHA-256 (what buyers will be able to verify):</p>
            <p className="text-xs" style={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{bp.inspection.sha256}</p>
            {bp.inspection.scan.blocking.length > 0 && (
              <>
                <p className="text-xs mt-2" style={{ color: RED }}>This file appears to contain credentials and can&apos;t be uploaded:</p>
                <Findings items={bp.inspection.scan.blocking} tone="error" />
              </>
            )}
            {bp.warnings.length > 0 && (
              <>
                <p className="text-xs mt-2" style={{ color: "#7A5A12" }}>Worth a second look (these won&apos;t block the upload):</p>
                <Findings items={bp.warnings} tone="warn" />
              </>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onUpload} disabled={!canUploadBlueprint(state)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm"
            style={{ background: canUploadBlueprint(state) ? INK : "#C9CCD1", color: "#FFFFFF", fontFamily: SANS }}>
            {state.busy === "uploading" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
            Upload and submit for review
          </button>
        </div>

        {state.submissions.length > 0 && (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>Recent submissions</p>
            <ul className="space-y-2">
              {state.submissions.map((s) => (
                <li key={s.id} className="text-sm" style={{ fontFamily: SANS, color: INK }}>
                  <Chip status={s.status}>{SUBMISSION_WORDS[s.status] ?? s.status}</Chip>{" "}
                  {formatLabel(s.format)}{s.sizeBytes ? ` - ${formatBytes(s.sizeBytes)}` : ""}
                  {s.status === "rejected" && s.reviewNote && <p className="text-xs mt-1" style={{ color: RED }}>Reviewer: {s.reviewNote}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------- demo */}
      <section className="rounded-md p-5" style={card} aria-labelledby="studio-demo-title">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h2 id="studio-demo-title" className="text-lg" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: INK }}>Try-it-live demo</h2>
          <Chip status={state.demo.reviewStatus}>{reviewLabel(state.demo.reviewStatus)}</Chip>
        </div>
        <p className="text-xs mb-3" style={{ color: MUTED, fontFamily: SANS }}>
          A capped sample run buyers can try before purchasing: up to {MAX_STEPS} prompt steps, no tools. Your instructions stay private to you and the
          reviewing admin; buyers see only the step names and your example input.
        </p>
        {state.demo.reviewStatus === "rejected" && state.demo.reviewNote && (
          <p role="status" className="text-sm mb-3 rounded p-3" style={{ background: "#FBEAE8", color: RED, fontFamily: SANS }}>Reviewer: {state.demo.reviewNote}</p>
        )}
        {editingWithdraws(state) && (
          <p className="text-xs mb-3" style={{ color: "#7A5A12", fontFamily: SANS }}>
            Changing anything below withdraws {state.demo.reviewStatus === "approved" ? "the approval" : "your submission"} until you submit it again.
          </p>
        )}

        <label className="flex items-center gap-2 text-sm mb-4" style={{ fontFamily: SANS, color: INK }}>
          <input type="checkbox" checked={draft.isEnabled} disabled={busy} onChange={(e) => dispatch({ type: "DRAFT", action: { type: "setEnabled", value: e.target.checked } })} />
          Offer this demo on the listing page
        </label>

        <label htmlFor="studio-sample" className="block text-xs uppercase tracking-wide mb-1" style={{ fontFamily: MONO, color: MUTED }}>Example input</label>
        <textarea id="studio-sample" rows={4} maxLength={LIMITS.sampleMax} value={draft.sampleInput} disabled={busy}
          onChange={(e) => dispatch({ type: "DRAFT", action: { type: "setSample", value: e.target.value } })}
          aria-invalid={!!errors.sampleInput} aria-describedby="studio-sample-err" className="w-full px-3 py-2 rounded text-sm outline-none resize-y" style={field}
          placeholder="Something a buyer could run through your workflow in one click…" />
        <div className="text-xs mt-1" style={{ color: MUTED, fontFamily: SANS }}>{[...draft.sampleInput].length} / {LIMITS.sampleMax} characters</div>
        <FieldError id="studio-sample-err" message={errors.sampleInput} />

        <div className="mt-5 space-y-4">
          {draft.steps.map((step, i) => (
            <fieldset key={i} className="rounded p-3" style={{ border: `1px solid ${RULE}` }} disabled={busy}>
              <legend className="px-1 text-xs uppercase tracking-wide" style={{ fontFamily: MONO, color: MUTED }}>Step {i + 1}</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`step-${i}-name`} className="block text-xs mb-1" style={{ color: MUTED, fontFamily: SANS }}>Name buyers see</label>
                  <input id={`step-${i}-name`} type="text" maxLength={LIMITS.nameMax} value={step.name}
                    onChange={(e) => dispatch({ type: "DRAFT", action: { type: "updateStep", index: i, field: "name", value: e.target.value } })}
                    className="w-full px-3 py-2 rounded text-sm outline-none" style={field} placeholder={`Step ${i + 1}`} />
                  <FieldError message={errors[`steps.${i}.name`]} />
                </div>
                <div>
                  <label htmlFor={`step-${i}-model`} className="block text-xs mb-1" style={{ color: MUTED, fontFamily: SANS }}>Model</label>
                  <select id={`step-${i}-model`} value={step.model}
                    onChange={(e) => dispatch({ type: "DRAFT", action: { type: "updateStep", index: i, field: "model", value: e.target.value } })}
                    className="w-full px-3 py-2 rounded text-sm outline-none" style={field}>
                    {step.model === "" && <option value="">Choose…</option>}
                    {models.map((m) => <option key={m.model} value={m.model}>{m.model} ({m.tier === "economy" ? "economy" : "higher quality"})</option>)}
                  </select>
                  <FieldError message={errors[`steps.${i}.model`]} />
                </div>
              </div>
              <label htmlFor={`step-${i}-system`} className="block text-xs mt-3 mb-1" style={{ color: MUTED, fontFamily: SANS }}>Instructions (private)</label>
              <textarea id={`step-${i}-system`} rows={6} maxLength={LIMITS.systemMax} value={step.system}
                onChange={(e) => dispatch({ type: "DRAFT", action: { type: "updateStep", index: i, field: "system", value: e.target.value } })}
                className="w-full px-3 py-2 rounded text-sm outline-none resize-y" style={field} />
              <div className="text-xs mt-1" style={{ color: MUTED, fontFamily: SANS }}>{[...step.system].length} / {LIMITS.systemMax} characters</div>
              <FieldError message={errors[`steps.${i}.system`]} />
              <div className="grid grid-cols-2 gap-3 mt-3">
                <div>
                  <label htmlFor={`step-${i}-tokens`} className="block text-xs mb-1" style={{ color: MUTED, fontFamily: SANS }}>Max output tokens (1-{LIMITS.tokensMax})</label>
                  <input id={`step-${i}-tokens`} type="text" inputMode="numeric" value={step.maxOutputTokens}
                    onChange={(e) => dispatch({ type: "DRAFT", action: { type: "updateStep", index: i, field: "maxOutputTokens", value: e.target.value } })}
                    className="w-full px-3 py-2 rounded text-sm outline-none" style={field} />
                  <FieldError message={errors[`steps.${i}.maxOutputTokens`]} />
                </div>
                <div>
                  <label htmlFor={`step-${i}-timeout`} className="block text-xs mb-1" style={{ color: MUTED, fontFamily: SANS }}>Time limit, seconds (1-{LIMITS.timeoutMax})</label>
                  <input id={`step-${i}-timeout`} type="text" inputMode="numeric" value={step.timeoutSeconds}
                    onChange={(e) => dispatch({ type: "DRAFT", action: { type: "updateStep", index: i, field: "timeoutSeconds", value: e.target.value } })}
                    className="w-full px-3 py-2 rounded text-sm outline-none" style={field} />
                  <FieldError message={errors[`steps.${i}.timeoutSeconds`]} />
                </div>
              </div>
              {draft.steps.length > 1 && (
                <button type="button" onClick={() => dispatch({ type: "DRAFT", action: { type: "removeStep", index: i } })}
                  className="inline-flex items-center gap-1 mt-3 text-xs" style={{ color: RED, fontFamily: SANS }}>
                  <Trash2 size={12} aria-hidden="true" /> Remove step {i + 1}
                </button>
              )}
            </fieldset>
          ))}
        </div>
        <FieldError message={errors.steps} />

        <div className="mt-3">
          <button type="button" onClick={() => dispatch({ type: "DRAFT", action: { type: "addStep", defaultModel: models.find((m) => m.isDefault)?.model ?? models[0]?.model ?? "" } })}
            disabled={busy || draft.steps.length >= MAX_STEPS} className="inline-flex items-center gap-1 text-sm"
            style={{ color: draft.steps.length >= MAX_STEPS ? MUTED : INK, fontFamily: SANS }}>
            <Plus size={14} aria-hidden="true" /> {draft.steps.length >= MAX_STEPS ? `Up to ${MAX_STEPS} steps` : "Add a second step"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-5">
          <button type="button" onClick={onSave} disabled={busy || !isDirty(state)} className="px-4 py-2 rounded text-sm"
            style={{ background: "#FFFFFF", border: `1px solid ${INK}`, color: INK, fontFamily: SANS, opacity: busy || !isDirty(state) ? 0.5 : 1 }}>
            {state.busy === "saving" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" onClick={onSubmit} disabled={!submitOk} className="inline-flex items-center gap-2 px-4 py-2 rounded text-sm"
            style={{ background: submitOk ? INK : "#C9CCD1", color: "#FFFFFF", fontFamily: SANS }}>
            {state.busy === "submitting" ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
            Submit for review
          </button>
          {!validity.ok && <span className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>Complete every field to submit.</span>}
        </div>
      </section>
    </div>
  );
}

const post = async (url, method, body) => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { ok: res.ok, status: res.status, json };
};

export default function SellerStudio({ listingId, sellerId, title, eligible, models, initial }) {
  const [state, dispatch] = useReducer(studioReducer, initial, initialStudioState);
  const fileRef = useRef(null);
  const inFlight = useRef(false);
  const allowed = models.map((m) => m.model);
  const demoUrl = `/api/studio/listings/${listingId}/demo`;

  const pickFile = async (file) => {
    fileRef.current = file;
    if (!file) { dispatch({ type: "FILE_CLEAR" }); return; }
    const r = await previewBlueprint(file);
    if (fileRef.current !== file) return;                       // a newer choice replaced this one
    dispatch(r.ok ? { type: "FILE_PREVIEW_OK", fileName: file.name, inspection: r.inspection } : { type: "FILE_PREVIEW_FAIL", fileName: file.name, error: r.error });
  };

  const upload = async () => {
    if (inFlight.current || !fileRef.current || !canUploadBlueprint(state)) return;
    inFlight.current = true;
    dispatch({ type: "UPLOAD_START" });
    const supabase = createClient();
    const r = await runBlueprintUpload({
      file: fileRef.current, sellerId, listingId,
      upload: (path, file) => supabase.storage.from("listing-blueprints").upload(path, file, { contentType: "application/json", upsert: false }),
      register: (path) => post(`/api/studio/listings/${listingId}/blueprint`, "POST", { path }),
    });
    inFlight.current = false;
    dispatch(r.ok ? { type: "UPLOAD_OK", registered: r.registered, at: new Date().toISOString() } : { type: "UPLOAD_FAIL", error: r.error, findings: r.findings });
  };

  const save = async () => {
    const v = validateDraft(state.draft, allowed);
    if (!v.ok) { dispatch({ type: "ERRORS", errors: v.errors }); return false; }
    dispatch({ type: "SAVE_START" });
    const r = await post(demoUrl, "PUT", state.draft);
    if (!r.ok) { dispatch({ type: "SAVE_FAIL", error: r.json?.error, errors: r.json?.errors }); return false; }
    dispatch({ type: "SAVE_OK", demo: r.json.demo });
    return true;
  };
  const onSave = async () => { if (inFlight.current) return; inFlight.current = true; try { await save(); } finally { inFlight.current = false; } };

  const onSubmit = async () => {
    if (inFlight.current || !canSubmitDemo(state, allowed)) return;
    inFlight.current = true;
    try {
      if (isDirty(state) && !(await save())) return;
      dispatch({ type: "SUBMIT_START" });
      const r = await post(`${demoUrl}/submit`, "POST");
      dispatch(r.ok ? { type: "SUBMIT_OK", demo: r.json.demo } : { type: "SUBMIT_FAIL", error: r.json?.error });
    } finally { inFlight.current = false; }
  };

  return (
    <SellerStudioView state={state} dispatch={dispatch} title={title} models={models} eligible={eligible}
      onPickFile={pickFile} onUpload={upload} onSave={onSave} onSubmit={onSubmit} />
  );
}
