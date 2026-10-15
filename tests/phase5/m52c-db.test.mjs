// A52c-D -- Milestone 5.2c database tests: disputes -> hold / release / reverse / refund (migration 20261014100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m52c-db.test.mjs
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const q = (sql, params) => client.query(sql, params);
const val = async (sql, params) => (await q(sql, params)).rows[0]?.v;
const id = (n) => `00000000-0000-0000-0000-0000000ccc${n}`;
const U = { seller: id(61), buyer: id(62), other: id(63), admin: id(64), seller2: id(65) };
const ACC = "acc_TestSeller001", TRF = "trf_TestTransfer01", TRF2 = "trf_TestTransfer02";
const AAL2 = { aal: "aal2" };

async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a52-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function flag(on = true) { await q(`update private.feature_flags set enabled=$1 where name='phase5_route_transfers'`, [on]); }
let seq = 0;
async function mkPurchase({ amount = 499, fee = 89.82, status = "paid", payId, ago = "0 minutes", seller = U.seller, buyer = U.buyer, account = "active" } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A52','n','n',$1,'S',$2,'live') returning id`, [amount, seller]);
  const pay = payId === undefined ? `pay_T${++seq}` : payId;
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at)
     values ($1,$2,$3,$4,$5,$6, now() - $7::interval) returning id, purchased_at`, [buyer, l.id, amount, status, pay, fee, ago]);
  if (account) await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,$2,$3) on conflict (user_id) do update set status = excluded.status, razorpay_account_id = excluded.razorpay_account_id`, [seller, ACC, account]);
  return { pid: p.id, lid: l.id, pay, purchasedAt: p.purchased_at };
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, rowCount: r.rowCount, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], rowCount: 0, err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const svc = (sql, params) => as("service_role", null, null, sql, params);
const plan = async (pid) => (await svc(`select public.plan_transfer($1) as v`, [pid])).rows[0]?.v;
const planR = (pid) => svc(`select public.plan_transfer($1) as v`, [pid]);
const fail_ = async (pid, err = "boom", retryable = true) => (await svc(`select public.record_transfer_failure($1,$2,$3) as v`, [pid, err, retryable])).rows[0]?.v;
const T0 = 1_800_000_000;
const apply = (o = {}) => svc(`select public.apply_transfer_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as v`, [
  o.trf ?? TRF, "pid" in o ? o.pid : null, "status" in o ? o.status : "created", "settle" in o ? o.settle : "on_hold", "hold" in o ? o.hold : true,
  "rev" in o ? o.rev : 0, "at" in o ? o.at : T0, "amount" in o ? o.amount : null, "recipient" in o ? o.recipient : null, o.event ?? null]);
const out = async (o) => (await apply(o)).rows[0]?.v?.outcome;
const row = async (pid) => (await q(`select * from public.transfers where purchase_id=$1`, [pid])).rows[0];
const ptype = async (pid) => (await q(`select transfer_status, razorpay_transfer_id from public.purchases where id=$1`, [pid])).rows[0];
const code = (r) => r.err?.code;


async function setRefundsFlag(on) { await q(`update private.feature_flags set enabled=$1 where name='phase5_auto_refunds'`, [on]); }
let n = 0;
// a purchase with a live transfer (status created, on a 48h hold), optional dispute
async function mkLinked({ dispute = null, ago = "0 minutes", transfer = true, account = "active", refunded = false } = {}) {
  const p = await mkPurchase({ ago, account });
  if (transfer) {
    await flag(true);
    const c = await plan(p.pid);
    if (c.outcome !== "claimed") throw new Error("setup: " + JSON.stringify(c));
    p.trf = `trf_Lnk${++n}000000`;
    await apply({ trf: p.trf, pid: p.pid, status: "created", settle: "on_hold", hold: true, rev: 0, at: T0 });
  }
  if (dispute) await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason',$5)`, [p.pid, p.lid, U.buyer, U.seller, dispute]);
  if (refunded) await q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
  return p;
}
const needed = async (pid) => (await q(`select private.dispute_action_needed($1) as v`, [pid])).rows[0].v;
const claim = async (pid, a) => (await svc(`select public.claim_dispute_action($1,$2) as v`, [pid, a])).rows[0]?.v;
const claimR = (pid, a) => svc(`select public.claim_dispute_action($1,$2) as v`, [pid, a]);
const finish = async (pid, a, ok, retryable = null, error = null, hold = null, until = null) =>
  (await svc(`select public.finish_dispute_action($1,$2,$3,$4,$5,$6,$7) as v`, [pid, a, ok, retryable, error, hold, until])).rows[0]?.v;
