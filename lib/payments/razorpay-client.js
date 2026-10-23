// lib/payments/razorpay-client.js -- the ONLY file that talks to Razorpay's API, and only for REFUNDS. Every HTTP call goes through
// an injectable `fetchImpl`, so tests (and a dry run) never touch the network.
//
// Every method returns { ok: true, ... } or { ok: false, retryable, status, code, description }.
//   retryable = network error / timeout / 429 / 5xx. A 4xx is the request's fault and retrying cannot fix it.
// Route transfers (Tier 2) and RazorpayX payouts (Tier 1) were retired: buyers pay the platform account through the normal gateway and
// sellers are paid by hand once a month (see supabase/manual/phase7_monthly_settlement_runbook.md).
import { normalizeRefundEntity } from "./refund-events.js";

const short = (s, n = 200) => (typeof s === "string" ? s.slice(0, n) : "");

export function createRazorpayClient({ keyId, keySecret, fetchImpl = globalThis.fetch, baseUrl = "https://api.razorpay.com", timeoutMs = 8000 }) {
  const auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  async function request(method, path, body, extraHeaders) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json", ...(extraHeaders ?? {}) },
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

  // retryable: a 200 we cannot read may still have created the refund; the retry LISTS before it ever creates.
  const bad = (what) => ({ ok: false, retryable: true, status: 200, code: "bad_response", description: what });

  return {
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
