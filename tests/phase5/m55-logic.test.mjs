// A55-L -- unit tests for the UPI payout code that needs no database (fake RazorpayX + fake db).
// Run:  node tests/phase5/m55-logic.test.mjs
import crypto from "node:crypto";
import { normalizePayoutEntity, extractPayoutEvent, PAYOUT_EVENT_RE } from "../../lib/payments/payout-events.js";
import { createRazorpayClient } from "../../lib/payments/razorpay-client.js";
import { payoutPurchase, pollPayout, runPayoutSweep } from "../../lib/payments/vpa-payouts.js";
import { handleRazorpayWebhook } from "../../lib/payments/webhook-handler.js";
import { runReconciliation } from "../../lib/payments/reconcile.js";
import { createFakeRazorpay } from "./fake-razorpay.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const PID = "11111111-2222-4333-8444-555555555555";
const ent = (o = {}) => ({ id: "pout_ABCDEF123456", entity: "payout", fund_account_id: "fa_ABCDEF123456", amount: 40918, currency: "INR", status: "processed", reference_id: PID, utr: "UTR123", ...o });

// ---------------------------------------------------------------- normalizePayoutEntity
{
  const p = normalizePayoutEntity(ent());
  check("L01 a valid entity normalises", p && p.id === "pout_ABCDEF123456" && p.amountPaise === 40918 && p.status === "processed" && p.utr === "UTR123" && p.fundAccountId === "fa_ABCDEF123456" && p.purchaseId === PID, p);
  const map = { queued: "queued", pending: "queued", processing: "processing", processed: "processed", rejected: "failed", failed: "failed", cancelled: "cancelled", reversed: "reversed" };
  for (const [from, to] of Object.entries(map)) check(`L02 razorpay '${from}' -> '${to}'`, normalizePayoutEntity(ent({ status: from }))?.status === to);
  check("L03 reference '<uuid>-v2' still yields the purchase id (admin retry key)", normalizePayoutEntity(ent({ reference_id: `${PID}-v2` })).purchaseId === PID);
  check("L03b a reference that is not a uuid gives null", normalizePayoutEntity(ent({ reference_id: "abc" })).purchaseId === null);
  check("L04 failure reason is taken from status_details and capped", normalizePayoutEntity(ent({ status: "failed", status_details: { reason: "x".repeat(500) } })).reason.length === 200);
  const bad = { "null": null, "no id": { ...ent(), id: undefined }, "wrong prefix": ent({ id: "trf_ABCDEF123456" }), "amount 0": ent({ amount: 0 }), "amount float": ent({ amount: 1.5 }),
    "USD": ent({ currency: "USD" }), "unknown status": ent({ status: "weird" }) };
  for (const [l, e] of Object.entries(bad)) check(`L05 rejects: ${l}`, normalizePayoutEntity(e) === null);
  check("L06 a fund account id that is not fa_ is dropped", normalizePayoutEntity(ent({ fund_account_id: "bob" })).fundAccountId === null);
  const body = { event: "payout.processed", created_at: 1800000123, payload: { payout: { entity: ent() } } };
  check("L07 extractPayoutEvent carries the event timestamp", extractPayoutEvent(body).eventAt === 1800000123 && extractPayoutEvent({ ...body, created_at: 0 }).eventAt === null);
  check("L08 no payload -> null", extractPayoutEvent({}) === null);
  for (const ok of ["payout.processed", "payout.failed", "payout.reversed", "payout.queued"]) check(`L09 ${ok} is a payout event`, PAYOUT_EVENT_RE.test(ok));
  for (const no of ["payout", "payout.", "payment.captured", "transfer.processed", "payout.A", "payout.a.b"]) check(`L10 '${no}' is NOT a payout event`, !PAYOUT_EVENT_RE.test(no));
}

