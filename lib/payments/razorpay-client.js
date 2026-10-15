// lib/payments/razorpay-client.js -- the ONLY file that talks to Razorpay's Route API. Every HTTP call goes through
// an injectable `fetchImpl`, so tests (and a dry run) never touch the network.
//
// Every method returns { ok: true, ... } or { ok: false, retryable, status, code, description }.
//   retryable = network error / timeout / 429 / 5xx. A 4xx is the request's fault and retrying cannot fix it.
// The request/response shapes below follow Razorpay's Route docs but have NOT been exercised against a real account
// (Route is not activated yet) -- supabase/manual/phase5_2_review_golive.md lists what to confirm first.
import { normalizeTransferEntity } from "./transfer-events.js";
import { normalizeRefundEntity } from "./refund-events.js";

const short = (s, n = 200) => (typeof s === "string" ? s.slice(0, n) : "");

export function createRazorpayClient({ keyId, keySecret, fetchImpl = globalThis.fetch, baseUrl = "https://api.razorpay.com", timeoutMs = 8000 }) {
  const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  async function request(method, path, body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      const timedOut = ac.signal.aborted || e?.name === "AbortError";
      return { ok: false, retryable: true, status: 0, code: timedOut ? "timeout" : "network_error", description: timedOut ? "request timed out" : "network error" };
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      return { ok: false, retryable, status: res.status, code: short(data?.error?.code, 60) || `http_${res.status}`, description: short(data?.error?.description) };
    }
    return { ok: true, status: res.status, data };
  }

  // retryable: a 200 we cannot read may still have created the transfer; the retry LISTS before it ever creates.
  const bad = (what) => ({ ok: false, retryable: true, status: 200, code: "bad_response", description: what });
  const one = (data) => (Array.isArray(data?.items) ? data.items[0] : data);

  return {
    /** Create the Route transfer for a captured payment. Held until `holdUntilEpoch`, or indefinitely, or not at all. */
    async createTransfer({ paymentId, account, amountPaise, onHold, holdUntilEpoch, notes }) {
      const t = { account, amount: amountPaise, currency: "INR", notes: notes ?? {}, on_hold: !!onHold };
      if (onHold && Number.isInteger(holdUntilEpoch)) t.on_hold_until = holdUntilEpoch;
      const r = await request("POST", `/v1/payments/${encodeURIComponent(paymentId)}/transfers`, { transfers: [t] });
      if (!r.ok) return r;
      const transfer = normalizeTransferEntity(one(r.data));
      return transfer ? { ok: true, transfer } : bad("transfer entity missing or malformed");
    },
    /** Every transfer Razorpay holds for this payment (used to avoid creating a second one after a timeout). */
    async listPaymentTransfers(paymentId) {
      const r = await request("GET", `/v1/payments/${encodeURIComponent(paymentId)}/transfers`);
      if (!r.ok) return r;
      const items = Array.isArray(r.data?.items) ? r.data.items : null;
      if (!items) return bad("transfer list missing");
      const transfers = items.map(normalizeTransferEntity).filter(Boolean);
      return { ok: true, transfers, unreadable: items.length - transfers.length };
    },
    async fetchTransfer(transferId) {
      const r = await request("GET", `/v1/transfers/${encodeURIComponent(transferId)}`);
      if (!r.ok) return r;
      const transfer = normalizeTransferEntity(r.data);
      return transfer ? { ok: true, transfer } : bad("transfer entity missing or malformed");
    },
    /** Hold (indefinitely, or until a unix time) or release a transfer. Used by the dispute flow in 5.2c. */
    async setTransferHold(transferId, onHold, untilEpoch) {
      const body = { on_hold: !!onHold };
      if (onHold && Number.isInteger(untilEpoch)) body.on_hold_until = untilEpoch;
      const r = await request("PATCH", `/v1/transfers/${encodeURIComponent(transferId)}`, body);
      if (!r.ok) return r;
      const transfer = normalizeTransferEntity(r.data);
      return transfer ? { ok: true, transfer } : bad("transfer entity missing or malformed");
    },
    /** 5.2c: reverse (part of) a transfer. Success = any 2xx; callers re-fetch the transfer to learn the new state. */
    async reverseTransfer(transferId, amountPaise) {
      const r = await request("POST", `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise });
      return r.ok ? { ok: true } : r;
    },
    /** 5.2c: every refund Razorpay holds for this payment (dashboard refunds included). */
    async listPaymentRefunds(paymentId) {
      const r = await request("GET", `/v1/payments/${encodeURIComponent(paymentId)}/refunds`);
      if (!r.ok) return r;
      const items = Array.isArray(r.data?.items) ? r.data.items : null;
      if (!items) return bad("refund list missing");
      const refunds = items.map(normalizeRefundEntity).filter(Boolean);
      return { ok: true, refunds, unreadable: items.length - refunds.length };
    },
    /** 5.2c: refund the buyer. */
    async createRefund({ paymentId, amountPaise, notes }) {
      const r = await request("POST", `/v1/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, notes: notes ?? {} });
      if (!r.ok) return r;
      const refund = normalizeRefundEntity(r.data);
      return refund ? { ok: true, refund } : bad("refund entity missing or malformed");
    },
  };
}
