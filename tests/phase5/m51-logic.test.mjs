// A51-L -- unit tests for the framework-free payment code (no database, no network).
// Run:  node tests/phase5/m51-logic.test.mjs
import crypto from "node:crypto";
import { verifyWebhookSignature, computeWebhookSignature, sha256Hex } from "../../lib/payments/webhook-signature.js";
import { handleRazorpayWebhook, extractPayment, MAX_BODY_BYTES, HANDLED_EVENTS } from "../../lib/payments/webhook-handler.js";
import { verifyResponseFor, isSuccess } from "../../lib/payments/fulfilment.js";
import { createPaymentsDb } from "../../lib/payments/db.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const SECRET = "whsec_test_not_real";
const payment = (o = {}) => ({ id: "pay_1", order_id: "order_1", amount: 49900, currency: "INR", status: "captured", method: "upi", email: "buyer@example.com", contact: "+910000000000", ...o });
const event = (type = "payment.captured", p = payment()) => ({ entity: "event", event: type, payload: { payment: { entity: p } } });
const sign = (raw, s = SECRET) => crypto.createHmac("sha256", s).update(raw).digest("hex");
const mkHeaders = (raw, o = {}) => ({ "x-razorpay-signature": sign(raw), "x-razorpay-event-id": "evt_1", ...o });
function fakeDb(o = {}) {
  const calls = [];
  return {
    calls,
    beginEvent: async (a) => { calls.push(["begin", a]); if (o.beginThrows) throw new Error("db down"); return o.begin ?? "new"; },
    fulfil: async (a) => { calls.push(["fulfil", a]); if (o.fulfilThrows) throw Object.assign(new Error("db down"), { code: "XX000" }); return o.fulfil ?? { outcome: "fulfilled", purchase_id: "pur_1" }; },
    finishEvent: async (a) => { calls.push(["finish", a]); if (o.finishThrows) throw new Error("x"); },
    recordPaymentOrder: async () => {},
  };
}
const run = (raw, o = {}) => {
  const db = o.db ?? fakeDb();
  return handleRazorpayWebhook({ rawBody: raw, headers: o.headers ?? mkHeaders(raw), secret: "secret" in o ? o.secret : SECRET, feePct: 0.18, db }).then((r) => ({ ...r, db }));
};
const names = (db) => db.calls.map((c) => c[0]).join(",");