// ---------------------------------------------------------------- client
function client(fake, o = {}) { return createRazorpayClient({ keyId: "rzp_test_x", keySecret: "sekret", fetchImpl: fake.fetch, timeoutMs: o.timeoutMs ?? 50, accountNumber: "ACCT0001" }); }
{
  const fake = createFakeRazorpay(), rz = client(fake);
  const c = await rz.createContact({ name: "Asha", referenceId: "seller-1" });
  check("L20 createContact posts /v1/contacts and returns a cont_ id", c.ok && /^cont_/.test(c.contactId) && fake.log[0].path === "/v1/contacts" && fake.log[0].body.type === "vendor", c);
  const f = await rz.createVpaFundAccount({ contactId: c.contactId, vpa: "asha@okhdfc" });
  check("L21 createVpaFundAccount: account_type vpa with the address", f.ok && /^fa_/.test(f.fundAccountId) && f.vpa === "asha@okhdfc" && fake.log[1].body.account_type === "vpa" && fake.log[1].body.vpa.address === "asha@okhdfc", f);
  const p = await rz.createVpaPayout({ fundAccountId: f.fundAccountId, amountPaise: 40918, referenceId: PID, idempotencyKey: PID, notes: { purchase_id: PID } });
  const req = fake.log[2];
  check("L22 createVpaPayout: POST /v1/payouts, mode UPI, paise, INR, account_number, reference and the X-Payout-Idempotency header",
    p.ok && req.path === "/v1/payouts" && req.body.mode === "UPI" && req.body.amount === 40918 && req.body.currency === "INR" && req.body.account_number === "ACCT0001"
    && req.body.fund_account_id === f.fundAccountId && req.body.reference_id === PID && req.headers["X-Payout-Idempotency"] === PID && req.body.queue_if_low_balance === true, req);
  check("L23 the same idempotency key returns the SAME payout, no second one", (await rz.createVpaPayout({ fundAccountId: f.fundAccountId, amountPaise: 40918, referenceId: PID, idempotencyKey: PID })).payout.id === p.payout.id && fake.createdPayouts.length === 1);
  const l = await rz.listPayoutsByReference(PID);
  check("L24 listPayoutsByReference filters by reference_id", l.ok && l.payouts.length === 1 && fake.log.at(-1).search.includes("reference_id=" + PID), l);
  check("L25 fetchPayout returns the normalised payout", (await rz.fetchPayout(p.payout.id)).payout.id === p.payout.id);
  const noAcct = createRazorpayClient({ keyId: "k", keySecret: "s", fetchImpl: fake.fetch });
  const before = fake.log.length;
  const n = await noAcct.createVpaPayout({ fundAccountId: f.fundAccountId, amountPaise: 100, referenceId: "r", idempotencyKey: "r" });
  check("L26 without RAZORPAYX_ACCOUNT_NUMBER no payout request is sent (not retryable)", n.ok === false && n.retryable === false && n.code === "payouts_not_configured" && fake.log.length === before, n);
  const f2 = createFakeRazorpay(); f2.payoutFaults.push("garbage");
  const c2 = await client(f2).createContact({ name: "A", referenceId: "x" }); const fa2 = await client(f2).createVpaFundAccount({ contactId: c2.contactId, vpa: "a@b" });
  const g = await client(f2).createVpaPayout({ fundAccountId: fa2.fundAccountId, amountPaise: 100, referenceId: "r", idempotencyKey: "r" });
  check("L27 an unreadable 200 is a RETRYABLE bad_response", g.ok === false && g.retryable === true && g.code === "bad_response", g);
}

// ---------------------------------------------------------------- fake db (mirrors the SQL outcomes the orchestration relies on)
function fakeDb(plan) {
  const calls = [];
  const db = {
    calls,
    planVpaPayout: async (a) => { calls.push(["plan", a]); return typeof plan === "function" ? plan() : plan; },
    recordVpaFundAccount: async (a) => { calls.push(["fund", a]); return { outcome: db.fundOutcome ?? "ok" }; },
    applyVpaPayoutEvent: async (a) => { calls.push(["apply", a]); return { outcome: "applied" }; },
    recordVpaPayoutFailure: async (a) => { calls.push(["fail", a]); return { outcome: a.retryable ? "retry_scheduled" : "failed" }; },
    listVpaPayoutWork: async () => db.work ?? [],
  };
  return db;
}
const claimed = (o = {}) => ({ outcome: "claimed", purchase_id: PID, seller_id: "s1", seller_name: "Asha", vpa: "asha@okhdfc", amount_paise: 40918, payout_key: PID, contact_id: null, fund_account_id: null, lookup_first: false, attempts: 1, ...o });
const seedFa = (fake) => { const c = { id: "cont_SeedC0001" }; fake.contacts.set(c.id, c); const f = { id: "fa_SeedF00001", contact_id: c.id }; fake.fundAccounts.set(f.id, f); return f.id; };

