// A53b-D -- Milestone 5.3 part 2 database tests: the seller-scoped payout status (migration 20261016100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m53b-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000eee${n}`;
const U = { seller: id(81), buyer: id(82), other: id(83) };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() { for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `b53-${uid.slice(-2)}@example.invalid`]); }
async function as(role, uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const status = async (uid = U.seller, limit = 100) => { const r = await as("authenticated", uid, `select public.seller_payout_status($1) as v`, [limit]); if (r.err) throw r.err; return r.rows[0].v; };
let seq = 0;
async function mk({ seller = U.seller, amount = 500, fee = 90, pstatus = "paid", pay, transfer = null, dispute = null, ago = "0 minutes" } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('B53 listing','n','n',$1,'S',$2,'live') returning id`, [amount, seller]);
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,$3,$4,$5,$6, now() - $7::interval) returning id`,
    [U.buyer, l.id, amount, pstatus, pay === undefined ? `pay_B${++seq}` : pay, fee, ago]);
  if (transfer) {
    const t = { status: "created", settle: "on_hold", on_hold: true, hold: "now() + interval '30 hours'", reversed: 0, review: null, error: null, ...transfer };
    await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, razorpay_transfer_id, amount_paise, platform_fee_paise, amount_reversed_paise, status, settlement_status, on_hold, hold_until, review_reason, error)
             values ($1,$2,'acc_SecretAcct001','pay_x',$3,$4,$5,$6,$7,$8,$9,${t.hold},$10,$11)`,
      [p.id, seller, ["creating", "failed"].includes(t.status) ? null : `trf_Secret${String(++seq).padStart(8, "0")}`, Math.round(amount * 100) - Math.round(fee * 100), Math.round(fee * 100), t.reversed, t.status, t.settle, t.on_hold, t.review, t.error]);
  }
  if (dispute) await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status, resolution_note) values ($1,$2,$3,$4,'SECRET-DISPUTE-REASON',$5,'SECRET-NOTE')`, [p.id, l.id, U.buyer, seller, dispute]);
  return p.id;
}
const account = async (st, uid = U.seller) => { await mkUsers(); return q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,'acc_SecretAcct001',$2) on conflict (user_id) do update set status = excluded.status`, [uid, st]); };
const st = (v, pid) => v.items.find((i) => i.purchase_id === pid)?.status;

// ---- A: security
await inTxn(async () => {
  await mkUsers();
  check("A01 anon denied", (await as("anon", null, `select public.seller_payout_status(10)`)).err?.code === "42501");
  check("A02 service_role (no uid) denied", (await as("service_role", null, `select public.seller_payout_status(10)`)).err?.code === "42501");
  check("A03 a logged-in user with no sales gets an empty, well-formed answer", (await status(U.other)).items.length === 0 && (await status(U.other)).account_status === "none");
  check("A04 limit validation -> CM074", (await as("authenticated", U.seller, `select public.seller_payout_status(0)`)).err?.code === "CM074" && (await as("authenticated", U.seller, `select public.seller_payout_status(501)`)).err?.code === "CM074" && (await as("authenticated", U.seller, `select public.seller_payout_status(null)`)).err?.code === "CM074");
  check("A05 has no seller-id parameter (identity is auth.uid() only)", (await q(`select pronargs as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='seller_payout_status'`)).rows[0].v === 1);
  const r = (await q(`select prosecdef, proconfig, provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='seller_payout_status'`)).rows[0];
  check("A06 SECURITY DEFINER, empty search_path, STABLE", r.prosecdef && r.proconfig?.some((c) => c.replace(/\s|"/g, "") === "search_path=") && r.provolatile === "s");
});

// ---- B: isolation
await inTxn(async () => {
  const mine = await mk({ transfer: {} });
  const theirs = await mk({ seller: U.other, transfer: {} });
  const v = await status(U.seller), o = await status(U.other);
  check("B01 a seller sees only their own sales", v.items.length === 1 && v.items[0].purchase_id === mine);
  check("B02 another seller sees only theirs", o.items.length === 1 && o.items[0].purchase_id === theirs);
  check("B03 the buyer (not a seller) sees nothing", (await status(U.buyer)).items.length === 0);
  check("B04 summary covers only the caller's sales", v.summary.held_paise === 41000 && o.summary.held_paise === 41000);
});

// ---- C: status mapping
await inTxn(async () => {
  await mkUsers();
  const none = await mk({});
  check("C01 no account, no transfer -> needs_account", st(await status(), none) === "needs_account");
  await account("pending");
  check("C02 pending account -> account_pending", st(await status(), none) === "account_pending");
  await account("suspended");
  check("C03 suspended account -> under_review", st(await status(), none) === "under_review");
  await account("active");
  check("C04 active account, no transfer -> queued", st(await status(), none) === "queued");
  const held = await mk({ transfer: {} });
  const rel = await mk({ transfer: { on_hold: false, settle: "pending", hold: "now() - interval '1 hour'" } });
  const expired = await mk({ transfer: { hold: "now() - interval '1 minute'" } });
  const paid = await mk({ transfer: { status: "processed", settle: "settled", on_hold: false, hold: "now() - interval '3 days'" } });
  const rev = await mk({ transfer: { status: "reversed", reversed: 41000 } });
  const refunded = await mk({ pstatus: "refunded" });
  const parked = await mk({ transfer: { review: "internal reason" } });
  const failed = await mk({ transfer: { status: "failed", settle: null, error: "internal error" } });
  const creating = await mk({ transfer: { status: "creating", settle: null } });
  const disp = await mk({ transfer: { on_hold: true, hold: "null" }, dispute: "open" });
  const denied = await mk({ transfer: { on_hold: true, hold: "null" }, dispute: "resolved_denied" });
  const dispRefunded = await mk({ pstatus: "refunded", transfer: { status: "reversed", reversed: 41000 }, dispute: "resolved_refunded" });
  const v = await status();
  check("C10 inside the window -> held with a release date", st(v, held) === "held" && v.items.find((i) => i.purchase_id === held).release_date !== null);
  check("C11 hold ended, not settled -> releasing", st(v, rel) === "releasing");
  check("C12 hold_until passed but still flagged on_hold -> releasing", st(v, expired) === "releasing");
  check("C13 settled -> paid", st(v, paid) === "paid");
  check("C14 reversed transfer -> reversed", st(v, rev) === "reversed");
  check("C15 refunded purchase -> reversed (even with no transfer)", st(v, refunded) === "reversed");
  check("C16 parked -> under_review", st(v, parked) === "under_review");
  check("C17 failed -> processing (never 'failed')", st(v, failed) === "processing");
  check("C18 creating -> processing", st(v, creating) === "processing");
  check("C19 open dispute -> dispute", st(v, disp) === "dispute");
  check("C20 dispute denied, hold not yet lifted -> processing", st(v, denied) === "processing");
  check("C21 refunded dispute -> reversed", st(v, dispRefunded) === "reversed");
  check("C22 only 'held' carries a release date", v.items.every((i) => (i.status === "held") === (i.release_date !== null)));
  check("C23 every status is one of the known codes", v.items.every((i) => ["needs_account", "account_pending", "queued", "processing", "held", "dispute", "releasing", "paid", "reversed", "under_review"].includes(i.status)));
  check("C24 parked beats a settled/other state only when not reversed or disputed", st(v, parked) === "under_review" && st(v, disp) === "dispute");
});

// ---- D: amounts
await inTxn(async () => {
  await account("active");
  await mk({ transfer: {} });                                                                               // held 41000
  await mk({ transfer: { status: "processed", settle: "settled", on_hold: false, hold: "now() - interval '3 days'" } }); // paid 41000
  await mk({ transfer: { status: "partially_reversed", settle: "settled", on_hold: false, reversed: 10000, hold: "now() - interval '3 days'" } }); // paid 31000
  await mk({ pstatus: "refunded" });                                                                        // reversed 41000
  await mk({ transfer: { on_hold: true, hold: "null" }, dispute: "open" });                                  // held (dispute) 41000
  await mk({ pay: null });                                                                                  // legacy sale with no payment id: not listed
  await mk({});                                                                                             // queued 41000
  const v = await status();
  check("D01 held = held + dispute", v.summary.held_paise === 82000, v.summary);
  check("D02 paid is net of partial reversals", v.summary.paid_paise === 72000);
  check("D03 reversed", v.summary.reversed_paise === 41000);
  check("D04 queued counts as on its way", v.summary.releasing_paise === 41000);
  check("D05 nothing waiting when the account is active", v.summary.waiting_paise === 0);
  check("D06 legacy sale without a payment id is not listed", v.items.length === 6);
  check("D07 share is amount minus platform fee, in integer paise", v.items.every((i) => Number.isInteger(i.share_paise) && i.share_paise === 41000));
  check("D08 limit caps items, not the summary", (await status(U.seller, 2)).items.length === 2 && (await status(U.seller, 2)).summary.held_paise === 82000);
  check("D09 newest first", v.items.every((i, n) => n === 0 || v.items[n - 1].purchased_at >= i.purchased_at));
});
await inTxn(async () => {
  await mk({}); await mk({});
  const v = await status();
  check("D10 no account: waiting = both sales", v.summary.waiting_paise === 82000 && v.account_status === "none");
  await account("pending");
  check("D11 pending account: still waiting", (await status()).summary.waiting_paise === 82000);
  await account("suspended");
  check("D12 suspended account: still waiting, and not counted as on its way", (await status()).summary.waiting_paise === 82000 && (await status()).summary.releasing_paise === 0);
});
await inTxn(async () => {
  await account("active");
  const old = await mk({ ago: "3 days", transfer: {} });
  const mid = await mk({ ago: "2 days", transfer: {} });
  const fresh = await mk({ ago: "1 minute", transfer: {} });
  const v = await status();
  check("D13 items are ordered newest sale first", v.items.map((i) => i.purchase_id).join() === [fresh, mid, old].join());
  check("D14 with limit 1 the NEWEST sale is the one returned", (await status(U.seller, 1)).items[0].purchase_id === fresh);
});

// ---- E: no leaks
await inTxn(async () => {
  await account("active");
  await mk({ transfer: { review: "SECRET-REVIEW-REASON", error: "SECRET-ERROR" }, dispute: "open" });
  await mk({ transfer: { status: "failed", settle: null, error: "SECRET-ERROR-2" } });
  await mk({ transfer: { review: "SECRET-REVIEW-REASON-2" } });
  await mk({ transfer: { status: "processed", settle: "settled", on_hold: false, hold: "now() - interval '3 days'" } });
  const raw = JSON.stringify(await status());
  for (const bad of ["acc_", "trf_", "pay_", "rfnd_", "SECRET", "razorpay", "review_reason", "error", "reason", "note", "attempts", "buyer", "b53-"]) {
    check(`E01 the response never contains "${bad}"`, !raw.toLowerCase().includes(bad.toLowerCase()), bad);
  }
  const keys = new Set((await status()).items.flatMap((i) => Object.keys(i)));
  check("E02 item keys are exactly the allow-list", [...keys].every((k) => ["purchase_id", "listing_title", "purchased_at", "status", "share_paise", "reversed_paise", "release_date"].includes(k)), [...keys]);
});

// ---- F: read-only
await inTxn(async () => {
  await account("active");
  await mk({ transfer: { review: "x" } });
  const snap = async () => JSON.stringify((await q(`select (select count(*) from public.transfers) a, (select md5(string_agg(t::text,'|' order by id)) from public.transfers t) b, (select count(*) from public.audit_log) c, (select count(*) from public.purchases) d`)).rows[0]);
  const before = await snap();
  await status();
  check("F01 calling it changes nothing", before === (await snap()));
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
