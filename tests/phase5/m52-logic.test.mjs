// A52-L -- unit tests for the Route-transfer code that needs no database (fake Razorpay + fake db).
// Run:  node tests/phase5/m52-logic.test.mjs
import crypto from "node:crypto";
import { normalizeTransferEntity, extractTransferEvent, TRANSFER_EVENT_RE } from "../../lib/payments/transfer-events.js";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { createTransferForPurchase, pollTransfer, runTransferSweep } from "../../lib/payments/transfers.js";
import { handleSweepRequest, bearerMatches } from "../../lib/payments/sweep-handler.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
import { createFakeRazorpay } from "./fake-razorpay.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const PID = "11111111-2222-4333-8444-555555555555";
const ent = (o = {}) => ({ id: "trf_ABCDEF123456", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 40918, currency: "INR", status: "processed", settlement_status: "pending", on_hold: false, amount_reversed: 0, notes: { purchase_id: PID }, ...o });

// ---------------------------------------------------------------- normalizeTransferEntity
{
  const t = normalizeTransferEntity(ent());
  check("L01 a valid entity normalises (ids, paise, status, settlement, hold, reversed, purchase id from notes)",
    t && t.id === "trf_ABCDEF123456" && t.source === "pay_1" && t.recipient === "acc_TestSeller001" && t.amountPaise === 40918 && t.status === "processed"
    && t.settlementStatus === "pending" && t.onHold === false && t.amountReversedPaise === 0 && t.purchaseId === PID, t);
  check("L02 'transfer_status' is preferred over 'status' when both exist", normalizeTransferEntity(ent({ transfer_status: "failed", status: "created" })).status === "failed");
  check("L03 the purchase id is lower-cased and must be a real uuid", normalizeTransferEntity(ent({ notes: { purchase_id: PID.toUpperCase() } })).purchaseId === PID
    && normalizeTransferEntity(ent({ notes: { purchase_id: "not-a-uuid" } })).purchaseId === null && normalizeTransferEntity(ent({ notes: null })).purchaseId === null);
  const bad = {
    "null": null, "string": "x", "no id": { ...ent(), id: undefined }, "id wrong prefix": ent({ id: "pay_ABCDEF123456" }), "id too short": ent({ id: "trf_ab" }),
    "amount 0": ent({ amount: 0 }), "amount float": ent({ amount: 1.5 }), "amount string": ent({ amount: "409" }), "USD": ent({ currency: "USD" }),
    "unknown status": ent({ status: "weird" }), "unknown settlement": ent({ settlement_status: "later" }), "reversed > amount": ent({ amount_reversed: 99999 }),
    "reversed negative": ent({ amount_reversed: -1 }), "on_hold a string": ent({ on_hold: "false" }),
  };
  for (const [label, e] of Object.entries(bad)) check(`L04 rejects: ${label}`, normalizeTransferEntity(e) === null);
  const lean = normalizeTransferEntity({ id: "trf_ABCDEF123456", amount: 100, status: "created" });
  check("L05 optional fields may be absent: no recipient/source/settlement/hold/notes", lean && lean.recipient === null && lean.source === null && lean.settlementStatus === null && lean.onHold === null && lean.purchaseId === null);
  check("L06 a recipient that is not an acc_ id is dropped (never trusted)", normalizeTransferEntity(ent({ recipient: "bob" })).recipient === null);
}
{
  const body = { event: "transfer.processed", created_at: 1800000123, payload: { transfer: { entity: ent() } } };
  const e = extractTransferEvent(body);
  check("L10 extractTransferEvent adds the event's own timestamp", e && e.eventAt === 1800000123 && e.id === "trf_ABCDEF123456", e);
  check("L11 a missing / non-integer / zero event timestamp becomes null", extractTransferEvent({ ...body, created_at: undefined }).eventAt === null && extractTransferEvent({ ...body, created_at: "123" }).eventAt === null && extractTransferEvent({ ...body, created_at: 0 }).eventAt === null);
  check("L12 no payload / no entity / bad entity -> null", extractTransferEvent({}) === null && extractTransferEvent({ payload: {} }) === null && extractTransferEvent({ payload: { transfer: { entity: { id: "x" } } } }) === null);
  for (const ok of ["transfer.processed", "transfer.failed", "transfer.settled", "transfer.reversed"]) check(`L13 event name ${ok} is a transfer event`, TRANSFER_EVENT_RE.test(ok));
  for (const no of ["payment.captured", "transfer", "transfer.", "xtransfer.processed", "transfer.PROCESSED", "transfer.a.b", "refund.processed"]) check(`L14 event name '${no}' is NOT a transfer event`, !TRANSFER_EVENT_RE.test(no));
}