// ---------------------------------------------------------------- signature
{
  const raw = JSON.stringify(event());
  check("L01 a correct signature verifies", verifyWebhookSignature(raw, sign(raw), SECRET) === true);
  check("L02 uppercase hex of the right signature also verifies", verifyWebhookSignature(raw, sign(raw).toUpperCase(), SECRET) === true);
  check("L03 wrong secret fails", verifyWebhookSignature(raw, sign(raw, "other"), SECRET) === false);
  check("L04 one changed byte in the body fails", verifyWebhookSignature(raw.replace("49900", "49901"), sign(raw), SECRET) === false);
  check("L05 re-serialised JSON (whitespace changed) fails -- the signature is over the RAW text", verifyWebhookSignature(JSON.stringify(JSON.parse(raw), null, 2), sign(raw), SECRET) === false);
  for (const [label, sig] of [["missing", undefined], ["null", null], ["empty", ""], ["too short", "abcd"], ["63 chars", sign(raw).slice(1)], ["65 chars", sign(raw) + "0"], ["non-hex 64", "z".repeat(64)], ["number", 12345]]) {
    check(`L06 signature header ${label}: false, never throws`, verifyWebhookSignature(raw, sig, SECRET) === false);
  }
  check("L07 empty / missing secret never verifies (even an HMAC made with the empty key)", verifyWebhookSignature(raw, sign(raw, ""), "") === false && verifyWebhookSignature(raw, sign(raw), undefined) === false);
  check("L08 non-string body never verifies", verifyWebhookSignature(Buffer.from(raw), sign(raw), SECRET) === false && verifyWebhookSignature(null, sign(raw), SECRET) === false);
  check("L09 computeWebhookSignature matches an independent HMAC", computeWebhookSignature(raw, SECRET) === sign(raw));
  check("L10 sha256Hex is the standard hash", sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const mb = "café ₹";
  check("L11 multi-byte bodies are signed as UTF-8 bytes", verifyWebhookSignature(mb, crypto.createHmac("sha256", SECRET).update(Buffer.from(mb, "utf8")).digest("hex"), SECRET) === true);
}

// ---------------------------------------------------------------- extractPayment
{
  const e = extractPayment(event());
  check("L20 extractPayment: ids, amount in paise, currency, method", e && e.paymentId === "pay_1" && e.orderId === "order_1" && e.amountPaise === 49900 && e.currency === "INR" && e.method === "upi", e);
  check("L21 extractPayment returns ONLY what we need (no email / contact leaks into the db call)", !("email" in e) && !("contact" in e) && Object.keys(e).sort().join() === "amountPaise,currency,method,orderId,paymentId", Object.keys(e));
  const bad = {
    "no payload": {}, "no payment": { payload: {} }, "entity not an object": { payload: { payment: { entity: "x" } } },
    "no id": event("payment.captured", payment({ id: undefined })), "empty id": event("payment.captured", payment({ id: "" })),
    "no order id": event("payment.captured", payment({ order_id: null })), "id too long": event("payment.captured", payment({ id: "p".repeat(101) })),
    "amount string": event("payment.captured", payment({ amount: "49900" })), "amount float": event("payment.captured", payment({ amount: 499.5 })),
    "amount zero": event("payment.captured", payment({ amount: 0 })), "amount negative": event("payment.captured", payment({ amount: -1 })),
    "USD": event("payment.captured", payment({ currency: "USD" })), "not captured (authorized)": event("payment.captured", payment({ status: "authorized" })),
    "failed": event("payment.captured", payment({ status: "failed" })),
  };
  for (const [label, body] of Object.entries(bad)) check(`L22 extractPayment rejects: ${label}`, extractPayment(body) === null);
  check("L23 extractPayment tolerates a null body", extractPayment(null) === null && extractPayment(undefined) === null);
  check("L24 handled events are exactly payment.captured and order.paid", JSON.stringify(HANDLED_EVENTS) === JSON.stringify(["payment.captured", "order.paid"]));
}

// ---------------------------------------------------------------- handler: rejections happen BEFORE any db call
{
  const raw = JSON.stringify(event());
  const cases = [
    ["no secret configured", { secret: "" }, 500], ["bad signature", { headers: { ...mkHeaders(raw), "x-razorpay-signature": "0".repeat(64) } }, 400],
    ["no signature header", { headers: { "x-razorpay-event-id": "e" } }, 400], ["no event id", { headers: { "x-razorpay-signature": sign(raw) } }, 400],
    ["empty event id", { headers: { ...mkHeaders(raw), "x-razorpay-event-id": "" } }, 400],
    ["event id over 200 chars", { headers: { ...mkHeaders(raw), "x-razorpay-event-id": "e".repeat(201) } }, 400],
  ];
  for (const [label, o, status] of cases) {
    const r = await run(raw, o);
    check(`L30 ${label}: HTTP ${status}, NO database call`, r.status === status && r.db.calls.length === 0, r);
  }
  const r1 = await run("");
  check("L31 empty body: 400, no db call", r1.status === 400 && r1.db.calls.length === 0);
  const big = JSON.stringify({ event: "x", pad: "a".repeat(MAX_BODY_BYTES) });
  const r2 = await run(big, { headers: mkHeaders(big) });
  check("L32 body over the size cap: 413 even with a valid signature, no db call", r2.status === 413 && r2.db.calls.length === 0, r2.status);
  const notJson = "this is not json";
  const r3 = await run(notJson, { headers: mkHeaders(notJson) });
  check("L33 validly SIGNED but not JSON: 400, no db call", r3.status === 400 && r3.db.calls.length === 0, r3);
  const noEvent = JSON.stringify({ payload: {} });
  const r4 = await run(noEvent, { headers: mkHeaders(noEvent) });
  check("L34 signed JSON without an event type: 400, no db call", r4.status === 400 && r4.db.calls.length === 0, r4);
  const r5 = await run(raw, { headers: new Map([["x-razorpay-signature", sign(raw)], ["x-razorpay-event-id", "evt_9"]]) });
  check("L35 headers may be a Headers-like object with .get()", r5.status === 200 && r5.db.calls[0][1].eventId === "evt_9", r5);
}

// ---------------------------------------------------------------- handler: happy path and routing
{
  const raw = JSON.stringify(event());
  const r = await run(raw);
  check("L40 payment.captured: begin -> fulfil, 200 with the outcome", r.status === 200 && r.json.outcome === "fulfilled" && names(r.db) === "begin,fulfil", r);
  const f = r.db.calls[1][1];
  check("L41 fulfil gets: ids, paise amount, currency, method, fee 0.18, NO expected user (webhook), the event id, no signature",
    f.paymentId === "pay_1" && f.orderId === "order_1" && f.amountPaise === 49900 && f.currency === "INR" && f.method === "upi" && f.feePct === 0.18
    && f.expectedUserId === null && f.eventId === "evt_1" && f.signature === null, f);
  const b = r.db.calls[0][1];
  check("L42 begin gets the event type, ids and the SHA-256 of the exact raw body", b.eventType === "payment.captured" && b.orderId === "order_1" && b.paymentId === "pay_1" && b.sha256 === sha256Hex(raw), b);
  check("L43 NOTHING from the payload other than ids/hash reaches the db layer (no email, no contact)", !JSON.stringify(r.db.calls).includes("buyer@example.com") && !JSON.stringify(r.db.calls).includes("+91"));
  const op = JSON.stringify(event("order.paid"));
  const r2 = await run(op);
  check("L44 order.paid is handled the same way", r2.status === 200 && names(r2.db) === "begin,fulfil" && r2.db.calls[1][1].paymentId === "pay_1", r2);
}
{
  const raw = JSON.stringify(event("payment.failed", payment({ status: "failed" })));
  const r = await run(raw);
  check("L45 payment.failed: recorded as ignored, never fulfilled, 200", r.status === 200 && names(r.db) === "begin,finish" && r.db.calls[1][1].status === "ignored" && r.db.calls[1][1].outcome === "unhandled_event", r);
  const adversarial = JSON.stringify(event("payment.authorized", payment({ status: "captured" })));
  const ra = await run(adversarial);
  check("L45b even a payment.authorized event that CLAIMS a captured payment is never fulfilled (only the two handled event types can)", ra.status === 200 && !names(ra.db).includes("fulfil") && ra.db.calls.at(-1)[1].status === "ignored", ra);
  const r2 = await run(JSON.stringify(event("refund.processed")));
  check("L46 an unrelated event type is ignored the same way", r2.status === 200 && !names(r2.db).includes("fulfil"));
}
{
  const raw = JSON.stringify(event("payment.captured", payment({ status: "authorized" })));
  const r = await run(raw);
  check("L47 a payment.captured event whose payment is NOT captured is never fulfilled -- flagged needs_review/malformed_payload, 200",
    r.status === 200 && !names(r.db).includes("fulfil") && r.db.calls.at(-1)[1].status === "needs_review" && r.db.calls.at(-1)[1].outcome === "malformed_payload", r);
  const raw2 = JSON.stringify(event("payment.captured", payment({ amount: "49900" })));
  const r2 = await run(raw2);
  check("L48 a captured event with an unreadable amount is flagged, not fulfilled", r2.status === 200 && !names(r2.db).includes("fulfil") && r2.db.calls.at(-1)[1].status === "needs_review");
}

// ---------------------------------------------------------------- handler: duplicates and failures
{
  const raw = JSON.stringify(event());
  const r = await run(raw, { db: fakeDb({ begin: "duplicate" }) });
  check("L50 a duplicate event: 200 and NO fulfil call", r.status === 200 && r.json.duplicate === true && names(r.db) === "begin", r);
  const r2 = await run(raw, { db: fakeDb({ begin: "retry" }) });
  check("L51 a 'retry' event is processed normally", r2.status === 200 && names(r2.db) === "begin,fulfil", r2);
}
{
  const raw = JSON.stringify(event());
  const r = await run(raw, { db: fakeDb({ beginThrows: true }) });
  check("L52 database down at begin: 500 (so Razorpay retries), no fulfil", r.status === 500 && names(r.db) === "begin", r);
  const r2 = await run(raw, { db: fakeDb({ fulfilThrows: true }) });
  check("L53 fulfil throws: the event is marked 'failed' (so the retry is let through) and the answer is 500",
    r2.status === 500 && names(r2.db) === "begin,fulfil,finish" && r2.db.calls[2][1].status === "failed", r2);
  check("L54 the failure record carries only a short code, never the payload", r2.db.calls[2][1].error === "XX000" && !JSON.stringify(r2.db.calls[2][1]).includes("buyer@example.com"));
  const r3 = await run(raw, { db: fakeDb({ fulfilThrows: true, finishThrows: true }) });
  check("L55 if even the 'failed' bookkeeping throws, still a clean 500 (no unhandled rejection)", r3.status === 500);
  for (const outcome of ["order_unknown", "amount_mismatch", "listing_unavailable", "duplicate_payment", "order_user_mismatch"]) {
    const r4 = await run(raw, { db: fakeDb({ fulfil: { outcome, purchase_id: null } }) });
    check(`L56 outcome '${outcome}' is answered 200 (a retry cannot fix it; the db already marked it needs_review)`, r4.status === 200 && r4.json.outcome === outcome, r4);
  }
}

// ---------------------------------------------------------------- the 200s never reveal internals
{
  const raw = JSON.stringify(event());
  for (const r of [await run(raw), await run(raw, { secret: "" }), await run(raw, { db: fakeDb({ fulfilThrows: true }) })]) {
    check("L60 responses never contain the secret, the payload or an error message", !JSON.stringify(r.json).includes(SECRET) && !JSON.stringify(r.json).includes("buyer@example.com") && !JSON.stringify(r.json).includes("db down"), r.json);
  }
}

// ---------------------------------------------------------------- verifyResponseFor (browser path)
{
  const ok = verifyResponseFor({ outcome: "fulfilled", purchase_id: "p1" });
  check("L70 fulfilled -> 200 {success, purchaseId}", ok.status === 200 && ok.json.success === true && ok.json.purchaseId === "p1");
  const again = verifyResponseFor({ outcome: "already_fulfilled", purchase_id: "p1" });
  check("L71 already_fulfilled (webhook got there first) is ALSO a plain success", again.status === 200 && again.json.success === true && again.json.purchaseId === "p1");
  const dup = verifyResponseFor({ outcome: "duplicate_payment", purchase_id: "p0" });
  check("L72 duplicate_payment: success with the existing purchase id and a refund note", dup.status === 200 && dup.json.success === true && dup.json.purchaseId === "p0" && /refund/i.test(dup.json.note));
  const table = { order_user_mismatch: 403, order_unknown: 404, amount_mismatch: 409, listing_unavailable: 409 };
  for (const [o, s] of Object.entries(table)) {
    const r = verifyResponseFor({ outcome: o, purchase_id: null });
    check(`L73 ${o} -> ${s}, with a message and NO success flag`, r.status === s && typeof r.json.error === "string" && !r.json.success, r);
  }
  const unk = verifyResponseFor({ outcome: "something_new" }), nul = verifyResponseFor(null);
  check("L74 an unknown outcome or a null result is a 500, never a success", unk.status === 500 && !unk.json.success && nul.status === 500 && !nul.json.success);
  check("L75 isSuccess is exactly fulfilled / already_fulfilled", isSuccess("fulfilled") && isSuccess("already_fulfilled") && !isSuccess("duplicate_payment") && !isSuccess(undefined));
}

// ---------------------------------------------------------------- db wrapper
{
  const calls = [];
  const client = { rpc: async (fn, args) => { calls.push({ fn, args }); return { data: "x", error: null }; } };
  const db = createPaymentsDb(client);
  await db.recordPaymentOrder({ orderId: "o", userId: "u", listingId: "l", amountPaise: 100 });
  await db.beginEvent({ eventId: "e", eventType: "t", orderId: "o", paymentId: "p", sha256: "h" });
  await db.finishEvent({ eventId: "e", status: "processed", outcome: "x" });
  await db.fulfil({ orderId: "o", paymentId: "p", amountPaise: 100, currency: "INR", method: "upi", signature: "s", feePct: 0.18, expectedUserId: "u", eventId: "e" });
  check("L80 the four RPC names are exactly the migration's", calls.map((c) => c.fn).join() === "record_payment_order,begin_webhook_event,finish_webhook_event,fulfil_captured_payment", calls.map((c) => c.fn));
  check("L81 fulfil sends all nine named parameters the SQL function takes",
    Object.keys(calls[3].args).sort().join() === "p_amount_paise,p_currency,p_event_id,p_expected_user_id,p_fee_pct,p_method,p_order_id,p_payment_id,p_signature", Object.keys(calls[3].args));
  const c2 = createPaymentsDb({ rpc: async () => ({ data: null, error: { code: "CM070", message: "invalid" } }) });
  let threw = null; try { await c2.fulfil({ orderId: "o", paymentId: "p", feePct: 0.18 }); } catch (e) { threw = e; }
  check("L82 an rpc error is THROWN (with its code) so callers can answer 500 -- never silently swallowed", threw?.code === "CM070");
  const c3 = createPaymentsDb({ rpc: async (fn, a) => { calls.push(a); return { data: { outcome: "fulfilled" }, error: null }; } });
  await c3.fulfil({ orderId: "o", paymentId: "p", feePct: 0.18 });
  const last = calls.at(-1);
  check("L83 omitted optional args default to NULL / 'INR' (never undefined, which JSON would drop)", last.p_amount_paise === null && last.p_expected_user_id === null && last.p_event_id === null && last.p_currency === "INR" && last.p_signature === null && last.p_method === null, last);
}

console.log(`\nA51-L: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
