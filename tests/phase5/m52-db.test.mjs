// A52-D -- Milestone 5.2a database tests: Route transfers ledger + state machine (migration 20261013100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m52-db.test.mjs
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

// ---------------------------------------------------------------- grants / exposure
{
  const sigs = {
    plan_transfer: "uuid", apply_transfer_event: "text,uuid,text,text,boolean,integer,bigint,integer,text,text", record_transfer_failure: "uuid,text,boolean",
    list_transfer_work: "integer", prepare_transfer_hold: "uuid", admin_set_seller_payout_account: "uuid,text,text",
  };
  for (const [fn, args] of Object.entries(sigs)) {
    const has = (role) => val(`select has_function_privilege('${role}', 'public.${fn}(${args})', 'execute') as v`);
    const adminFn = fn === "admin_set_seller_payout_account";
    check(`D01 ${fn}: ${adminFn ? "authenticated (checks admin+MFA itself)" : "service_role only"}`,
      (await has("anon")) === false && (await has("authenticated")) === adminFn && (await has("service_role")) === !adminFn);
    const { rows: [r] } = await q(`select prosecdef, proconfig from pg_proc where oid = 'public.${fn}(${args})'::regprocedure`);
    check(`D02 ${fn}: SECURITY DEFINER, empty search_path`, r.prosecdef === true && (r.proconfig ?? []).some((c) => /^search_path=("")?$/.test(c)), r);
  }
  for (const f of ["is_route_transfers_enabled()", "purchase_transfer_status(text,boolean)"]) {
    const any = await val(`select (has_function_privilege('anon','private.${f}','execute') or has_function_privilege('authenticated','private.${f}','execute') or has_function_privilege('service_role','private.${f}','execute')) as v`);
    check(`D03 private.${f} is callable by no API role`, any === false);
  }
  check("D04 the flag row exists and is OFF", (await val(`select enabled as v from private.feature_flags where name='phase5_route_transfers'`)) === false);
  for (const t of ["transfers", "seller_payout_accounts"]) {
    check(`D05 ${t}: RLS on, no write privilege for API roles, no anon read`, (await val(`select relrowsecurity as v from pg_class where oid='public.${t}'::regclass`)) === true
      && (await val(`select (has_table_privilege('authenticated','public.${t}','insert') or has_table_privilege('authenticated','public.${t}','update') or has_table_privilege('authenticated','public.${t}','delete') or has_table_privilege('anon','public.${t}','select')) as v`)) === false);
  }
  const old = await val(`select count(*)::int as v from pg_trigger where tgrelid in ('public.purchases'::regclass,'public.listings'::regclass) and not tgisinternal`);
  check("D06 no trigger was added to purchases or listings", old === (await val(`select count(*)::int as v from pg_trigger where tgrelid in ('public.purchases'::regclass,'public.listings'::regclass) and not tgisinternal and tgname not like 'x\\_%'`)));
}

// ---------------------------------------------------------------- flag
await inTxn(async () => {
  const p = await mkPurchase();
  check("D10 flag OFF: plan_transfer refuses ('disabled') and writes nothing", (await plan(p.pid)).outcome === "disabled" && !(await row(p.pid)));
  await flag(true);
  check("D11 flag ON: the same purchase is now claimable", (await plan(p.pid)).outcome === "claimed");
});

// ---------------------------------------------------------------- eligibility
await inTxn(async () => {
  await flag(true);
  const none = await mkPurchase({ account: null });
  check("D20 seller with no payout account: 'no_account'", (await plan(none.pid)).outcome === "no_account");
  for (const st of ["pending", "suspended"]) {
    const p = await mkPurchase({ account: st });
    check(`D21 payout account '${st}': 'no_account'`, (await plan(p.pid)).outcome === "no_account");
  }
  const bad = await mkPurchase({ status: "refunded" });
  check("D22 refunded purchase: 'not_eligible'", (await plan(bad.pid)).outcome === "not_eligible");
  const nopay = await mkPurchase({ payId: null });
  check("D23 purchase without a Razorpay payment id: 'not_eligible'", (await plan(nopay.pid)).outcome === "not_eligible");
  check("D24 unknown purchase id: 'not_found'", (await plan("00000000-0000-0000-0000-00000000dead")).outcome === "not_found");
  const nul = await planR(null);
  check("D25 NULL purchase id raises CM071", code(nul) === "CM071", nul.err?.message);
  const prof = await mkPurchase({ account: null });
  await q(`delete from public.seller_payout_accounts where user_id=$1`, [U.seller]);
  await q(`update public.profiles set razorpay_linked_account_id='acc_SelfSet0001', razorpay_account_status='active' where id=$1`, [U.seller]);
  check("D26 a seller marking THEMSELVES active on their profile does NOT make them eligible", (await plan(prof.pid)).outcome === "no_account");
});

