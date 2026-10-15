// A fake Razorpay Route API for tests: a fetch() replacement with fault injection. No network.
let globalN = 0, rn = 0;   // ids are unique across instances, like real ones
export function createFakeRazorpay() {
  const transfers = new Map();   // id -> entity
  const log = [];                // every request: { method, path, body }
  const refunds = new Map();     // 5.2c: id -> refund entity
  const rfaults = [];            // next reversal POST: same fault names as `faults`
  const refaults = [];           // next refund POST
  const pfaults = [];            // next transfer PATCH
  const faults = [];             // queue consumed by the next POST create: 'timeout_after' | 'timeout_before' | '500' | '429' | '400' | 'amount_mismatch' | 'garbage' | 'network'
  let n = 0;
  const fake = {
    transfers, log, faults, refunds, rfaults, refaults, pfaults,
    get createdRefunds() { return [...refunds.values()]; },
    seedRefund(e) { refunds.set(e.id, e); return e; },
    get created() { return [...transfers.values()]; },
    seed(entity) { transfers.set(entity.id, entity); return entity; },
    nextId() { return `trf_Fake${String(++globalN).padStart(6, "0")}`; },
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const err = (status, code, description) => json(status, { error: { code, description } });
  fake.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push({ method, path: u.pathname, body, auth: init.headers?.Authorization });
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    let m;
    if (method === "POST" && (m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/transfers$/))) {
      const fault = faults.shift();
      if (fault === "network") throw new TypeError("fetch failed");
      if (fault === "timeout_before") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (fault === "500") return err(500, "SERVER_ERROR", "boom");
      if (fault === "429") return err(429, "TOO_MANY_REQUESTS", "slow down");
      if (fault === "400") return err(400, "BAD_REQUEST_ERROR", "The linked account is not activated");
      if (fault === "garbage") return json(200, { hello: "world" });
      const t = body.transfers[0];
      const entity = {
        id: fake.nextId(), entity: "transfer", source: decodeURIComponent(m[1]), recipient: t.account,
        amount: fault === "amount_mismatch" ? t.amount + 1 : t.amount, currency: t.currency, notes: t.notes,
        on_hold: t.on_hold, on_hold_until: t.on_hold_until ?? null, transfer_status: "created",
        settlement_status: t.on_hold ? "on_hold" : "pending", amount_reversed: 0,
      };
      transfers.set(entity.id, entity);
      if (fault === "timeout_after") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return json(200, { entity: "collection", count: 1, items: [entity] });
    }
    if (method === "GET" && (m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/transfers$/))) {
      const pay = decodeURIComponent(m[1]);
      const items = [...transfers.values()].filter((t) => t.source === pay);
      return json(200, { entity: "collection", count: items.length, items });
    }
    const injected = (fault) => {
      if (fault === "network") throw new TypeError("fetch failed");
      if (fault === "timeout_before") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (fault === "500") return err(500, "SERVER_ERROR", "boom");
      if (fault === "429") return err(429, "TOO_MANY_REQUESTS", "slow down");
      if (fault === "400") return err(400, "BAD_REQUEST_ERROR", "refused by razorpay");
      if (fault === "garbage") return json(200, { hello: "world" });
      return null;
    };
    if (method === "POST" && (m = u.pathname.match(/^\/v1\/transfers\/([^/]+)\/reversals$/))) {
      const fault = rfaults.shift(); const early = injected(fault); if (early) return early;
      const t = transfers.get(decodeURIComponent(m[1]));
      if (!t) return err(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
      if (!Number.isInteger(body.amount) || body.amount <= 0 || body.amount > t.amount - t.amount_reversed) return err(400, "BAD_REQUEST_ERROR", "amount exceeds the reversible amount");
      if (fault !== "lazy") {          // 'lazy': accepted (200) but not yet reflected on the transfer
        t.amount_reversed += body.amount;
        t.transfer_status = t.amount_reversed >= t.amount ? "reversed" : "partially_reversed";
      }
      if (fault === "timeout_after") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return json(200, { id: "rvrsl_Fake000001", entity: "reversal", transfer_id: t.id, amount: body.amount });
    }
    if (method === "POST" && (m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/refund$/))) {
      const fault = refaults.shift(); const early = injected(fault); if (early) return early;
      const entity = {
        id: `rfnd_Fake${String(++rn + 100000)}`, entity: "refund", payment_id: decodeURIComponent(m[1]),
        amount: fault === "amount_mismatch" ? body.amount + 1 : body.amount, currency: "INR", status: "pending", notes: body.notes ?? {},
      };
      refunds.set(entity.id, entity);
      if (fault === "timeout_after") throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return json(200, entity);
    }
    if (method === "GET" && (m = u.pathname.match(/^\/v1\/payments\/([^/]+)\/refunds$/))) {
      const pay = decodeURIComponent(m[1]);
      const items = [...refunds.values()].filter((r) => r.payment_id === pay);
      return json(200, { entity: "collection", count: items.length, items });
    }
    if ((m = u.pathname.match(/^\/v1\/transfers\/([^/]+)$/))) {
      const t = transfers.get(decodeURIComponent(m[1]));
      if (!t) return err(400, "BAD_REQUEST_ERROR", "The id provided does not exist");
      if (method === "GET") return json(200, t);
      if (method === "PATCH") { const pf = pfaults.shift(); const early = injected(pf); if (early) return early; t.on_hold = !!body.on_hold; t.on_hold_until = body.on_hold_until ?? null; t.settlement_status = body.on_hold ? "on_hold" : "pending"; return json(200, t); }
    }
    return err(404, "NOT_FOUND", `${method} ${u.pathname}`);
  };
  return fake;
}