// ---------------------------------------------------------------- razorpay client
function client(fake, o = {}) { return createRazorpayClient({ keyId: "rzp_test_x", keySecret: "sekret", fetchImpl: fake.fetch, timeoutMs: o.timeoutMs ?? 50 }); }
{
  const fake = createFakeRazorpay(), rz = client(fake);
  const r = await rz.createTransfer({ paymentId: "pay_1", account: "acc_TestSeller001", amountPaise: 40918, onHold: true, holdUntilEpoch: 1800000000, notes: { purchase_id: PID } });
  const req = fake.log[0];
  check("L20 createTransfer: POST /v1/payments/{id}/transfers with account, paise amount, INR, notes, on_hold and on_hold_until",
    req.method === "POST" && req.path === "/v1/payments/pay_1/transfers" && JSON.stringify(req.body) === JSON.stringify({ transfers: [{ account: "acc_TestSeller001", amount: 40918, currency: "INR", notes: { purchase_id: PID }, on_hold: true, on_hold_until: 1800000000 }] }), req);
  check("L21 ...with HTTP Basic auth built from the key id and secret", req.auth === "Basic " + Buffer.from("rzp_test_x:sekret").toString("base64"));
  check("L22 the result is a normalised transfer", r.ok && r.transfer.amountPaise === 40918 && r.transfer.recipient === "acc_TestSeller001" && r.transfer.onHold === true && r.transfer.status === "created", r);
  const r2 = await rz.createTransfer({ paymentId: "pay_2", account: "acc_TestSeller001", amountPaise: 100, onHold: true, holdUntilEpoch: null, notes: {} });
  check("L23 a hold with no end time is indefinite: on_hold true and NO on_hold_until", fake.log[1].body.transfers[0].on_hold === true && !("on_hold_until" in fake.log[1].body.transfers[0]) && r2.ok);
  await rz.createTransfer({ paymentId: "pay_3", account: "acc_TestSeller001", amountPaise: 100, onHold: false, holdUntilEpoch: 1800000000, notes: {} });
  check("L24 no hold: on_hold false and on_hold_until is NOT sent even if given", fake.log[2].body.transfers[0].on_hold === false && !("on_hold_until" in fake.log[2].body.transfers[0]));
  await rz.createTransfer({ paymentId: "pay/../x?y", account: "acc_TestSeller001", amountPaise: 100, onHold: false, notes: {} });
  check("L25 the payment id is URL-encoded into the path (no path injection)", fake.log[3].path === "/v1/payments/pay%2F..%2Fx%3Fy/transfers", fake.log[3].path);
}
{
  const cases = [["500", true, 500], ["429", true, 429], ["400", false, 400]];
  for (const [fault, retryable, status] of cases) {
    const fake = createFakeRazorpay(); fake.faults.push(fault);
    const r = await client(fake).createTransfer({ paymentId: "pay_1", account: "acc_TestSeller001", amountPaise: 1, onHold: false, notes: {} });
    check(`L30 HTTP ${status}: ok=false, retryable=${retryable}, status and code carried`, r.ok === false && r.retryable === retryable && r.status === status && typeof r.code === "string", r);
  }
  const f1 = createFakeRazorpay(); f1.faults.push("network");
  const n = await client(f1).createTransfer({ paymentId: "p", account: "acc_TestSeller001", amountPaise: 1, onHold: false, notes: {} });
  check("L31 a network error is retryable (code network_error)", n.ok === false && n.retryable === true && n.code === "network_error", n);
  const slow = { fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))) };
  const t = await client(slow, { timeoutMs: 20 }).fetchTransfer("trf_ABCDEF123456");
  check("L32 a request that never answers is aborted by the client timeout and reported as a retryable 'timeout'", t.ok === false && t.retryable === true && t.code === "timeout", t);
  const f2 = createFakeRazorpay(); f2.faults.push("garbage");
  const g = await client(f2).createTransfer({ paymentId: "p", account: "acc_TestSeller001", amountPaise: 1, onHold: false, notes: {} });
  check("L33 a 200 with a body that is not a transfer is a retryable 'bad_response' (never treated as success; the retry looks before it creates)", g.ok === false && g.retryable === true && g.code === "bad_response", g);
  const f3 = createFakeRazorpay(); f3.faults.push("400");
  const e400 = await client(f3).createTransfer({ paymentId: "p", account: "acc_TestSeller001", amountPaise: 1, onHold: false, notes: {} });
  check("L34 Razorpay's error description is passed on, truncated, and the secret never appears in any result", e400.description.length <= 200 && !JSON.stringify(e400).includes("sekret"));
  const stub = { fetch: async () => new Response("<html>bad gateway</html>", { status: 502 }) };
  const html = await client(stub).fetchTransfer("trf_ABCDEF123456");
  check("L35 a non-JSON error body is handled (502 -> retryable, generic code)", html.ok === false && html.retryable === true && html.code === "http_502", html);
}
{
  const fake = createFakeRazorpay(), rz = client(fake);
  const a = (await rz.createTransfer({ paymentId: "pay_9", account: "acc_TestSeller001", amountPaise: 500, onHold: true, holdUntilEpoch: 1800000000, notes: { purchase_id: PID } })).transfer;
  const list = await rz.listPaymentTransfers("pay_9");
  check("L40 listPaymentTransfers returns normalised transfers", list.ok && list.transfers.length === 1 && list.transfers[0].id === a.id && list.unreadable === 0, list);
  fake.seed({ id: "trf_Weird000001", source: "pay_9", amount: -5 });
  const l2 = await rz.listPaymentTransfers("pay_9");
  check("L41 unreadable items are COUNTED, not silently dropped", l2.ok && l2.transfers.length === 1 && l2.unreadable === 1, l2);
  const f = await rz.fetchTransfer(a.id);
  check("L42 fetchTransfer", f.ok && f.transfer.id === a.id);
  const missing = await rz.fetchTransfer("trf_Missing00001");
  check("L43 an unknown transfer id is a NON-retryable error", missing.ok === false && missing.retryable === false);
  const h = await rz.setTransferHold(a.id, false);
  check("L44 setTransferHold(false) sends PATCH {on_hold:false} and returns the updated transfer", fake.log.at(-1).method === "PATCH" && JSON.stringify(fake.log.at(-1).body) === '{"on_hold":false}' && h.ok && h.transfer.onHold === false, h);
  await rz.setTransferHold(a.id, true);
  check("L45 setTransferHold(true) with no end time holds indefinitely (no on_hold_until)", JSON.stringify(fake.log.at(-1).body) === '{"on_hold":true}');
  await rz.setTransferHold(a.id, true, 1800000999);
  check("L46 ...or until a given unix time", fake.log.at(-1).body.on_hold_until === 1800000999);
}

