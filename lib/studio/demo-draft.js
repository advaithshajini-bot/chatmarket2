// lib/studio/demo-draft.js -- the Seller Studio's demo form as pure data + rules.
//
// These rules MIRROR private.assert_demo_config (migration 20260930100500) so a seller gets instant, specific
// feedback. They are a convenience only: the database re-validates every save and every approval, and the
// server route re-validates before calling it. If this file and the database ever disagree, the database wins.

export const MAX_STEPS = 2;
export const LIMITS = Object.freeze({
  systemMax: 3000, nameMax: 100, tokensMin: 1, tokensMax: 1024, timeoutMin: 1, timeoutMax: 30, sampleMax: 2000,
});
export const DEFAULT_TOKENS = 300;
export const DEFAULT_TIMEOUT = 20;

export const blankStep = (model = "") => ({ name: "", model, system: "", maxOutputTokens: String(DEFAULT_TOKENS), timeoutSeconds: String(DEFAULT_TIMEOUT) });
export const emptyDraft = (defaultModel = "") => ({ sampleInput: "", isEnabled: true, steps: [blankStep(defaultModel)] });

const toInt = (v) => (typeof v === "number" ? v : /^\d{1,6}$/.test(String(v ?? "").trim()) ? Number(String(v).trim()) : NaN);
const isBlank = (s) => typeof s !== "string" || s.trim() === "";
const len = (s) => [...String(s ?? "")].length;          // code points, like the 2000-char input rule elsewhere

/** @returns {{ok:boolean, errors:Record<string,string>}}  keys: sampleInput, steps, steps.<i>.<field> */
export function validateDraft(draft, allowedModels = []) {
  const errors = {};
  if (!draft || typeof draft !== "object") return { ok: false, errors: { draft: "Nothing to save." } };
  if (isBlank(draft.sampleInput)) errors.sampleInput = "Add a sample input buyers can try with one click.";
  else if (len(draft.sampleInput) > LIMITS.sampleMax) errors.sampleInput = `Keep the sample input under ${LIMITS.sampleMax} characters.`;
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  if (steps.length < 1) errors.steps = "Add at least one step.";
  else if (steps.length > MAX_STEPS) errors.steps = `A demo can have at most ${MAX_STEPS} steps.`;
  steps.slice(0, MAX_STEPS + 1).forEach((s, i) => {
    const k = (f) => `steps.${i}.${f}`;
    if (!s || typeof s !== "object") { errors[k("system")] = "Invalid step."; return; }
    if (len(s.name) > LIMITS.nameMax) errors[k("name")] = `Keep the step name under ${LIMITS.nameMax} characters.`;
    if (typeof s.model !== "string" || !allowedModels.includes(s.model)) errors[k("model")] = "Choose one of the available models.";
    if (isBlank(s.system)) errors[k("system")] = "Write the instructions for this step.";
    else if (len(s.system.trim()) > LIMITS.systemMax) errors[k("system")] = `Keep the instructions under ${LIMITS.systemMax} characters.`;
    const t = toInt(s.maxOutputTokens);
    if (!Number.isInteger(t) || t < LIMITS.tokensMin || t > LIMITS.tokensMax) errors[k("maxOutputTokens")] = `Max output must be a whole number from ${LIMITS.tokensMin} to ${LIMITS.tokensMax}.`;
    const o = toInt(s.timeoutSeconds);
    if (!Number.isInteger(o) || o < LIMITS.timeoutMin || o > LIMITS.timeoutMax) errors[k("timeoutSeconds")] = `Time limit must be a whole number of seconds from ${LIMITS.timeoutMin} to ${LIMITS.timeoutMax}.`;
  });
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Draft -> the exact object public.save_listing_demo expects (strict keys; no tools, ever). Call only after validateDraft. */
export function draftToConfig(draft) {
  return {
    steps: draft.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      ...(isBlank(s.name) ? {} : { name: s.name.trim() }),
      model: s.model,
      system: s.system.trim(),
      maxOutputTokens: toInt(s.maxOutputTokens),
      timeoutSeconds: toInt(s.timeoutSeconds),
    })),
  };
}

export function configToDraft(config, sampleInput, isEnabled = true) {
  const steps = Array.isArray(config?.steps) ? config.steps.slice(0, MAX_STEPS) : [];
  return {
    sampleInput: typeof sampleInput === "string" ? sampleInput : "",
    isEnabled: isEnabled !== false,
    steps: steps.map((s) => ({
      name: typeof s?.name === "string" ? s.name : "",
      model: typeof s?.model === "string" ? s.model : "",
      system: typeof s?.system === "string" ? s.system : "",
      maxOutputTokens: String(Number.isInteger(s?.maxOutputTokens) ? s.maxOutputTokens : DEFAULT_TOKENS),
      timeoutSeconds: String(Number.isInteger(s?.timeoutSeconds) ? s.timeoutSeconds : DEFAULT_TIMEOUT),
    })),
  };
}

const STEP_FIELDS = ["name", "model", "system", "maxOutputTokens", "timeoutSeconds"];
export function draftReducer(draft, action) {
  switch (action?.type) {
    case "reset": return action.draft;
    case "setSample": return { ...draft, sampleInput: String(action.value ?? "") };
    case "setEnabled": return { ...draft, isEnabled: action.value === true };
    case "addStep": return draft.steps.length >= MAX_STEPS ? draft : { ...draft, steps: [...draft.steps, blankStep(action.defaultModel ?? draft.steps[0]?.model ?? "")] };
    case "removeStep": return draft.steps.length <= 1 || !draft.steps[action.index] ? draft : { ...draft, steps: draft.steps.filter((_, i) => i !== action.index) };
    case "updateStep": {
      if (!draft.steps[action.index] || !STEP_FIELDS.includes(action.field)) return draft;
      return { ...draft, steps: draft.steps.map((s, i) => (i === action.index ? { ...s, [action.field]: String(action.value ?? "") } : s)) };
    }
    default: return draft;
  }
}

export const REVIEW_LABELS = {
  draft: "Draft", pending_admin_approval: "Waiting for admin review", approved: "Approved", rejected: "Changes requested",
};
export const reviewLabel = (s) => REVIEW_LABELS[s] ?? "Draft";
