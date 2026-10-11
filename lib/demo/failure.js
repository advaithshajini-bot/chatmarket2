// lib/demo/failure.js
//
// Pure helpers (no React, no network). Turns the worker's internal failure strings into a small set of
// PUBLIC codes, and each code into copy a prospective buyer can act on. The raw strings (provider status
// codes, budget internals, config paths) never leave the server.

const PROVIDER_BUSY = /^provider_http_(429|5\d\d)$/;

/** @returns {"busy"|"slow"|"too_big"|"unavailable"|"cancelled"|"unknown"} */
export function classifyDemoFailure(error) {
  if (typeof error !== "string" || error === "") return "unknown";
  if (PROVIDER_BUSY.test(error) || error === "provider_timeout" || error === "provider_network_error" || error === "provider_bad_response") return "busy";
  if (error === "stale_worker_recovered" || error === "internal_budget_exceeded") return "slow";
  if (error === "preflight_budget_exceeded" || error === "cost_limit_exceeded" || error.startsWith("output_limit_exceeded")) return "too_big";
  if (error === "run_cancelled") return "cancelled";
  if (/^provider_http_(401|403)$/.test(error) || error === "provider_unconfigured" || error === "demo_disabled" || error === "approvals_disabled"
      || error.startsWith("context_") || error.startsWith("config_") || error.startsWith("demo_")) return "unavailable";
  return "unknown";
}

export const FAILURE_COPY = {
  busy: "The AI service is busy right now. This run didn't complete — please try again in a minute.",
  slow: "That took longer than expected and was stopped. Try a shorter input.",
  too_big: "That input was too large for a free demo run. Try something shorter.",
  unavailable: "This demo is temporarily unavailable. Please try again later.",
  cancelled: "This run was cancelled.",
  unknown: "Something went wrong and the run didn't complete.",
};

/** Copy for the machine `reason` strings returned when a demo cannot be STARTED. */
export const START_ERROR_COPY = {
  demo_daily_limit: "You've used all of your demo runs for today. Come back tomorrow — or buy the blueprint to run it on your own setup.",
  demo_budget_exhausted: "Demos are resting for today (the daily demo budget is used up). Please try again tomorrow.",
  demo_disabled: "Demos are paused right now. Please try again later.",
  execution_disabled: "Demos are paused right now. Please try again later.",
  demo_not_available: "This listing doesn't have a live demo.",
  product_not_live: "This listing isn't live.",
  invalid_demo_input: "Please enter between 1 and 2,000 characters.",
};
export const START_ERROR_FALLBACK = "Couldn't start the demo. Please try again.";

export function describeStartError({ status, reason } = {}) {
  if (status === 401) return "Log in to try the demo.";
  if (reason && START_ERROR_COPY[reason]) return START_ERROR_COPY[reason];
  if (status === 429) return START_ERROR_COPY.demo_daily_limit;
  return START_ERROR_FALLBACK;
}

export const POLL_ERROR_COPY = {
  unauthenticated: "Your session expired. Log in again to see the result.",
  not_found: "We couldn't find that run.",
  network: "We lost the connection while waiting for the result. Check your connection and try again.",
  bad_request: "We couldn't read the status of that run.",
  timeout: "This is taking longer than usual. The run may still finish — check back in a moment.",
};