// ---------------------------------------------------------------- orchestration with a scripted fake db
function fakeDb(plan, o = {}) {
  const calls = [];
  return {
    calls,
    planTransfer: async (a) => { calls.push(["plan", a]); return typeof plan === "function" ? plan() : plan; },
    applyTransferEvent: async (a) => { calls.push(["apply", a]); if (o.applyThrows) throw new Error("db"); return { outcome: "applied" }; },
    recordTransferFailure: async (a) => { calls.push(["fail", a]); if (o.failThrows) throw new Error("db"); return { outcome: a.retryable ? "retry_scheduled" : "failed" }; },
    listTransferWork: async (a) => { calls.push(["work", a]); return o.work ?? []; },
  };
}
const CLAIM = { outcome: "claimed", purchase_id: PID, payment_id: "pay_1", account_id: "acc_TestSeller001", amount_paise: 40918, on_hold: true, hold_until_epoch: 1800000000, lookup_first: false, attempts: 1 };
const names = (db) => db.calls.map((c) => c[0]).join(",");
{
  const fake = createFakeRazorpay(), db = fakeDb(CLAIM);
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID, now: () => 1799999000 });
  check("L50 happy path: plan -> create at Razorpay -> apply; returns 'created'", r.outcome === "created" && names(db) === "plan,apply" && fake.created.length === 1, [r, names(db)]);
  const a = db.calls[1][1];
  check("L51 apply gets the Razorpay id, status, hold state, amount and recipient (so the DB can cross-check), the purchase id and the pre-call timestamp",
    a.transferId === fake.created[0].id && a.purchaseId === PID && a.status === "created" && a.onHold === true && a.amountPaise === 40918 && a.recipient === "acc_TestSeller001" && a.eventAt === 1799999000 && a.eventId === null, a);
  check("L52 Razorpay is told which purchase this is (notes.purchase_id) -- that is what lets a webhook find the ledger row", fake.log[0].body.transfers[0].notes.purchase_id === PID);
}
for (const outcome of ["disabled", "no_account", "exists", "backoff", "in_progress", "not_eligible", "not_found"]) {
  const fake = createFakeRazorpay(), db = fakeDb({ outcome });
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check(`L53 plan outcome '${outcome}': Razorpay is NOT called`, r.outcome === outcome && fake.log.length === 0 && names(db) === "plan", [r, fake.log.length]);
}
{
  const fake = createFakeRazorpay(), db = fakeDb({ ...CLAIM, lookup_first: true });
  const existing = fake.seed({ id: "trf_Existing0001", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 40918, currency: "INR", notes: { purchase_id: PID }, on_hold: true, transfer_status: "created", settlement_status: "on_hold", amount_reversed: 0 });
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L60 lookup_first with ONE existing matching transfer: it is ADOPTED and no second transfer is created", r.outcome === "adopted" && r.transferId === existing.id
    && fake.log.every((l) => l.method === "GET") && fake.created.length === 1 && names(db) === "plan,apply", [r, fake.log.map((l) => l.method)]);
}
{
  const fake = createFakeRazorpay(), db = fakeDb({ ...CLAIM, lookup_first: true });
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L61 lookup_first with NOTHING at Razorpay: it creates exactly one", r.outcome === "created" && fake.created.length === 1 && fake.log.map((l) => l.method).join() === "GET,POST", fake.log.map((l) => l.method));
}
{
  const fake = createFakeRazorpay(), db = fakeDb({ ...CLAIM, lookup_first: true });
  for (const i of [1, 2]) fake.seed({ id: `trf_Dup00000000${i}`, entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 40918, currency: "INR", notes: { purchase_id: PID }, transfer_status: "created" });
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L62 TWO transfers already at Razorpay for one payment: nothing is created, nothing adopted, it fails NON-retryably (a human decides)",
    r.outcome === "failed" && db.calls.at(-1)[1].retryable === false && /duplicate_transfers/.test(db.calls.at(-1)[1].error) && fake.log.every((l) => l.method === "GET"), [r, db.calls.at(-1)]);
}
{
  const fake = createFakeRazorpay(), db = fakeDb({ ...CLAIM, lookup_first: true });
  fake.seed({ id: "trf_Wrongamt0001", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 99, currency: "INR", notes: { purchase_id: PID }, transfer_status: "created" });
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L63 an existing transfer with a DIFFERENT amount is never adopted: fails non-retryably", r.outcome === "failed" && fake.log.every((l) => l.method === "GET") && !names(db).includes("apply"), r);
  const f2 = createFakeRazorpay(), db2 = fakeDb({ ...CLAIM, lookup_first: true });
  f2.seed({ id: "trf_Otheracct001", entity: "transfer", source: "pay_1", recipient: "acc_SomeoneElse01", amount: 40918, currency: "INR", notes: {}, transfer_status: "created" });
  const r2 = await createTransferForPurchase({ db: db2, rzp: client(f2), purchaseId: PID });
  check("L64 a transfer at Razorpay to a DIFFERENT account is not ours: ignored, and we create ours", r2.outcome === "created" && f2.created.length === 2, r2);
}
{
  for (const [fault, want] of [["500", "retry_scheduled"], ["429", "retry_scheduled"], ["network", "retry_scheduled"], ["timeout_before", "retry_scheduled"], ["timeout_after", "retry_scheduled"], ["400", "failed"], ["garbage", "retry_scheduled"]]) {
    const fake = createFakeRazorpay(); fake.faults.push(fault);
    const db = fakeDb(CLAIM);
    const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
    check(`L65 create fault '${fault}' -> ${want}, and the failure is recorded (retryable=${want === "retry_scheduled"})`, r.outcome === want && db.calls.at(-1)[0] === "fail" && db.calls.at(-1)[1].retryable === (want === "retry_scheduled") && !names(db).includes("apply"), [r, names(db)]);
  }
  const fake = createFakeRazorpay(); fake.faults.push("amount_mismatch");
  const db = fakeDb(CLAIM);
  const r = await createTransferForPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L66 Razorpay creating a transfer with a DIFFERENT amount than asked: NOT recorded as ours, non-retryable failure that names the stray transfer id",
    r.outcome === "failed" && !names(db).includes("apply") && /response_mismatch/.test(db.calls.at(-1)[1].error) && /trf_Fake/.test(db.calls.at(-1)[1].error), [r, db.calls.at(-1)]);
  const e = fakeDb(CLAIM, { applyThrows: true });
  const fk = createFakeRazorpay();
  const r2 = await createTransferForPurchase({ db: e, rzp: client(fk), purchaseId: PID });
  check("L67 the database failing AFTER the transfer was created is recorded as a retryable failure (the retry will find and adopt it)", r2.outcome === "retry_scheduled" && fk.created.length === 1, r2);
  const both = fakeDb(CLAIM, { applyThrows: true, failThrows: true });
  const r3 = await createTransferForPurchase({ db: both, rzp: client(createFakeRazorpay()), purchaseId: PID });
  check("L68 even if the failure bookkeeping throws too, it returns a clean 'error' (never throws into the caller)", r3.outcome === "error");
}
{
  const fake = createFakeRazorpay(), db = fakeDb(CLAIM);
  const created = (await client(fake).createTransfer({ paymentId: "pay_1", account: "acc_TestSeller001", amountPaise: 40918, onHold: true, holdUntilEpoch: 1800000000, notes: {} })).transfer;
  const r = await pollTransfer({ db, rzp: client(fake), purchaseId: PID, transferId: created.id, now: () => 1234 });
  check("L70 pollTransfer applies what Razorpay says now, stamped with the time taken BEFORE the request", r.outcome === "polled" && db.calls[0][1].eventAt === 1234 && db.calls[0][1].transferId === created.id, [r, db.calls]);
  const r2 = await pollTransfer({ db, rzp: client(fake), purchaseId: PID, transferId: "trf_Missing00001" });
  check("L71 an unknown transfer is 'poll_failed' (non-retryable), nothing applied", r2.outcome === "poll_failed" && db.calls.length === 1);
  fake.faults.push("x"); const f = createFakeRazorpay();
  const r3 = await pollTransfer({ db, rzp: { fetchTransfer: async () => ({ ok: false, retryable: true, code: "timeout" }) }, purchaseId: PID, transferId: "trf_ABCDEF123456" });
  check("L72 a transient poll error is 'poll_retry_later'", r3.outcome === "poll_retry_later");
}

