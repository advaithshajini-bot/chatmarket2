// lib/studio/studio-state.js -- the Seller Studio's UI state machine as a PURE reducer (no React), so every
// transition is unit-tested in plain node. components/SellerStudio.jsx only wires it to fetch + the file input.

import { draftReducer, validateDraft } from "./demo-draft.js";

export function initialStudioState({ draft, demo = null, submissions = [], liveBlueprint = null }) {
  return {
    draft,
    savedJson: demo ? JSON.stringify(draft) : null,          // null = never saved
    errors: {},
    demo: { reviewStatus: demo?.reviewStatus ?? "draft", reviewNote: demo?.reviewNote ?? null, configVersion: demo?.configVersion ?? null },
    blueprint: { phase: "idle", fileName: null, inspection: null, error: null, findings: null, warnings: [] },
    liveBlueprint,
    submissions,
    busy: null,                                               // "saving" | "submitting" | "uploading"
    notice: null,                                             // { kind: "ok" | "error", text }
  };
}

export function studioReducer(state, action) {
  switch (action.type) {
    case "DRAFT":
      return { ...state, draft: draftReducer(state.draft, action.action), errors: {}, notice: null };
    case "ERRORS":
      return { ...state, errors: action.errors ?? {}, notice: { kind: "error", text: "Please fix the highlighted fields." } };

    case "SAVE_START": return { ...state, busy: "saving", notice: null };
    case "SAVE_OK":
      return { ...state, busy: null, errors: {}, savedJson: JSON.stringify(state.draft), demo: { ...state.demo, ...action.demo, reviewNote: null },
        notice: { kind: "ok", text: action.demo?.reviewStatus === "draft" ? "Draft saved." : "Saved." } };
    case "SAVE_FAIL":
      return { ...state, busy: null, errors: action.errors ?? {}, notice: { kind: "error", text: action.error ?? "Could not save the demo." } };

    case "SUBMIT_START": return { ...state, busy: "submitting", notice: null };
    case "SUBMIT_OK":
      return { ...state, busy: null, demo: { ...state.demo, ...action.demo, reviewNote: null }, notice: { kind: "ok", text: "Submitted. An admin will review it." } };
    case "SUBMIT_FAIL":
      return { ...state, busy: null, notice: { kind: "error", text: action.error ?? "Could not submit the demo." } };

    case "FILE_PREVIEW_OK":
      return { ...state, blueprint: { phase: "ready", fileName: action.fileName, inspection: action.inspection, error: null, findings: null, warnings: action.inspection.scan.warnings }, notice: null };
    case "FILE_PREVIEW_FAIL":
      return { ...state, blueprint: { phase: "error", fileName: action.fileName ?? null, inspection: null, error: action.error, findings: null, warnings: [] } };
    case "FILE_CLEAR":
      return { ...state, blueprint: initialStudioState({ draft: state.draft }).blueprint };

    case "UPLOAD_START": return { ...state, busy: "uploading", notice: null };
    case "UPLOAD_OK": {
      const r = action.registered;
      return {
        ...state, busy: null,
        blueprint: { phase: "done", fileName: state.blueprint.fileName, inspection: state.blueprint.inspection, error: null, findings: null, warnings: r.warnings ?? [] },
        submissions: [{ id: r.submissionId, format: r.format, sizeBytes: r.sizeBytes, status: "pending", reviewNote: null, submittedAt: action.at ?? null },
          ...state.submissions.map((s) => (s.status === "pending" ? { ...s, status: "superseded" } : s))].slice(0, 5),
        notice: { kind: "ok", text: "Blueprint submitted. An admin will review it before buyers can download it." },
      };
    }
    case "UPLOAD_FAIL":
      return { ...state, busy: null, blueprint: { ...state.blueprint, phase: "error", error: action.error, findings: action.findings ?? null } };
    default: return state;
  }
}

// ------------------------------------------------------------------ selectors
export const isDirty = (s) => s.savedJson === null || s.savedJson !== JSON.stringify(s.draft);
export const isBusy = (s) => s.busy !== null;
export const hasPendingBlueprint = (s) => s.submissions.some((x) => x.status === "pending");
/** A demo may be submitted when it is valid, enabled, and not already waiting / approved (unless edited since). */
export function canSubmitDemo(s, allowedModels) {
  if (isBusy(s)) return false;
  if (!validateDraft(s.draft, allowedModels).ok || !s.draft.isEnabled) return false;
  if (isDirty(s)) return true;                                // save-then-submit; saving withdraws any earlier state
  return s.demo.reviewStatus === "draft" || s.demo.reviewStatus === "rejected";
}
export const canUploadBlueprint = (s) => !isBusy(s) && s.blueprint.phase === "ready" && s.blueprint.inspection?.scan.blocking.length === 0;
export const editingWithdraws = (s) => s.demo.reviewStatus === "pending_admin_approval" || s.demo.reviewStatus === "approved";