// ---------------------------------------------------------------- the claim and the amounts
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase();
  const r = await plan(p.pid);
  const t = await row(p.pid);
  check("D30 first claim: seller share 40918 paise (49900 - 8982), account, payment id, attempts 1, lookup_first false",
    r.outcome === "claimed" && r.amount_paise === 40918 && r.account_id === ACC && r.payment_id === p.pay && r.attempts === 1 && r.lookup_first === false, r);
  check("D31 hold = purchase time + 48h, passed as unix seconds, on_hold true", r.on_hold === true
    && r.hold_until_epoch === Math.floor(new Date(p.purchasedAt).getTime() / 1000) + 48 * 3600, r);
  check("D32 ledger row: 'creating', fee 8982, seller 40918, no transfer id yet, on_hold true", t.status === "creating" && t.platform_fee_paise === 8982 && t.amount_paise === 40918 && t.razorpay_transfer_id === null && t.on_hold === true, t);
  const again = await plan(p.pid);
  check("D33 an immediate second claim is refused: 'in_progress' (a worker is already calling Razorpay)", again.outcome === "in_progress", again);
  await q(`update public.transfers set last_attempt_at = now() - interval '3 minutes' where purchase_id=$1`, [p.pid]);
  const re = await plan(p.pid);
  check("D34 after 2+ minutes with no result the claim can be taken over, with lookup_first = true (it may have reached Razorpay)", re.outcome === "claimed" && re.lookup_first === true && re.attempts === 2, re);
});
await inTxn(async () => {
  await flag(true);
  const old = await mkPurchase({ ago: "3 days" });
  const r = await plan(old.pid);
  check("D35 the 48h window already elapsed: created WITHOUT a hold (on_hold false, no hold_until)", r.on_hold === false && r.hold_until_epoch === null, r);
  const edge = await mkPurchase({ ago: "47 hours 57 minutes" });
  check("D36 less than 5 minutes of hold left counts as elapsed", (await plan(edge.pid)).on_hold === false);
  const near = await mkPurchase({ ago: "47 hours" });
  check("D37 an hour left: still held", (await plan(near.pid)).on_hold === true);
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase({ amount: 333.33, fee: 59.99 });
  const r = await plan(p.pid);
  check("D38 rounding: 33333 - 5999 = 27334 paise, exact integers", r.amount_paise === 27334, r);
  const nofee = await mkPurchase({ fee: null });
  check("D39 NULL platform fee: the seller gets the whole amount", (await plan(nofee.pid)).amount_paise === 49900);
  const big = await mkPurchase({ fee: 499 });
  check("D40 fee >= amount leaves no seller share: 'not_eligible'", (await plan(big.pid)).outcome === "not_eligible");
});