// ---------------------------------------------------------------- sweep
{
  const work = [
    { kind: "create", purchase_id: "p1" }, { kind: "poll", purchase_id: "p2", razorpay_transfer_id: "trf_ABCDEF123456" },
    { kind: "create", purchase_id: "p3" }, { kind: "weird", purchase_id: "p4" }, { kind: "create", purchase_id: "p5" },
  ];
  let i = 0;
  const db = fakeDb(() => (++i === 3 ? (() => { throw new Error("boom"); })() : { outcome: "no_account" }), { work });
  const fake = createFakeRazorpay();
  fake.seed({ id: "trf_ABCDEF123456", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: 100, currency: "INR", transfer_status: "processed", settlement_status: "pending", on_hold: false, amount_reversed: 0, notes: {} });
  const c = await runTransferSweep({ db, rzp: client(fake), limit: 20 });
  check("L80 one bad item never stops the rest: counts show the skip, the poll, the unknown kind and the thrown error", c.items === 5 && c.polled === 1 && c.errors === 1 && c.skipped === 3 && c.created === 0, c);
  check("L81 the limit is passed to the database", db.calls.find((x) => x[0] === "work")[1].limit === 20);
  let t = 0;
  const slowWork = Array.from({ length: 10 }, (_, k) => ({ kind: "create", purchase_id: `p${k}` }));
  const c2 = await runTransferSweep({ db: fakeDb({ outcome: "disabled" }, { work: slowWork }), rzp: client(createFakeRazorpay()), budgetMs: 100, nowMs: () => (t += 60) });
  check("L82 a time budget stops the sweep early and says so (timeBudgetHit)", c2.timeBudgetHit === true && c2.items < 10, c2);
  const c3 = await runTransferSweep({ db: fakeDb({ outcome: "x" }, { work: null }), rzp: client(createFakeRazorpay()) });
  check("L83 a malformed work list is treated as empty", c3.items === 0 && c3.errors === 0);
}

