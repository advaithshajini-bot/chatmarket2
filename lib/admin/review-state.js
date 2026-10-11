// lib/admin/review-state.js -- Moderation Desk UI state as a PURE reducer (unit-tested in plain node).

import { MIN_REJECT_NOTE } from "./review-constants.js";

export function initialDeskState(queue = { demos: [], blueprints: [] }) {
  return { queue, selected: null, detail: null, detailPhase: "idle", note: "", decisionPhase: "idle", notice: null };
}

export function deskReducer(state, action) {
  switch (action.type) {
    case "QUEUE": return { ...state, queue: action.queue };
    case "SELECT": return { ...state, selected: { kind: action.kind, id: action.id }, detail: null, detailPhase: "loading", note: "", decisionPhase: "idle", notice: null };
    case "DETAIL_OK":
      if (!state.selected || state.selected.id !== action.id) return state;      // stale response for a previous selection
      return { ...state, detail: action.detail, detailPhase: "ready" };
    case "DETAIL_FAIL":
      if (!state.selected || state.selected.id !== action.id) return state;
      return { ...state, detailPhase: "error", notice: { kind: "error", text: action.error } };
    case "NOTE": return { ...state, note: String(action.value ?? "").slice(0, 1000) };
    case "DECIDE_START": return { ...state, decisionPhase: "submitting", notice: null };
    case "DECIDE_OK": {
      const q = state.queue;
      const queue = state.selected?.kind === "demo"
        ? { ...q, demos: q.demos.filter((d) => d.listingId !== state.selected.id) }
        : { ...q, blueprints: q.blueprints.filter((b) => b.submissionId !== state.selected?.id) };
      return { ...state, queue, selected: null, detail: null, detailPhase: "idle", note: "", decisionPhase: "idle",
        notice: { kind: "ok", text: action.decision === "approve" ? "Approved." : "Rejected. The seller can see your note." } };
    }
    case "DECIDE_FAIL":
      return { ...state, decisionPhase: "idle", notice: { kind: "error", text: action.error }, stale: action.status === 409 };
    case "CLOSE": return { ...state, selected: null, detail: null, detailPhase: "idle", note: "", notice: null };
    default: return state;
  }
}

export const noteLength = (s) => s.note.trim().length;
export const canReject = (s) => s.detailPhase === "ready" && s.decisionPhase === "idle" && noteLength(s) >= MIN_REJECT_NOTE;
/** Approving a blueprint needs a live verification that matches the submitted hash and finds no credentials. */
export function canApprove(s) {
  if (s.detailPhase !== "ready" || s.decisionPhase !== "idle" || !s.detail) return false;
  if (s.selected?.kind === "blueprint") {
    const v = s.detail.verification;
    return !!v && v.status === "match" && Array.isArray(v.blocking) && v.blocking.length === 0;
  }
  return s.detail.demo?.isEnabled === true && s.detail.demo?.reviewStatus === "pending_admin_approval";
}