{
  const fake = createFakeRazorpay(), db = fakeDb(claimed());
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID, now: () => 1800000000 });
  const ap = db.calls.find((c) => c[0] === "apply")?.[1];
  check("L30 first payout: contact + fund account created, remembered, payout sent, event applied", r.outcome === "created" && db.calls.map((c) => c[0]).join() === "plan,fund,apply"
    && ap.status === "queued" && ap.amountPaise === 40918 && ap.purchaseId === PID && ap.eventAt === 1800000000 && fake.createdPayouts.length === 1);
  check("L31 the destination is the fund account for the UPI id on the claim", fake.fundAccounts.size === 1 && [...fake.fundAccounts.values()][0].vpa.address === "asha@okhdfc");
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake), db = fakeDb(claimed({ contact_id: "cont_SeedC0001", fund_account_id: fa }));
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L32 a seller with a stored fund account makes NO contact/fund-account calls", r.outcome === "created" && fake.log.every((l) => l.path === "/v1/payouts") && !db.calls.some((c) => c[0] === "fund"));
}
for (const [outcome] of [["not_found"], ["disabled"], ["before_cutoff"], ["no_account"], ["route_transfer_exists"], ["over_cap"], ["exists"], ["backoff"], ["in_progress"], ["parked"], ["not_eligible"]]) {
  const fake = createFakeRazorpay(), db = fakeDb({ outcome });
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check(`L33 plan outcome '${outcome}' sends NOTHING to Razorpay`, r.outcome === outcome && fake.log.length === 0);
}
{
  // a timeout AFTER Razorpay created the payout, then the retry (lookup_first) must adopt it, not send money twice
  const fake = createFakeRazorpay(), fa = seedFa(fake); fake.payoutFaults.push("timeout_after");
  const db1 = fakeDb(claimed({ contact_id: "cont_SeedC0001", fund_account_id: fa }));
  const r1 = await payoutPurchase({ db: db1, rzp: client(fake), purchaseId: PID });
  check("L40 timeout after creation -> retry scheduled, payout exists at Razorpay", r1.outcome === "retry_scheduled" && fake.createdPayouts.length === 1 && db1.calls.at(-1)[1].retryable === true, r1);
  const db2 = fakeDb(claimed({ contact_id: "cont_SeedC0001", fund_account_id: fa, lookup_first: true, attempts: 2 }));
  const r2 = await payoutPurchase({ db: db2, rzp: client(fake), purchaseId: PID });
  check("L41 the retry LISTS first and adopts the existing payout: still exactly one payout, no create call", r2.outcome === "adopted" && fake.createdPayouts.length === 1 && fake.log.filter((l) => l.method === "POST" && l.path === "/v1/payouts").length === 1, r2);
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake);
  fake.seedPayout({ id: "pout_Other000001", entity: "payout", fund_account_id: fa, amount: 5, currency: "INR", status: "queued", reference_id: PID });
  const db = fakeDb(claimed({ fund_account_id: fa, contact_id: "cont_SeedC0001", lookup_first: true }));
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L42 an existing payout with a DIFFERENT amount is never adopted nor duplicated (non-retryable failure)", r.outcome === "failed" && db.calls.at(-1)[1].retryable === false && fake.createdPayouts.length === 1);
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake);
  fake.seedPayout({ id: "pout_Dup0000001", entity: "payout", fund_account_id: fa, amount: 40918, currency: "INR", status: "queued", reference_id: PID });
  fake.seedPayout({ id: "pout_Dup0000002", entity: "payout", fund_account_id: fa, amount: 40918, currency: "INR", status: "queued", reference_id: PID });
  const db = fakeDb(claimed({ fund_account_id: fa, contact_id: "cont_SeedC0001", lookup_first: true }));
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L43 two payouts for one reference: stop, make it loud (non-retryable)", r.outcome === "failed" && /duplicate/.test(db.calls.at(-1)[1].error));
}
for (const [fault, retryable] of [["500", true], ["429", true], ["400", false], ["network", true], ["garbage", true]]) {
  const fake = createFakeRazorpay(), fa = seedFa(fake); fake.payoutFaults.push(fault);
  const db = fakeDb(claimed({ fund_account_id: fa, contact_id: "cont_SeedC0001" }));
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check(`L44 payout fault '${fault}' -> failure recorded, retryable=${retryable}, no apply`, db.calls.at(-1)[0] === "fail" && db.calls.at(-1)[1].retryable === retryable && !db.calls.some((c) => c[0] === "apply") && r.outcome === (retryable ? "retry_scheduled" : "failed"), r);
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake); fake.payoutFaults.push("amount_mismatch");
  const db = fakeDb(claimed({ fund_account_id: fa, contact_id: "cont_SeedC0001" }));
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L45 Razorpay answering with another amount is NOT recorded as ours", r.outcome === "failed" && !db.calls.some((c) => c[0] === "apply") && /response_mismatch/.test(db.calls.at(-1)[1].error));
}
{
  const fake = createFakeRazorpay(); fake.fundFaults.push("500");
  const db = fakeDb(claimed());
  const r = await payoutPurchase({ db, rzp: client(fake), purchaseId: PID });
  check("L46 fund-account creation failure -> retry, no payout sent", r.outcome === "retry_scheduled" && fake.createdPayouts.length === 0);
  const db2 = fakeDb(claimed()); db2.fundOutcome = "vpa_changed";
  const r2 = await payoutPurchase({ db: db2, rzp: client(createFakeRazorpay()), purchaseId: PID });
  check("L47 seller changed UPI id mid-flight: no payout is sent to the old one", r2.outcome === "failed" && db2.calls.at(-1)[1].error.startsWith("vpa_changed"));
  const f3 = createFakeRazorpay(), db3 = { ...fakeDb(claimed()) }; db3.planVpaPayout = async () => { throw new Error("db down"); };
  let threw = false; try { await payoutPurchase({ db: db3, rzp: client(f3), purchaseId: PID }); } catch { threw = true; }
  check("L48 a database error while planning sends nothing to Razorpay", f3.log.length === 0);
  const db4 = fakeDb(claimed()); db4.applyVpaPayoutEvent = async () => { throw new Error("boom"); };
  const f4 = createFakeRazorpay();
  const r4 = await payoutPurchase({ db: db4, rzp: client(f4), purchaseId: PID });
  check("L49 an error AFTER the payout was created is retryable and leaves one payout (the retry adopts it)", r4.outcome === "retry_scheduled" && f4.createdPayouts.length === 1);
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake);
  const created = (await client(fake).createVpaPayout({ fundAccountId: fa, amountPaise: 500, referenceId: PID, idempotencyKey: PID })).payout;
  fake.payouts.get(created.id).status = "processed"; fake.payouts.get(created.id).utr = "U9";
  const db = fakeDb(claimed());
  const r = await pollPayout({ db, rzp: client(fake), purchaseId: PID, payoutId: created.id, now: () => 5 });
  check("L50 pollPayout re-reads the payout and applies it (status, utr, time taken before the request)", r.outcome === "polled" && db.calls[0][1].status === "processed" && db.calls[0][1].utr === "U9" && db.calls[0][1].eventAt === 5);
  let clock = 100; const ticking = { fetch: async (...a) => { clock = 200; return fake.fetch(...a); } };
  const db2 = fakeDb(claimed());
  await pollPayout({ db: db2, rzp: client(ticking), purchaseId: PID, payoutId: created.id, now: () => clock });
  check("L50b the poll timestamp is taken BEFORE the request (a webhook that lands meanwhile is newer)", db2.calls[0][1].eventAt === 100, db2.calls[0][1]);
  const r2 = await pollPayout({ db, rzp: client(fake), purchaseId: PID, payoutId: "pout_Missing0001" });
  check("L51 an unknown payout id is poll_failed, nothing applied", r2.outcome === "poll_failed");
}
{
  const fake = createFakeRazorpay(), fa = seedFa(fake);
  const db = fakeDb(claimed({ fund_account_id: fa, contact_id: "cont_SeedC0001" }));
  db.work = [{ kind: "create", purchase_id: PID }, { kind: "poll", purchase_id: PID, razorpay_payout_id: "pout_Missing0001" }, { kind: "weird" }];
  const c = await runPayoutSweep({ db, rzp: client(fake), limit: 10 });
  check("L60 the sweep counts created / skipped and isolates items", c.items === 3 && c.created === 1 && c.skipped === 2, c);
  let t = 0; db.work = [{ kind: "create", purchase_id: PID }, { kind: "create", purchase_id: PID }];
  const c2 = await runPayoutSweep({ db, rzp: client(fake), limit: 10, budgetMs: 5, nowMs: () => (t += 10) });
  check("L61 the sweep stops at its time budget", c2.timeBudgetHit === true);
}