const planRefund = async (pid) => (await svc(`select public.plan_refund($1) as v`, [pid])).rows[0]?.v;
const refundFail = async (pid, err = "boom", r = true) => (await svc(`select public.record_refund_failure($1,$2,$3) as v`, [pid, err, r])).rows[0]?.v;
const applyRefund = (o = {}) => svc(`select public.apply_refund_event($1,$2,$3,$4,$5,$6,$7) as v`, [
  o.rf ?? "rfnd_TestRefund01", "pid" in o ? o.pid : null, o.status ?? "pending", "amount" in o ? o.amount : null, "pay" in o ? o.pay : null, "at" in o ? o.at : T0, o.event ?? null]);
const rout = async (o) => (await applyRefund(o)).rows[0]?.v?.outcome;
const refundRow = async (pid) => (await q(`select * from public.refunds where purchase_id=$1`, [pid])).rows[0];
const makeDueAction = (pid) => q(`update public.transfers set action_next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [pid]);

// ---------------------------------------------------------------- exposure
{
  const sigs = {
    claim_dispute_action: "uuid,text", finish_dispute_action: "uuid,text,boolean,boolean,text,boolean,bigint", list_dispute_work: "integer", plan_refund: "uuid",
    apply_refund_event: "text,uuid,text,integer,text,bigint,text", record_refund_failure: "uuid,text,boolean", admin_clear_transfer_review: "uuid",
  };
  for (const [fn, args] of Object.entries(sigs)) {
    const has = (role) => val(`select has_function_privilege('${role}', 'public.${fn}(${args})', 'execute') as v`);
    const adminFn = fn === "admin_clear_transfer_review";
    check(`E01 ${fn}: ${adminFn ? "authenticated (checks admin+MFA itself)" : "service_role only"}`, (await has("anon")) === false && (await has("authenticated")) === adminFn && (await has("service_role")) === !adminFn);
    const { rows: [r] } = await q(`select prosecdef, proconfig from pg_proc where oid = 'public.${fn}(${args})'::regprocedure`);
    check(`E02 ${fn}: SECURITY DEFINER, empty search_path`, r.prosecdef === true && (r.proconfig ?? []).some((c) => /^search_path=("")?$/.test(c)), r);
  }
  for (const f of ["is_auto_refunds_enabled()", "dispute_action_needed(uuid)"]) {
    const any = await val(`select (has_function_privilege('anon','private.${f}','execute') or has_function_privilege('authenticated','private.${f}','execute') or has_function_privilege('service_role','private.${f}','execute')) as v`);
    check(`E03 private.${f} is callable by no API role`, any === false);
  }
  check("E04 the refund flag is seeded OFF; the route flag is OFF", (await val(`select enabled as v from private.feature_flags where name='phase5_auto_refunds'`)) === false
    && (await val(`select enabled as v from private.feature_flags where name='phase5_route_transfers'`)) === false);
  check("E05 plan_transfer still has its 5.2 grants after CREATE OR REPLACE (service_role only)", (await val(`select has_function_privilege('authenticated','public.plan_transfer(uuid)','execute') as v`)) === false
    && (await val(`select has_function_privilege('service_role','public.plan_transfer(uuid)','execute') as v`)) === true);
}

// ---------------------------------------------------------------- open dispute -> hold
await inTxn(async () => {
  const p = await mkLinked();
  check("E10 no dispute: nothing is needed", (await needed(p.pid)) === null);
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','open')`, [p.pid, p.lid, U.buyer, U.seller]);
  check("E11 an open dispute on a live transfer with a timed hold -> 'hold'", (await needed(p.pid)) === "hold");
  const c = await claim(p.pid, "hold");
  check("E12 claim returns the transfer id and takes a lease", c.outcome === "claimed" && c.razorpay_transfer_id === p.trf && (await row(p.pid)).action_lease_until !== null && (await row(p.pid)).action_attempts === 1, c);
  check("E13 while leased, nothing is needed and a second claim is 'not_needed'", (await needed(p.pid)) === null && (await claim(p.pid, "hold")).outcome === "not_needed");
  check("E14 claiming an action that is not what the dispute needs is 'not_needed'", (await claim(p.pid, "reverse")).outcome === "not_needed");
  const f = await finish(p.pid, "hold", false, true, "timeout");
  const t1 = await row(p.pid);
  check("E15 a retryable failure schedules a backoff and releases the lease", f.outcome === "retry_scheduled" && t1.action_lease_until === null && t1.action_next_attempt_at !== null && (await needed(p.pid)) === null, f);
  await makeDueAction(p.pid);
  check("E16 once due it is needed again", (await needed(p.pid)) === "hold");
  await claim(p.pid, "hold");
  const ok = await finish(p.pid, "hold", true);
  const t2 = await row(p.pid);
  check("E17 success: held indefinitely (on_hold, no end), counters reset, purchases 'held'", ok.outcome === "ok" && t2.on_hold === true && t2.hold_until === null && t2.action_attempts === 0 && (await ptype(p.pid)).transfer_status === "held", t2);
  check("E18 and nothing more is needed", (await needed(p.pid)) === null);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  for (let i = 0; i < 7; i++) { await claim(p.pid, "hold"); await finish(p.pid, "hold", false, true, "boom"); await makeDueAction(p.pid); }
  check("E19 after 7 retryable failures it is still retried; the 8th PARKS it for review", (await row(p.pid)).review_reason === null && (await needed(p.pid)) === "hold");
  await claim(p.pid, "hold");
  const f = await finish(p.pid, "hold", false, true, "boom");
  const t = await row(p.pid);
  check("E20 parked: review_reason set, nothing needed any more", f.outcome === "needs_review" && /^dispute_hold: boom/.test(t.review_reason) && (await needed(p.pid)) === null, t);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await claim(p.pid, "hold");
  const f = await finish(p.pid, "hold", false, false, "BAD_REQUEST: refused");
  check("E21 a non-retryable failure parks at once", f.outcome === "needs_review" && (await row(p.pid)).review_reason !== null);
  const c = await svc(`select public.admin_clear_transfer_review($1)`, [p.pid]);
  check("E22 service_role cannot clear a review (admin RPC only)", c.err !== null);
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.admin, role: "authenticated", aal: "aal2" })]);
  await q("set local role authenticated");
  await q("SAVEPOINT a");
  let e = null; try { await q(`select public.admin_clear_transfer_review($1)`, [p.pid]); } catch (x) { e = x; }
  await q("RELEASE SAVEPOINT a"); await q("reset role");
  check("E23 an admin at aal2 clears it; it is audited; the action is needed again", e === null && (await row(p.pid)).review_reason === null && (await needed(p.pid)) === "hold"
    && (await val(`select count(*)::int as v from public.audit_log where action='transfer_review_cleared' and target_id=$1`, [p.pid])) === 1, e?.message);
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ sub: U.admin, role: "authenticated", aal: "aal1" })]);
  await q("set local role authenticated"); await q("SAVEPOINT a");
  let e2 = null; try { await q(`select public.admin_clear_transfer_review($1)`, [p.pid]); } catch (x) { e2 = x; }
  await q("ROLLBACK TO SAVEPOINT a"); await q("reset role");
  check("E24 an admin WITHOUT aal2 is refused (42501)", e2?.code === "42501", e2?.code);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await apply({ trf: p.trf, pid: p.pid, status: "processed", settle: "settled", hold: false, rev: 0, at: T0 + 10 });
  check("E25 a dispute after the money SETTLED -> 'flag' (cannot be held)", (await needed(p.pid)) === "flag");
  await claim(p.pid, "flag");
  const f = await finish(p.pid, "flag", false, false, "dispute_opened_after_settlement");
  check("E26 flag parks it for review", f.outcome === "needs_review" && /dispute_opened_after_settlement/.test((await row(p.pid)).review_reason));
});
await inTxn(async () => {
  const p = await mkPurchase(); await flag(true); await plan(p.pid);   // transfer row exists but status 'creating', no id
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','open')`, [p.pid, p.lid, U.buyer, U.seller]);
  check("E27 an open dispute while the transfer is still 'creating' needs nothing (it will be created held, or adopted then held)", (await needed(p.pid)) === null);
});
await inTxn(async () => {
  const p = await mkPurchase({ account: null }); await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','open')`, [p.pid, p.lid, U.buyer, U.seller]);
  check("E28 a dispute on a purchase with no transfer at all needs nothing; claim says not_found", (await needed(p.pid)) === null && (await claim(p.pid, "hold")).outcome === "not_found");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await flag(false);
  check("E29 'hold' is protective: it still runs with the transfers flag OFF", (await needed(p.pid)) === "hold" && (await claim(p.pid, "hold")).outcome === "claimed");
});