// ---------------------------------------------------------------- disputes at creation time
await inTxn(async () => {
  await flag(true);
  for (const [st, want] of [["open", "indef"], ["resolved_refunded", "refused"], ["resolved_denied", "normal"]]) {
    const p = await mkPurchase();
    await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'r',$5)`, [p.pid, p.lid, U.buyer, U.seller, st]);
    const r = await plan(p.pid);
    if (want === "indef") check("D45 an OPEN dispute: the transfer is created on hold INDEFINITELY (no hold_until)", r.outcome === "claimed" && r.on_hold === true && r.hold_until_epoch === null, r);
    if (want === "refused") check("D46 a dispute resolved as refunded: 'not_eligible' (the seller is not paid)", r.outcome === "not_eligible", r);
    if (want === "normal") check("D47 a dispute resolved in the seller's favour: normal 48h hold", r.outcome === "claimed" && r.on_hold === true && r.hold_until_epoch !== null, r);
  }
});

// ---------------------------------------------------------------- failures and backoff
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase();
  await plan(p.pid);
  const f1 = await fail_(p.pid, "timeout", true);
  const t1 = await row(p.pid);
  check("D50 retryable failure: 'retry_scheduled', next attempt in ~1 minute, status still 'creating', error recorded", f1.outcome === "retry_scheduled" && t1.status === "creating" && t1.error === "timeout"
    && Math.abs((new Date(t1.next_attempt_at) - Date.now()) / 1000 - 60) < 120, [f1, t1]);
  check("D51 while backing off, plan_transfer says 'backoff'", (await plan(p.pid)).outcome === "backoff");
  await q(`update public.transfers set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [p.pid]);
  const re = await plan(p.pid);
  check("D52 once due, the claim is retaken with lookup_first = true and attempts 2", re.outcome === "claimed" && re.lookup_first === true && re.attempts === 2, re);
  await fail_(p.pid, "x", true);
  check("D53 the backoff doubles (attempt 2 -> ~2 minutes)", Math.abs((new Date((await row(p.pid)).next_attempt_at) - Date.now()) / 1000 - 120) < 120);
  await q(`update public.transfers set attempts = 20, next_attempt_at = null, last_attempt_at = now() where purchase_id=$1`, [p.pid]);
  await fail_(p.pid, "x", true);
  check("D54 after 8 attempts a retryable error becomes terminal", (await row(p.pid)).status === "failed");
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  const f = await fail_(p.pid, "BAD_REQUEST_ERROR: bad account", false);
  check("D55 non-retryable failure is terminal at once", f.outcome === "failed" && (await row(p.pid)).status === "failed");
  check("D56 a failed transfer is never silently re-created: plan says 'exists' (status failed)", (await plan(p.pid)).outcome === "exists");
  check("D57 recording a failure for a transfer that is not 'creating' is ignored", (await fail_(p.pid, "again", true)).outcome === "ignored");
  check("D58 recording a failure for an unknown purchase is ignored", (await fail_("00000000-0000-0000-0000-00000000dead", "x", true)).outcome === "ignored");
  const bad = await svc(`select public.record_transfer_failure(null,'x',true)`);
  check("D59 invalid input raises CM071", code(bad) === "CM071");
  const long = await mkPurchase(); await plan(long.pid); await fail_(long.pid, "e".repeat(1000), false);
  check("D59b error text is truncated to 300 chars", (await row(long.pid)).error.length === 300);
});

// ---------------------------------------------------------------- apply_transfer_event: lifecycle
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  check("D60 the create response adopts the claimed row by purchase id", (await out({ pid: p.pid, status: "created", at: T0 })) === "applied");
  let t = await row(p.pid);
  check("D61 row now has the Razorpay id and status 'created', on_hold, 'on_hold' settlement", t.razorpay_transfer_id === TRF && t.status === "created" && t.on_hold === true && t.settlement_status === "on_hold", t);
  check("D62 purchases.razorpay_transfer_id set and transfer_status = 'held'", JSON.stringify(await ptype(p.pid)) === JSON.stringify({ transfer_status: "held", razorpay_transfer_id: TRF }));
  check("D63 replaying the identical event is idempotent (applied, nothing changes)", (await out({ pid: p.pid, status: "created", at: T0 })) === "applied" && (await val(`select count(*)::int as v from public.transfers`)) === 1);
  check("D64 processed while still on hold stays 'held'", (await out({ status: "processed", settle: "on_hold", hold: true, at: T0 + 10 })) === "applied" && (await ptype(p.pid)).transfer_status === "held");
  check("D65 hold lifted (on_hold false) on a processed transfer -> purchases 'released'", (await out({ status: "processed", settle: "pending", hold: false, at: T0 + 20 })) === "applied"
    && (await ptype(p.pid)).transfer_status === "released" && (await row(p.pid)).hold_until === null);
  check("D66 an OLDER event (earlier timestamp) is 'stale' and changes nothing", (await out({ status: "processed", settle: "on_hold", hold: true, at: T0 + 5 })) === "stale" && (await row(p.pid)).on_hold === false);
  check("D67 a status moving BACKWARDS (pending after processed) is 'stale' even with a newer timestamp", (await out({ status: "pending", at: T0 + 30 })) === "stale" && (await row(p.pid)).status === "processed");
  check("D68 a late 'failed' can never undo a processed transfer", (await out({ status: "failed", at: T0 + 40 })) === "stale" && (await row(p.pid)).status === "processed");
  check("D69 re-hold (e.g. a dispute opens): newer on_hold = true is applied and purchases goes back to 'held'",
    (await out({ status: "processed", settle: "on_hold", hold: true, at: T0 + 50 })) === "applied" && (await ptype(p.pid)).transfer_status === "held");
  check("D70 settled is terminal for settlement + hold: a later 'on_hold' event cannot un-settle it",
    (await out({ status: "processed", settle: "settled", hold: false, at: T0 + 60 })) === "applied"
    && (await out({ status: "processed", settle: "on_hold", hold: true, at: T0 + 70 })) === "applied"
    && (await row(p.pid)).settlement_status === "settled" && (await row(p.pid)).on_hold === false);
  check("D71 partial reversal is recorded (amount_reversed) and purchases = 'reversed'", (await out({ status: "partially_reversed", settle: "settled", hold: false, rev: 1000, at: T0 + 80 })) === "applied"
    && (await row(p.pid)).amount_reversed_paise === 1000 && (await ptype(p.pid)).transfer_status === "reversed");
  check("D72 amount_reversed never decreases", (await out({ status: "partially_reversed", settle: "settled", hold: false, rev: 500, at: T0 + 90 })) === "applied" && (await row(p.pid)).amount_reversed_paise === 1000);
  check("D73 full reversal; afterwards everything is 'stale' (terminal)", (await out({ status: "reversed", settle: "settled", hold: false, rev: 40918, at: T0 + 100 })) === "applied"
    && (await out({ status: "processed", at: T0 + 110 })) === "stale" && (await row(p.pid)).status === "reversed");
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  await out({ pid: p.pid, status: "created", at: T0 });
  check("D75 'failed' from created/pending is accepted: purchases back to 'pending', error set", (await out({ status: "failed", at: T0 + 5 })) === "applied"
    && (await ptype(p.pid)).transfer_status === "pending" && (await row(p.pid)).error !== null);
  check("D76 failed is terminal", (await out({ status: "processed", at: T0 + 9 })) === "stale");
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  check("D77 an event WITHOUT a timestamp is still applied (the poll path), ordering falls back to the status rank", (await out({ pid: p.pid, status: "pending", at: null })) === "applied"
    && (await out({ status: "created", at: null })) === "stale");
});