{
  const fake = createFakeRazorpay(), real = client(fake);
  const lying = { ...real, createVpaFundAccount: async (a) => { const r = await real.createVpaFundAccount(a); return { ...r, vpa: "someone.else@ybl" }; } };
  const db = fakeDb(claimed());
  const r = await payoutPurchase({ db, rzp: lying, purchaseId: PID });
  check("L46b a fund account for a DIFFERENT UPI id than the claim is refused (non-retryable) and no payout is sent", r.outcome === "failed" && fake.createdPayouts.length === 0 && /fund_account_mismatch/.test(db.calls.at(-1)[1].error), r);
}

// ---------------------------------------------------------------- webhook branch
const SECRET = "whsec_test_secret_12345";
const sign = (raw) => crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
const hook = async (event, body, db) => { const raw = JSON.stringify(body); return handleRazorpayWebhook({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw), "x-razorpay-event-id": event }, secret: SECRET, feePct: 10, db }); };
{
  const calls = [];
  const db = { beginEvent: async () => "new", finishEvent: async (a) => { calls.push(["finish", a]); }, applyVpaPayoutEvent: async (a) => { calls.push(["apply", a]); return { outcome: "applied" }; } };
  const r = await hook("evt_1", { event: "payout.processed", created_at: 1800000123, payload: { payout: { entity: ent() } } }, db);
  check("L70 payout.processed is applied through apply_vpa_payout_event with the event id", r.status === 200 && r.json.outcome === "payout_applied" && calls[0][1].payoutId === "pout_ABCDEF123456" && calls[0][1].eventId === "evt_1" && calls[0][1].status === "processed" && calls[0][1].eventAt === 1800000123, r);
  const calls2 = []; const db2 = { beginEvent: async () => "new", finishEvent: async (a) => { calls2.push(a); } };
  const r2 = await hook("evt_2", { event: "payout.failed", payload: { payout: { entity: { id: "x" } } } }, db2);
  check("L71 an unreadable payout event is marked needs_review (not silently dropped)", r2.status === 200 && calls2[0].status === "needs_review");
  const db3 = { beginEvent: async () => "new", finishEvent: async () => {}, applyVpaPayoutEvent: async () => { throw new Error("down"); } };
  const r3 = await hook("evt_3", { event: "payout.processed", payload: { payout: { entity: ent() } } }, db3);
  check("L72 a database error while applying gives 500 so Razorpay retries", r3.status === 500);
  const db4 = { beginEvent: async () => "duplicate" };
  check("L73 a duplicate payout event is a no-op 200", (await hook("evt_4", { event: "payout.processed", payload: { payout: { entity: ent() } } }, db4)).json.duplicate === true);
}

// ---------------------------------------------------------------- reconcile
{
  const db = { listDisputeWork: async () => [], listTransferWork: async () => [], listVpaPayoutWork: async () => [{ kind: "poll", purchase_id: PID, razorpay_payout_id: "pout_Missing0001" }] };
  const r = await runReconciliation({ db, rzp: client(createFakeRazorpay()), limit: 5, budgetMs: 20000 });
  check("L80 the reconciliation pass also runs the UPI payout sweep", r.payouts && r.payouts.items === 1 && r.disputes !== undefined, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
