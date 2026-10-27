// lib/payments/razorpay-client.js -- the ONLY file that talks to Razorpay's API, and only for REFUNDS. Every HTTP call goes through
// an injectable `fetchImpl`, so tests (and a dry run) never touch the network.
//
// Every method returns { ok: true, ... } or { ok: false, retryable, status, code, description }.
//   retryable = network error / timeout / 429 / 5xx. A 4xx is the request's fault and retrying cannot fix it.
// Razorpay Route (linked accounts via /v2/accounts, order-level split transfers via /v1/orders) is added back for TEST MODE behind the
// the Route flag flag. Post-payment transfer creation (the old sweep) and RazorpayX payouts stay retired.
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

  const field = (r, key) => (r.ok && r.data && typeof r.data[key] === "string" ? r.data[key] : null);

  return {
    // ---- Route: linked accounts (Composite flow: account -> route product -> settlement details)
    async createLinkedAccount(payload) {
      const r = await request("POST", "/v2/accounts", payload);
      if (!r.ok) return r;
      const id = field(r, "id");
      return id ? { ok: true, accountId: id, status: field(r, "status") } : bad("account id missing");
    },
    async requestRouteProduct(accountId, payload) {
      const r = await request("POST", `/v2/accounts/${encodeURIComponent(accountId)}/products`, payload);
      if (!r.ok) return r;
      const id = field(r, "id");
      return id ? { ok: true, productId: id, status: field(r, "activation_status") } : bad("product id missing");
    },
    async updateRouteProduct(accountId, productId, payload) {
      const r = await request("PATCH", `/v2/accounts/${encodeURIComponent(accountId)}/products/${encodeURIComponent(productId)}`, payload);
      if (!r.ok) return r;
      return { ok: true, status: field(r, "activation_status"), requirements: Array.isArray(r.data?.requirements) ? r.data.requirements.slice(0, 5) : [] };
    },
    async fetchLinkedAccount(accountId) {
      const r = await request("GET", `/v2/accounts/${encodeURIComponent(accountId)}`);
      if (!r.ok) return r;
      return { ok: true, status: field(r, "status") };
    },
    /** Payment lookup, used by the transfer.processed path (a transfer event carries the payment id but not the order id). */
    async fetchPayment(paymentId) {
      const r = await request("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
      if (!r.ok) return r;
      const d = r.data ?? {};
      if (typeof d.id !== "string" || typeof d.order_id !== "string" || !Number.isInteger(d.amount)) return bad("payment entity malformed");
      return { ok: true, payment: { id: d.id, orderId: d.order_id, amountPaise: d.amount, currency: d.currency, status: d.status, method: typeof d.method === "string" ? d.method : null } };
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