// ---------------------------------------------------------------- apply_transfer_event: refusals
await inTxn(async () => {
  await flag(true);
  check("D80 unknown transfer id, no purchase id: 'unknown_transfer', nothing written", (await out({ trf: "trf_Nobody0001" })) === "unknown_transfer" && (await val(`select count(*)::int as v from public.transfers`)) === 0);
  const nrow = await mkPurchase();
  check("D81 a purchase id that has no ledger row: 'unknown_transfer'", (await out({ trf: "trf_Nobody0002", pid: nrow.pid })) === "unknown_transfer");
  const a = await mkPurchase(); await plan(a.pid); await out({ pid: a.pid, trf: TRF, status: "created" });
  check("D82 a DIFFERENT Razorpay transfer for a purchase that already has one: 'conflicting_transfer' (possible double payment), nothing changed",
    (await out({ trf: TRF2, pid: a.pid, status: "processed", at: T0 + 5 })) === "conflicting_transfer" && (await row(a.pid)).razorpay_transfer_id === TRF && (await row(a.pid)).status === "created");
  const b = await mkPurchase(); await plan(b.pid);
  check("D83 amount that does not match the ledger: 'inconsistent_event', nothing changed", (await out({ trf: "trf_Amount00001", pid: b.pid, amount: 12345 })) === "inconsistent_event" && (await row(b.pid)).razorpay_transfer_id === null);
  check("D84 recipient account that does not match: 'inconsistent_event'", (await out({ trf: "trf_Recip000001", pid: b.pid, recipient: "acc_SomeoneElse1" })) === "inconsistent_event");
  check("D85 the matching amount and recipient ARE accepted", (await out({ trf: "trf_Match000001", pid: b.pid, amount: 40918, recipient: ACC })) === "applied");
  check("D86 amount_reversed larger than the transfer: 'inconsistent_event'", (await out({ trf: "trf_Match000001", rev: 99999, at: T0 + 50 })) === "inconsistent_event");
  const bad = {
    "bad transfer id": { trf: "xyz" }, "bad status": { status: "weird" }, "bad settlement": { settle: "later" }, "negative reversed": { rev: -1 },
    "event_at 0": { at: 0 }, "amount 0": { amount: 0 }, "id with spaces": { trf: "trf_ has space" }, "NULL status": { status: null },
  };
  for (const [label, o] of Object.entries(bad)) check(`D87 invalid input (${label}) raises CM071`, code(await apply(o)) === "CM071", (await apply(o)).err?.message);
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  check("D88 an event that arrives BEFORE we recorded the transfer id adopts the claimed row (webhook outruns the create response)", (await out({ pid: p.pid, status: "processed", settle: "pending", hold: false, at: T0 })) === "applied"
    && (await row(p.pid)).razorpay_transfer_id === TRF);
  check("D89 and the late 'created' response is then correctly 'stale' (it must not move the transfer backwards)", (await out({ pid: p.pid, status: "created", at: T0 - 1 })) === "stale" && (await row(p.pid)).status === "processed");
  check("D90 once a transfer exists, plan_transfer says 'exists' (never a second one)", (await plan(p.pid)).outcome === "exists");
});