// ---------------------------------------------------------------- sweep auth
{
  const S = "cron-secret-0123456789";
  let ran = 0;
  const sweep = async () => { ran++; return { items: 0 }; };
  const cases = [["no secret configured", undefined, "Bearer x", 500], ["short secret", "short", "Bearer short", 500], ["no header", S, undefined, 401], ["wrong value", S, "Bearer nope", 401],
    ["no Bearer prefix", S, S, 401], ["lowercase bearer", S, `bearer ${S}`, 401], ["secret plus junk", S, `Bearer ${S}x`, 401]];
  for (const [label, secret, auth, status] of cases) {
    ran = 0;
    const r = await handleSweepRequest({ authorization: auth, secret, sweep });
    check(`L90 ${label}: ${status} and the sweep did NOT run`, r.status === status && ran === 0, r);
  }
  const ok = await handleSweepRequest({ authorization: `Bearer ${S}`, secret: S, sweep });
  check("L91 the right secret runs the sweep and returns its counts", ok.status === 200 && ok.json.ok === true && ok.json.items === 0 && ran === 1);
  const boom = await handleSweepRequest({ authorization: `Bearer ${S}`, secret: S, sweep: async () => { throw new Error("secret detail"); } });
  check("L92 a failing sweep is a generic 500 that leaks nothing", boom.status === 500 && !JSON.stringify(boom.json).includes("secret detail"));
  check("L93 bearerMatches never throws on odd input", bearerMatches(null, S) === false && bearerMatches(123, S) === false && bearerMatches("Bearer x", null) === false);
}