// ---------------------------------------------------------------- resolved_denied -> release
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await claim(p.pid, "hold"); await finish(p.pid, "hold", true);
  await q(`update public.disputes set status='resolved_denied' where purchase_id=$1`, [p.pid]);
  check("E30 denied + indefinitely held + route flag ON -> 'release'", (await needed(p.pid)) === "release");
  await flag(false);
  check("E31 with the route flag OFF a release is NOT done (it is the step that pays the seller)", (await needed(p.pid)) === null && (await claim(p.pid, "release")).outcome === "disabled");
  await flag(true);
  const c = await claim(p.pid, "release");
  check("E32 a release inside the original 48h window RESTORES that window (does not shorten it)", c.outcome === "claimed" && c.on_hold === true && c.hold_until_epoch > Math.floor(Date.now() / 1000) + 47 * 3600, c);
  const f = await finish(p.pid, "release", true, null, null, c.on_hold, c.hold_until_epoch);
  const t = await row(p.pid);
  check("E33 finish records the restored hold; nothing more is needed", f.outcome === "ok" && t.on_hold === true && t.hold_until !== null && (await needed(p.pid)) === null, t);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open", ago: "49 hours" });
  await claim(p.pid, "hold"); await finish(p.pid, "hold", true);
  await q(`update public.disputes set status='resolved_denied' where purchase_id=$1`, [p.pid]);
  const c = await claim(p.pid, "release");
  check("E34 a release after the 48h window has passed lifts the hold (on_hold false, no end)", c.on_hold === false && c.hold_until_epoch === null, c);
  await finish(p.pid, "release", true, null, null, c.on_hold, c.hold_until_epoch);
  check("E35 ledger released, purchases mapping follows (created+released -> held until processed)", (await row(p.pid)).on_hold === false && (await row(p.pid)).hold_until === null && (await needed(p.pid)) === null);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open", ago: "49 hours" });
  await claim(p.pid, "hold"); await finish(p.pid, "hold", true);
  await q(`update public.disputes set status='resolved_denied' where purchase_id=$1`, [p.pid]);
  await claim(p.pid, "release");
  await apply({ trf: p.trf, pid: p.pid, status: "processed", settle: "settled", hold: false, rev: 0, at: T0 + 50 });
  const f = await finish(p.pid, "release", true, null, null, true, Math.floor(Date.now() / 1000) + 99999);
  const t = await row(p.pid);
  check("E36 a transfer that settled meanwhile is never put back on hold by a late 'ok'", f.outcome === "ok" && t.on_hold === false && t.hold_until === null && t.settlement_status === "settled", t);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_denied" });
  check("E37 denied but the transfer is just on its normal timed hold -> nothing to do", (await needed(p.pid)) === null);
});