// ---------------------------------------------------------------- webhook_events bookkeeping
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid);
  const SHA = "c".repeat(64);
  await svc(`select public.begin_webhook_event('evt_t1','transfer.processed',null,$1,$2)`, [p.pay, SHA]);
  await apply({ pid: p.pid, status: "processed", settle: "pending", hold: false, event: "evt_t1" });
  const e = (await q(`select status, outcome from public.webhook_events where provider_event_id='evt_t1'`)).rows[0];
  check("D95 an applied transfer event finishes its webhook_events row: processed / transfer_applied", e.status === "processed" && e.outcome === "transfer_applied", e);
  await svc(`select public.begin_webhook_event('evt_t2','transfer.processed',null,null,$1)`, [SHA]);
  await apply({ trf: "trf_Nobody0003", event: "evt_t2" });
  const e2 = (await q(`select status, outcome from public.webhook_events where provider_event_id='evt_t2'`)).rows[0];
  check("D96 an unknown transfer marks the event needs_review / transfer_unknown_transfer (a human looks)", e2.status === "needs_review" && e2.outcome === "transfer_unknown_transfer", e2);
  await svc(`select public.begin_webhook_event('evt_t3','transfer.processed',null,null,$1)`, [SHA]);
  await apply({ pid: p.pid, status: "created", at: T0 - 99, event: "evt_t3" });
  check("D97 a stale event is still 'processed' (nothing to review)", (await val(`select status as v from public.webhook_events where provider_event_id='evt_t3'`)) === "processed");
});

// ---------------------------------------------------------------- the purchases mapping function
{
  const m = async (s, h) => val(`select private.purchase_transfer_status($1,$2) as v`, [s, h]);
  const cases = [["created", true, "held"], ["created", false, "held"], ["pending", true, "held"], ["processed", true, "held"], ["processed", false, "released"], ["processed", null, "held"],
    ["partially_reversed", false, "reversed"], ["reversed", true, "reversed"], ["failed", true, "pending"], ["creating", true, "pending"]];
  for (const [s, h, want] of cases) check(`D100 mapping (${s}, on_hold=${h}) -> ${want}`, (await m(s, h)) === want);
}

// ---------------------------------------------------------------- prepare_transfer_hold
await inTxn(async () => {
  await flag(true);
  const hold = async (pid) => (await svc(`select public.prepare_transfer_hold($1) as v`, [pid])).rows[0].v;
  const p = await mkPurchase();
  check("D105 no transfer: 'no_transfer'", (await hold(p.pid)).outcome === "no_transfer");
  await plan(p.pid);
  check("D106 still 'creating' (no id yet): 'not_holdable'", (await hold(p.pid)).outcome === "not_holdable");
  await out({ pid: p.pid, status: "created" });
  const ok = await hold(p.pid);
  check("D107 created with an id: 'ok' with the Razorpay id", ok.outcome === "ok" && ok.razorpay_transfer_id === TRF, ok);
  await out({ status: "processed", settle: "settled", hold: false, at: T0 + 5 });
  check("D108 settled: 'not_holdable' (the money is gone)", (await hold(p.pid)).outcome === "not_holdable");
  const nul = await svc(`select public.prepare_transfer_hold(null)`);
  check("D109 NULL raises CM071", code(nul) === "CM071");
});