// ---------------------------------------------------------------- webhook handler: transfer events and afterFulfil
const SECRET = "whsec_test_not_real";
const signed = (body, evId = "evt_1") => { const raw = JSON.stringify(body); return { raw, headers: { "x-razorpay-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex"), "x-razorpay-event-id": evId } }; };
function whDb(o = {}) {
  const calls = [];
  return { calls,
    beginEvent: async (a) => { calls.push(["begin", a]); return o.begin ?? "new"; },
    finishEvent: async (a) => { calls.push(["finish", a]); },
    applyTransferEvent: async (a) => { calls.push(["applyTransfer", a]); if (o.applyThrows) throw Object.assign(new Error("x"), { code: "XX000" }); return { outcome: o.applyOutcome ?? "applied" }; },
    fulfil: async (a) => { calls.push(["fulfil", a]); return o.fulfil ?? { outcome: "fulfilled", purchase_id: PID }; },
  };
}
const tevent = (type = "transfer.processed", e = ent(), at = 1800000100) => ({ entity: "event", event: type, created_at: at, payload: { transfer: { entity: e } } });
{
  const { raw, headers } = signed(tevent());
  const db = whDb();
  const r = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db });
  check("L100 transfer.processed: begin -> applyTransferEvent, 200 with 'transfer_applied'", r.status === 200 && r.json.outcome === "transfer_applied" && db.calls.map((c) => c[0]).join() === "begin,applyTransfer", [r, db.calls.map((c) => c[0])]);
  const a = db.calls[1][1];
  check("L101 the transfer entity's own state is used (not the event name): ids, status, settlement, hold, amounts, recipient, the purchase id from notes, the event time and id",
    a.transferId === "trf_ABCDEF123456" && a.status === "processed" && a.settlementStatus === "pending" && a.onHold === false && a.amountPaise === 40918 && a.recipient === "acc_TestSeller001"
    && a.purchaseId === PID && a.eventAt === 1800000100 && a.eventId === "evt_1" && a.amountReversedPaise === 0, a);
  check("L102 begin is given the transfer's source payment id", db.calls[0][1].paymentId === "pay_1" && db.calls[0][1].eventType === "transfer.processed", db.calls[0][1]);
}
{
  const { raw, headers } = signed(tevent("transfer.failed", ent({ status: "failed" })));
  const db = whDb();
  await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db });
  check("L103 a differently-named event (transfer.failed) goes through the same path and carries status 'failed'", db.calls[1][1].status === "failed");
  const dup = whDb({ begin: "duplicate" });
  const r = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: dup });
  check("L104 a duplicate transfer event: 200 and NOT applied again", r.status === 200 && r.json.duplicate === true && dup.calls.length === 1);
  const bad = signed({ event: "transfer.processed", payload: { transfer: { entity: { id: "trf_x" } } } });
  const db2 = whDb();
  const r2 = await handleRazorpayWebhook({ rawBody: bad.raw, headers: bad.headers, secret: SECRET, feePct: 0.18, db: db2 });
  check("L105 a transfer event with an unreadable entity is flagged needs_review/malformed_payload, never applied", r2.status === 200 && db2.calls.at(-1)[0] === "finish" && db2.calls.at(-1)[1].status === "needs_review" && !db2.calls.some((c) => c[0] === "applyTransfer"));
  const f = whDb({ applyThrows: true });
  const r3 = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: f });
  check("L106 the database failing while applying: event marked 'failed' (so the retry is allowed) and a 500 is returned", r3.status === 500 && f.calls.at(-1)[0] === "finish" && f.calls.at(-1)[1].status === "failed");
  const u = whDb({ applyOutcome: "unknown_transfer" });
  const r4 = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: u });
  check("L107 an outcome that needs a human (unknown_transfer) is still answered 200 (a retry cannot fix it)", r4.status === 200 && r4.json.outcome === "transfer_unknown_transfer");
}
{
  const pay = { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 49900, currency: "INR", status: "captured", method: "upi" } } } };
  const { raw, headers } = signed(pay);
  let hooked = [];
  const db = whDb();
  const r = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db, afterFulfil: async (a) => { hooked.push(a); } });
  check("L110 after a successful fulfilment the hook gets the purchase id", r.status === 200 && hooked.length === 1 && hooked[0].purchaseId === PID, hooked);
  hooked = [];
  await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb({ fulfil: { outcome: "already_fulfilled", purchase_id: PID } }), afterFulfil: async (a) => { hooked.push(a); } });
  check("L111 ...also for 'already_fulfilled' (the browser path won the race; the transfer still has to start)", hooked.length === 1);
  for (const outcome of ["amount_mismatch", "order_unknown", "listing_unavailable", "duplicate_payment", "order_user_mismatch"]) {
    hooked = [];
    await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb({ fulfil: { outcome, purchase_id: null } }), afterFulfil: async (a) => { hooked.push(a); } });
    check(`L112 outcome '${outcome}': NO transfer is started`, hooked.length === 0);
  }
  const r2 = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb(), afterFulfil: async () => { throw new Error("razorpay down"); } });
  check("L113 a throwing hook NEVER changes the answer to Razorpay (still 200 'fulfilled')", r2.status === 200 && r2.json.outcome === "fulfilled", r2);
  const r3 = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb() });
  check("L114 with no hook (5.1 behaviour) everything still works", r3.status === 200 && r3.json.outcome === "fulfilled");
  const dup = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb({ begin: "duplicate" }), afterFulfil: async () => { hooked.push("dup"); } });
  check("L115 a duplicate payment event does not run the hook", dup.status === 200 && !hooked.includes("dup"));
  const nopur = await handleRazorpayWebhook({ rawBody: raw, headers, secret: SECRET, feePct: 0.18, db: whDb({ fulfil: { outcome: "fulfilled", purchase_id: null } }), afterFulfil: async () => { hooked.push("nop"); } });
  check("L116 no purchase id, no hook", !hooked.includes("nop"));
}