// ---------------------------------------------------------------- resolved_refunded -> reverse, then refund
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  check("E40 refunded + live transfer -> 'reverse' (first, always)", (await needed(p.pid)) === "reverse");
  const c = await claim(p.pid, "reverse");
  check("E41 claim returns the amounts", c.outcome === "claimed" && c.amount_paise === 40918 && c.amount_reversed_paise === 0 && c.razorpay_transfer_id === p.trf, c);
  await finish(p.pid, "reverse", false, true, "x");
  await makeDueAction(p.pid);
  await claim(p.pid, "reverse");
  await apply({ trf: p.trf, pid: p.pid, status: "partially_reversed", settle: "on_hold", hold: true, rev: 1000, at: T0 + 5 });
  await finish(p.pid, "reverse", false, true, "reversal_not_confirmed");
  await makeDueAction(p.pid);
  check("E42 a PARTIAL reversal still needs 'reverse'", (await needed(p.pid)) === "reverse");
  await claim(p.pid, "reverse");
  await apply({ trf: p.trf, pid: p.pid, status: "reversed", settle: "on_hold", hold: true, rev: 40918, at: T0 + 9 });
  await finish(p.pid, "reverse", true);
  check("E43 fully reversed: purchases 'reversed', nothing more for the transfer; refund still off", (await ptype(p.pid)).transfer_status === "reversed" && (await needed(p.pid)) === null);
  await setRefundsFlag(true);
  check("E44 with phase5_auto_refunds ON -> 'refund'", (await needed(p.pid)) === "refund");
  const pl = await planRefund(p.pid);
  check("E45 plan_refund claims the FULL amount in paise (49900)", pl.outcome === "claimed" && pl.amount_paise === 49900 && pl.payment_id === p.pay && pl.attempts === 1, pl);
  check("E46 a second plan_refund while in flight is 'not_needed'", (await planRefund(p.pid)).outcome === "not_needed" && (await val(`select count(*)::int as v from public.refunds where purchase_id=$1`, [p.pid])) === 1);
  const f = await refundFail(p.pid, "timeout", true);
  const r1 = await refundRow(p.pid);
  check("E47 retryable refund failure -> backoff, still 'creating'", f.outcome === "retry_scheduled" && r1.status === "creating" && r1.next_attempt_at !== null && (await needed(p.pid)) === null, r1);
  await q(`update public.refunds set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [p.pid]);
  check("E48 when due it is needed again and the claim bumps attempts", (await needed(p.pid)) === "refund" && (await planRefund(p.pid)).attempts === 2);
  check("E49 refund.pending event adopts the claimed row by notes.purchase_id", (await rout({ rf: "rfnd_TestRefund01", pid: p.pid, status: "pending", amount: 49900, pay: p.pay, at: T0 })) === "applied" && (await refundRow(p.pid)).razorpay_refund_id === "rfnd_TestRefund01");
  check("E50 the same refund id by id alone (no notes) applies; processed", (await rout({ rf: "rfnd_TestRefund01", status: "processed", amount: 49900, pay: p.pay, at: T0 + 5 })) === "applied" && (await refundRow(p.pid)).status === "processed");
  check("E51 a late 'pending' cannot move processed back", (await rout({ rf: "rfnd_TestRefund01", status: "pending", at: T0 + 9 })) === "stale" && (await refundRow(p.pid)).status === "processed");
  check("E52 processed is terminal: a 'failed' after it is stale", (await rout({ rf: "rfnd_TestRefund01", status: "failed", at: T0 + 20 })) === "stale");
  check("E53 nothing is needed after a processed refund", (await needed(p.pid)) === null);
  check("E54 an unknown refund id is 'unknown_refund'", (await rout({ rf: "rfnd_Nobody00001", status: "pending" })) === "unknown_refund");
  check("E55 a SECOND refund id for the purchase is 'conflicting_refund', nothing written", (await rout({ rf: "rfnd_Second000001", pid: p.pid, status: "pending", amount: 49900 })) === "conflicting_refund" && (await refundRow(p.pid)).razorpay_refund_id === "rfnd_TestRefund01");
  check("E56 an amount or payment mismatch is 'inconsistent_event'", (await rout({ rf: "rfnd_TestRefund01", status: "processed", amount: 1 })) === "inconsistent_event" && (await rout({ rf: "rfnd_TestRefund01", status: "processed", pay: "pay_other" })) === "inconsistent_event");
  const inv = [["bad id", { rf: "refund_1" }], ["bad status", { status: "done" }], ["zero amount", { amount: 0 }], ["bad time", { at: -1 }]];
  for (const [label, o] of inv) check(`E57 apply_refund_event rejects ${label} (CM072)`, code(await applyRefund(o)) === "CM072");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await setRefundsFlag(true);
  check("E60 refund is NOT offered while the transfer is still live and unreversed", (await needed(p.pid)) === "reverse" && (await planRefund(p.pid)).outcome === "not_needed");
  await claim(p.pid, "reverse");
  await finish(p.pid, "reverse", false, false, "BAD_REQUEST: linked account balance too low");
  check("E61 a reversal Razorpay refuses PARKS the purchase: no automatic refund (a human decides)", (await needed(p.pid)) === null && (await planRefund(p.pid)).outcome === "not_needed" && (await refundRow(p.pid)) === undefined);
});
await inTxn(async () => {
  const p = await mkPurchase({ account: null, refunded: true });
  await q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','resolved_refunded')`, [p.pid, p.lid, U.buyer, U.seller]);
  check("E62 refunded with NO transfer at all, flag OFF -> nothing automatic", (await needed(p.pid)) === null && (await planRefund(p.pid)).outcome === "disabled");
  await setRefundsFlag(true);
  check("E63 ... and with phase5_auto_refunds ON -> 'refund'", (await needed(p.pid)) === "refund");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [p.pid]);
  await setRefundsFlag(true);
  check("E64 refunded + a FAILED transfer (nothing to reverse) -> 'refund'", (await needed(p.pid)) === "refund");
});
await inTxn(async () => {
  const p = await mkPurchase(); await flag(true); await plan(p.pid);
  await q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','resolved_refunded')`, [p.pid, p.lid, U.buyer, U.seller]);
  await setRefundsFlag(true);
  check("E65 refunded while the transfer is still 'creating' -> wait (it may exist at Razorpay)", (await needed(p.pid)) === null);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded" });
  await setRefundsFlag(true);
  await q(`update public.transfers set status='reversed', amount_reversed_paise=amount_paise where purchase_id=$1`, [p.pid]);
  check("E66 a dispute marked refunded but the purchase is not 'refunded' -> no refund", (await needed(p.pid)) === null);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  for (let i = 0; i < 2; i++) { await claim(p.pid, "reverse"); await apply({ trf: p.trf, pid: p.pid, status: "reversed", settle: "on_hold", hold: true, rev: 40918, at: T0 + 9 }); await finish(p.pid, "reverse", true); break; }
  await setRefundsFlag(true); await planRefund(p.pid);
  for (let i = 0; i < 7; i++) { await refundFail(p.pid, "boom", true); await q(`update public.refunds set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [p.pid]); await planRefund(p.pid); }
  const f = await refundFail(p.pid, "boom", true);
  check("E67 after 8 retryable refund failures it becomes 'failed'; failed is not retried", f.outcome === "failed" && (await refundRow(p.pid)).status === "failed" && (await needed(p.pid)) === null);
});

// ---------------------------------------------------------------- list, plan_transfer, RLS, validation
await inTxn(async () => {
  const a = await mkLinked({ dispute: "open" });
  const b = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  const items = (await svc(`select public.list_dispute_work(50) as v`)).rows[0].v;
  const mine = items.filter((i) => [a.pid, b.pid].includes(i.purchase_id));
  check("E70 list_dispute_work: protective actions first (hold before reverse), nothing else", mine.length === 2 && mine[0].kind === "hold" && mine[0].purchase_id === a.pid && mine[1].kind === "reverse", mine);
  await claim(a.pid, "hold");
  const after = (await svc(`select public.list_dispute_work(50) as v`)).rows[0].v;
  check("E71 a leased item disappears from the list", !after.some((i) => i.purchase_id === a.pid));
  const one = (await svc(`select public.list_dispute_work(1) as v`)).rows[0].v;
  check("E72 the limit is honoured", one.length === 1);
});
await inTxn(async () => {
  const p = await mkPurchase({ ago: "0 minutes" }); await flag(true);
  await plan(p.pid);
  await q(`update public.transfers set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [p.pid]);
  const open = await plan(p.pid);
  check("E75 plan_transfer reclaim without a refund dispute: adopt_only false", open.outcome === "claimed" && open.adopt_only === false && open.lookup_first === true, open);
  await q(`update public.purchases set status='refunded' where id=$1`, [p.pid]);
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a52c test reason','resolved_refunded')`, [p.pid, p.lid, U.buyer, U.seller]);
  await q(`update public.transfers set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [p.pid]);
  const re = await plan(p.pid);
  check("E76 plan_transfer reclaim after the dispute was refunded: adopt_only TRUE (never create a new transfer)", re.outcome === "claimed" && re.adopt_only === true, re);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await setRefundsFlag(true);
  await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [p.pid]);
  await planRefund(p.pid); await applyRefund({ rf: "rfnd_RlsRefund001", pid: p.pid, status: "pending", amount: 49900, pay: p.pay });
  const buyer = await as("authenticated", U.buyer, null, `select count(*)::int as c from public.refunds`);
  const other = await as("authenticated", U.other, null, `select count(*)::int as c from public.refunds`);
  const seller = await as("authenticated", U.seller, null, `select count(*)::int as c from public.refunds`);
  const admin = await as("authenticated", U.admin, null, `select count(*)::int as c from public.refunds`);
  check("E80 RLS: the buyer sees their refund; another user and the seller see none; an admin sees it", buyer.rows[0].c === 1 && other.rows[0].c === 0 && seller.rows[0].c === 0 && admin.rows[0].c === 1, [buyer.rows, other.rows, seller.rows, admin.rows]);
  const w = await as("authenticated", U.buyer, null, `update public.refunds set status='processed'`);
  const w2 = await as("authenticated", U.buyer, null, `insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise) values ($1,'x',1)`, [p.pid]);
  check("E81 authenticated users cannot write refunds", w.err !== null && w2.err !== null);
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  for (const [label, r] of [["null purchase", [null, "hold"]], ["bad action", [p.pid, "refund"]], ["null action", [p.pid, null]]]) check(`E90 claim_dispute_action rejects ${label} (CM072)`, code(await claimR(...r)) === "CM072");
  for (const [label, args] of [["bad action", [p.pid, "nuke", true, null, null, null, null]], ["null ok", [p.pid, "hold", null, null, null, null, null]], ["failure without retryable", [p.pid, "hold", false, null, "x", null, null]], ["bad hold time", [p.pid, "release", true, null, null, true, -5]]]) {
    check(`E91 finish_dispute_action rejects ${label} (CM072)`, code(await svc(`select public.finish_dispute_action($1,$2,$3,$4,$5,$6,$7)`, args)) === "CM072");
  }
  check("E92 finish on a purchase with no transfer is 'ignored'", (await finish("00000000-0000-0000-0000-00000000dead", "hold", true)).outcome === "ignored");
  check("E93 plan_refund(null) is CM072", code(await svc(`select public.plan_refund(null)`)) === "CM072");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await setRefundsFlag(true); await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [p.pid]); await planRefund(p.pid);
  await q(`insert into public.webhook_events (provider, provider_event_id, event_type, status, payload_sha256) values ('razorpay','evt_ref_1','refund.processed','received',repeat('a',64))`);
  await applyRefund({ rf: "rfnd_BookKeep0001", pid: p.pid, status: "processed", amount: 49900, pay: p.pay, event: "evt_ref_1" });
  const ev = (await q(`select status, outcome from public.webhook_events where provider_event_id='evt_ref_1'`)).rows[0];
  check("E94 apply_refund_event finishes its webhook event row (processed / refund_applied)", ev.status === "processed" && ev.outcome === "refund_applied", ev);
  await q(`insert into public.webhook_events (provider, provider_event_id, event_type, status, payload_sha256) values ('razorpay','evt_ref_2','refund.processed','received',repeat('b',64))`);
  await applyRefund({ rf: "rfnd_Nobody00002", status: "processed", event: "evt_ref_2" });
  check("E95 an unknown refund marks its event needs_review", (await val(`select status as v from public.webhook_events where provider_event_id='evt_ref_2'`)) === "needs_review");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await claim(p.pid, "hold"); await finish(p.pid, "hold", true);
  check("E96 REGRESSION: the 5.2 state machine still works after the migration (event on the held transfer applies)", (await out({ trf: p.trf, pid: p.pid, status: "processed", settle: "on_hold", hold: true, at: T0 + 100 })) === "applied" && (await row(p.pid)).hold_until === null);
});

await inTxn(async () => {
  // a processed refund must never be offered again, however old its claim is
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [p.pid]);
  await setRefundsFlag(true); await planRefund(p.pid);
  await applyRefund({ rf: "rfnd_OldClaim0001", pid: p.pid, status: "processed", amount: 49900, pay: p.pay, at: T0 });
  await q(`update public.refunds set last_attempt_at = now() - interval '1 day' where purchase_id=$1`, [p.pid]);
  check("E97 a PROCESSED refund is not offered again even when its claim is a day old", (await needed(p.pid)) === null && (await planRefund(p.pid)).outcome === "not_needed");
  const q2 = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [q2.pid]);
  await planRefund(q2.pid);
  await refundFail(q2.pid, "x", false);
  await q(`update public.refunds set last_attempt_at = now() - interval '1 day' where purchase_id=$1`, [q2.pid]);
  check("E98 a FAILED refund is not offered again either", (await needed(q2.pid)) === null);
});
await inTxn(async () => {
  // an older event cannot override a newer one, even when it is "ahead" in rank
  const p = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await q(`update public.transfers set status='failed', error='x' where purchase_id=$1`, [p.pid]);
  await setRefundsFlag(true); await planRefund(p.pid);
  await applyRefund({ rf: "rfnd_Ordering0001", pid: p.pid, status: "pending", amount: 49900, pay: p.pay, at: T0 + 10 });
  check("E99 an OLDER refund event (even with a higher status) is stale", (await rout({ rf: "rfnd_Ordering0001", status: "processed", at: T0 + 5 })) === "stale" && (await refundRow(p.pid)).status === "pending");
});
await inTxn(async () => {
  const p = await mkLinked({ dispute: "open" });
  await apply({ trf: p.trf, pid: p.pid, status: "processed", settle: "on_hold", hold: true, rev: 0, at: T0 + 1 });
  await claim(p.pid, "hold"); await finish(p.pid, "hold", true);
  check("E100 processed + indefinitely held maps to purchases 'held'", (await ptype(p.pid)).transfer_status === "held");
  await q(`update public.disputes set status='resolved_denied' where purchase_id=$1`, [p.pid]);
  await q(`update public.purchases set purchased_at = now() - interval '3 days' where id=$1`, [p.pid]);
  const c = await claim(p.pid, "release");
  await finish(p.pid, "release", true, null, null, c.on_hold, c.hold_until_epoch);
  check("E101 after a release the purchases mapping is refreshed (processed + not on hold -> 'released')", c.on_hold === false && (await ptype(p.pid)).transfer_status === "released", await ptype(p.pid));
});
await inTxn(async () => {
  const a = await mkLinked({ dispute: "open" });
  const b = await mkLinked({ dispute: "resolved_refunded", refunded: true });
  await q(`update public.disputes set created_at = now() - interval '1 hour' where purchase_id=$1`, [b.pid]);   // b is OLDER
  const one = (await svc(`select public.list_dispute_work(1) as v`)).rows[0].v;
  check("E102 with a tight limit the PROTECTIVE action (hold) wins over an older reversal", one.length === 1 && one[0].kind === "hold" && one[0].purchase_id === a.pid, one);
});

console.log(`\nA52c-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