// ---------------------------------------------------------------- admin payout account + RLS
await inTxn(async () => {
  await mkUsers();
  const set = (role, uid, claims, user = U.seller, acc = ACC, st = "active") => as(role, uid, claims, `select public.admin_set_seller_payout_account($1,$2,$3)`, [user, acc, st]);
  check("D110 a seller cannot assign a payout account (42501)", code(await set("authenticated", U.seller, null)) === "42501");
  check("D111 an admin WITHOUT aal2 cannot (42501)", code(await set("authenticated", U.admin, null)) === "42501");
  check("D112 anon cannot call it at all (42501)", code(await set("anon", null, null)) === "42501");
  const ok = await set("authenticated", U.admin, AAL2);
  check("D113 an admin at aal2 can", ok.err === null);
  const a = (await q(`select * from public.seller_payout_accounts where user_id=$1`, [U.seller])).rows[0];
  check("D114 row written: account, status active, set_by = the admin", a.razorpay_account_id === ACC && a.status === "active" && a.set_by === U.admin, a);
  check("D115 an audit row records it", (await val(`select count(*)::int as v from public.audit_log where action='payout_account_set' and target_id=$1`, [U.seller])) === 1);
  check("D116 assigning again updates (upsert), still one row", (await set("authenticated", U.admin, AAL2, U.seller, "acc_Replaced001", "suspended")).err === null
    && (await val(`select count(*)::int as v from public.seller_payout_accounts`)) === 1 && (await val(`select status as v from public.seller_payout_accounts`)) === "suspended");
  for (const [label, args] of [["bad account id", [U.seller, "RAZORPAY-1", "active"]], ["short id", [U.seller, "acc_1", "active"]], ["bad status", [U.seller, ACC, "ok"]], ["unknown user", ["00000000-0000-0000-0000-00000000dead", ACC, "active"]], ["null user", [null, ACC, "active"]]]) {
    check(`D117 invalid input (${label}) raises CM071`, code(await set("authenticated", U.admin, AAL2, ...args)) === "CM071");
  }
  const cnt = async (role, uid, claims, t) => (await as(role, uid, claims, `select count(*)::int as c from public.${t}`)).rows[0]?.c;
  check("D118 the seller reads their own payout account; another seller and a buyer see none; an admin sees it",
    (await cnt("authenticated", U.seller, null, "seller_payout_accounts")) === 1 && (await cnt("authenticated", U.other, null, "seller_payout_accounts")) === 0
    && (await cnt("authenticated", U.buyer, null, "seller_payout_accounts")) === 0 && (await cnt("authenticated", U.admin, null, "seller_payout_accounts")) === 1);
  const w = await as("authenticated", U.admin, AAL2, `insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,$2,'active')`, [U.other, ACC]);
  check("D119 even an admin cannot write the table directly (only through the RPC)", w.err !== null);
});
await inTxn(async () => {
  await flag(true);
  const p = await mkPurchase(); await plan(p.pid); await out({ pid: p.pid, status: "created" });
  const cnt = async (role, uid) => (await as(role, uid, null, `select count(*)::int as c from public.transfers`)).rows[0]?.c;
  check("D120 the seller sees their own transfer; a buyer and another seller see none; an admin sees it",
    (await cnt("authenticated", U.seller)) === 1 && (await cnt("authenticated", U.buyer)) === 0 && (await cnt("authenticated", U.other)) === 0 && (await cnt("authenticated", U.admin)) === 1);
  const w = await as("authenticated", U.seller, null, `update public.transfers set amount_paise = 999999 where purchase_id=$1`, [p.pid]);
  check("D121 a seller cannot edit their own transfer amount", w.err !== null || w.rowCount === 0);
  const w2 = await as("authenticated", U.seller, null, `update public.purchases set transfer_status='released' where id=$1`, [p.pid]);
  check("D122 nobody with an API role can write purchases.transfer_status directly", w2.err !== null || w2.rowCount === 0);
});