// ---------------------------------------------------------------- gaps found by mutation testing
{
  const f = createFakeRazorpay();
  f.seed({ id: "nope", entity: "transfer", source: "pay_1", recipient: "acc_TestSeller001", amount: -5 });   // a list item we cannot read
  const calls = [];
  const db = { planTransfer: async () => ({ outcome: "claimed", purchase_id: PID, payment_id: "pay_1", account_id: "acc_TestSeller001", amount_paise: 40918, on_hold: true, hold_until_epoch: 2000000000, lookup_first: true, attempts: 2 }),
    recordTransferFailure: async (a) => { calls.push(a); return { outcome: "retry_scheduled" }; }, applyTransferEvent: async () => ({ outcome: "applied" }) };
  const r = await createTransferForPurchase({ db, rzp: createRazorpayClient({ keyId: "k", keySecret: "s", fetchImpl: f.fetch }), purchaseId: PID });
  check("L120 if the existing-transfer list has an item we cannot read, we do NOT create: retry later", r.outcome === "retry_scheduled" && f.created.length === 1 && f.log.every((l) => l.method === "GET") && calls[0]?.retryable === true, { r, log: f.log.map((l) => l.method) });
  const { createPaymentsDb } = await import("../../lib/payments/db.js");
  const bad = createPaymentsDb({ rpc: async () => ({ data: null, error: { message: "db down", code: "XX000" } }) });
  let threw = null; try { await bad.planTransfer({ purchaseId: PID }); } catch (e) { threw = e; }
  check("L121 the db wrapper THROWS on an rpc error (never turns it into an empty result)", threw?.code === "XX000");
  const S16 = "0123456789abcdef", S15 = "0123456789abcde";
  check("L122 a 15-character CRON_SECRET is refused even when the header matches; 16 is accepted", bearerMatches(`Bearer ${S15}`, S15) === false && bearerMatches(`Bearer ${S16}`, S16) === true);
}

console.log(`\nA52-L: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
