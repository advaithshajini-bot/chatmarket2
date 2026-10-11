// lib/demo/polling.js
//
// The client-side poll loop for a demo run, with NO React, NO fetch, NO timers of its own: every
// dependency is injected, so the whole state machine is unit-tested in plain `node` with a fake clock.
//
// Behaviour:
//   * backoff 0.8 s -> 1.2 -> 1.8 -> 2.5 -> 3.5 -> 5 s (then 5 s); first fetch after the first delay
//   * stops on a terminal run (`run.done`), on abort, on 401, on 404, after too many consecutive
//     failures (network / 429 / 5xx), or after maxWaitMs of VISIBLE time
//   * while the tab is hidden it makes NO requests, and the hidden time is not counted against maxWaitMs
//   * every request is the existing recovery-on-read endpoint, so a dead worker is recovered by the poll itself

export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
export const isTerminal = (status) => TERMINAL_STATUSES.has(status);

export const POLL_DELAYS_MS = [800, 1200, 1800, 2500, 3500, 5000];
export const nextDelayMs = (attempt) => POLL_DELAYS_MS[Math.min(Math.max(attempt, 0), POLL_DELAYS_MS.length - 1)];
// 3 steps' worth of worst case (30 s each) + the 120 s stale-recovery threshold would be ~210 s; a demo has
// at most 2 steps, so 3 minutes covers a normal run plus one recovery cycle.
export const DEFAULT_MAX_WAIT_MS = 180_000;
export const MAX_CONSECUTIVE_ERRORS = 4;

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener?.("abort", done); clearTimeout(t); resolve(); }
    signal?.addEventListener?.("abort", done, { once: true });
  });

/**
 * @param {object} o
 * @param {() => Promise<{status:number, json:any}>} o.fetchRun   one poll; may throw on network failure
 * @param {(run:any) => void} [o.onUpdate]                         called with every successful run view
 * @param {AbortSignal} [o.signal]
 * @param {(ms:number, signal?:AbortSignal) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.isHidden]
 * @param {(signal?:AbortSignal) => Promise<void>} [o.whenVisible]
 * @returns {Promise<{state:"done", run:any} | {state:"aborted"} | {state:"timeout"} | {state:"unauthenticated"}
 *                    | {state:"error", code:"not_found"|"network"|"bad_request"}>}
 */
export async function pollDemoRun({
  fetchRun, onUpdate = () => {}, signal, sleep = defaultSleep, now = Date.now,
  maxWaitMs = DEFAULT_MAX_WAIT_MS, maxConsecutiveErrors = MAX_CONSECUTIVE_ERRORS,
  isHidden = () => false, whenVisible = async () => {},
}) {
  const startedAt = now();
  let hiddenMs = 0;
  let attempt = 0;
  let errors = 0;

  for (;;) {
    if (signal?.aborted) return { state: "aborted" };

    await sleep(nextDelayMs(attempt), signal);
    if (signal?.aborted) return { state: "aborted" };

    if (isHidden()) {
      const hiddenAt = now();
      await whenVisible(signal);
      hiddenMs += now() - hiddenAt;
      if (signal?.aborted) return { state: "aborted" };
    }
    if (now() - startedAt - hiddenMs > maxWaitMs) return { state: "timeout" };

    let res;
    try {
      res = await fetchRun();
    } catch {
      errors += 1;
      if (errors >= maxConsecutiveErrors) return { state: "error", code: "network" };
      attempt += 1;
      continue;
    }

    if (res.status === 200 && res.json?.run) {
      errors = 0;
      onUpdate(res.json.run);
      if (res.json.run.done) return { state: "done", run: res.json.run };
      attempt += 1;
      continue;
    }
    if (res.status === 401) return { state: "unauthenticated" };
    if (res.status === 404) return { state: "error", code: "not_found" };
    if (res.status === 429 || res.status >= 500) {
      errors += 1;
      if (errors >= maxConsecutiveErrors) return { state: "error", code: "network" };
      attempt += 1;
      continue;
    }
    return { state: "error", code: "bad_request" };
  }
}