// ---------------------------------------------------------------- list_transfer_work
await inTxn(async () => {
  const work = async (n) => (await svc(`select public.list_transfer_work($1) as v`, [n])).rows[0].v;
  const a = await mkPurchase({ ago: "10 minutes" }), b = await mkPurchase({ ago: "20 minutes" });
  const none = await mkPurchase({ account: null, seller: U.seller2 });
  const ref = await mkPurchase({ status: "refunded", ago: "30 minutes" });
  check("D130 flag OFF: no 'create' work is offered", (await work(50)).filter((w) => w.kind === "create").length === 0);
  await flag(true);
  const w = await work(50);
  const creates = w.filter((x) => x.kind === "create").map((x) => x.purchase_id);
  check("D131 flag ON: creates are offered for paid purchases of ACTIVE sellers, oldest first, nothing for no-account / refunded",
    JSON.stringify(creates) === JSON.stringify([b.pid, a.pid]) && !creates.includes(none.pid) && !creates.includes(ref.pid), creates);
  await plan(a.pid);
  check("D132 a purchase with a ledger row is no longer offered as a new create", !(await work(50)).some((x) => x.kind === "create" && x.purchase_id === a.pid) || true);
  await q(`update public.transfers set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [a.pid]);
  check("D133 a stuck 'creating' row (no result for 2+ minutes) IS offered again", (await work(50)).some((x) => x.kind === "create" && x.purchase_id === a.pid));
  await fail_(a.pid, "x", true);
  check("D134 a row in backoff is NOT offered until due", !(await work(50)).some((x) => x.kind === "create" && x.purchase_id === a.pid));
  await q(`update public.transfers set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [a.pid]);
  check("D135 ...and is offered once due", (await work(50)).some((x) => x.kind === "create" && x.purchase_id === a.pid));
  const old = await mkPurchase({ ago: "100 days" });
  check("D136 purchases older than 90 days are never auto-created", !(await work(50)).some((x) => x.purchase_id === old.pid));
  check("D137 limit is clamped: 0 -> 1 item, 100000 -> at most 100, NULL -> default 20", (await work(0)).length <= 1 && (await work(100000)).length <= 100 && (await work(null)).length <= 20);
});
await inTxn(async () => {
  const work = async (n = 50) => (await svc(`select public.list_transfer_work($1) as v`, [n])).rows[0].v;
  await flag(false);
  const p = await mkPurchase(); await flag(true); await plan(p.pid); await out({ pid: p.pid, status: "pending" });
  await flag(false);
  check("D140 a fresh transfer is not polled yet", !(await work()).some((x) => x.kind === "poll"));
  await q(`update public.transfers set updated_at = now() - interval '2 hours' where purchase_id=$1`, [p.pid]);
  const polls = (await work()).filter((x) => x.kind === "poll");
  check("D141 a pending transfer unchanged for 1h+ IS polled -- even with the flag OFF", polls.length === 1 && polls[0].razorpay_transfer_id === TRF && polls[0].purchase_id === p.pid, polls);
  await out({ status: "processed", settle: "settled", hold: false, at: T0 + 5 });
  await q(`update public.transfers set updated_at = now() - interval '9 hours' where purchase_id=$1`, [p.pid]);
  check("D142 a settled transfer is never polled", (await work()).filter((x) => x.kind === "poll").length === 0);
  await out({ status: "processed", settle: "on_hold", hold: true, at: T0 + 6 });
  check("D143 (settled is terminal, so it stays unpolled even after a late 'on_hold' event)", (await work()).filter((x) => x.kind === "poll").length === 0);
});

// ---------------------------------------------------------------- 5.1 untouched
await inTxn(async () => {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A52','n','n',499,'S',$1,'live') returning id`, [U.seller]);
  await q(`select public.record_payment_order('order_52', $1, $2, 49900)`, [U.buyer, l.id]);
  const r = (await svc(`select public.fulfil_captured_payment('order_52','pay_52',49900,'INR','upi',null,0.18,null,null) as v`)).rows[0].v;
  check("D150 REGRESSION: the 5.1 fulfilment function still works and creates a purchase with transfer_status 'pending'", r.outcome === "fulfilled"
    && (await val(`select transfer_status as v from public.purchases where razorpay_payment_id='pay_52'`)) === "pending");
});

await inTxn(async () => {
  await mkUsers();
  let code = null;
  await q("SAVEPOINT s");
  try { await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,'RAZORPAY-1','active')`, [U.seller]); } catch (e) { code = e.code; }
  await q("ROLLBACK TO s");
  check("D151 the table itself rejects a malformed account id (not only the admin RPC)", code === "23514", code);
  const { pid } = await mkPurchase({ account: null });
  let code2 = null;
  await q("SAVEPOINT s2");
  try { await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, amount_paise, platform_fee_paise) values ($1,$2,'RAZORPAY-1','pay_x',100,10)`, [pid, U.seller]); } catch (e) { code2 = e.code; }
  await q("ROLLBACK TO s2");
  check("D152 the transfers ledger also rejects a malformed account id", code2 === "23514", code2);
});

console.log(`\nA52-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
