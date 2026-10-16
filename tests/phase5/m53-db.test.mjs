// A53-D -- Milestone 5.3 database tests: admin payout reporting (migration 20261015100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m53-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000ddd${n}`;
const U = { seller: id(71), buyer: id(72), admin: id(74), seller2: id(75), nobody: id(76) };
const AAL2 = { aal: "aal2" };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a53-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const adm = (sql, params) => as("authenticated", U.admin, AAL2, sql, params);
const call = async (fn, ...args) => {
  const r = await adm(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as v`, args);
  if (r.err) throw r.err;
  return r.rows[0].v;
};
let seq = 0;
// a paid purchase (+ optional transfer row inserted directly: reporting is read-only so no flags are needed)
async function mk({ seller = U.seller, amount = 500, fee = 90, transfer = null, ago = "0 minutes", pay } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A53','n','n',$1,'S',$2,'live') returning id`, [amount, seller]);
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee)
     values ($1,$2,$3,'paid',$4,$5) returning id`, [U.buyer, l.id, amount, pay === undefined ? `pay_A${++seq}` : pay, fee]);
  if (transfer) {
    const t = { status: "created", settle: "on_hold", on_hold: true, hold: "now() + interval '48 hours'", reversed: 0, review: null, error: null, updated: "now()", ...transfer };
    const trf = t.status === "creating" || t.status === "failed" ? null : `trf_A53${String(++seq).padStart(8, "0")}`;
    await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, razorpay_transfer_id, amount_paise, platform_fee_paise,
               amount_reversed_paise, status, settlement_status, on_hold, hold_until, review_reason, error, updated_at)
             values ($1,$2,'acc_TestSeller001','pay_x',$3,$4,$5,$6,$7,$8,$9,${t.hold},$10,$11, ${t.updated})`,
      [p.id, seller, trf, Math.round(amount * 100) - Math.round(fee * 100), Math.round(fee * 100), t.reversed, t.status, t.settle, t.on_hold, t.review, t.error]);
  }
  return { pid: p.id, lid: l.id };
}
const kinds = (r) => r.items.map((i) => i.kind);

// ---- A: security -----------------------------------------------------------------------------------------------------
const FNS = [["admin_payment_attention_count"], ["admin_payment_attention", 10], ["admin_transfers_ledger", null, 10, 0], ["admin_purchase_timeline", id(99)], ["admin_disputes_refunds", null, 10, 0], ["admin_seller_balances", 10]];
const argSql = (a) => a.map((_, i) => `$${i + 1}`).join(",");
await inTxn(async () => {
  await mkUsers();
  for (const [fn, ...args] of FNS) {
    const sql = `select public.${fn}(${argSql(args)})`;
    check(`A01 ${fn}: anon denied`, (await as("anon", null, null, sql, args)).err?.code === "42501");
    check(`A02 ${fn}: service_role denied`, (await as("service_role", null, null, sql, args)).err?.code === "42501");
    check(`A03 ${fn}: ordinary user denied`, (await as("authenticated", U.nobody, AAL2, sql, args)).err?.code === "42501");
    check(`A04 ${fn}: admin WITHOUT aal2 denied`, (await as("authenticated", U.admin, { aal: "aal1" }, sql, args)).err?.code === "42501");
    check(`A05 ${fn}: admin with aal2 allowed`, (await as("authenticated", U.admin, AAL2, sql, args)).err === null);
  }
  for (const f of ["private.transfer_bucket(text,text,boolean,text)", "private.payment_attention_rows()"]) {
    check(`A06 ${f}: not executable by authenticated`, (await q(`select has_function_privilege('authenticated','${f}','execute') as v`)).rows[0].v === false);
  }
  const { rows } = await q(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('admin_payment_attention_count','admin_payment_attention','admin_transfers_ledger','admin_purchase_timeline','admin_seller_balances','admin_disputes_refunds')`);
  check("A07 all six are SECURITY DEFINER with empty search_path", rows.length === 6 && rows.every((r) => r.prosecdef && r.proconfig?.some((c) => c.replace(/\s|"/g, "") === "search_path=")));
});

// ---- B: attention list ------------------------------------------------------------------------------------------------
await inTxn(async () => {
  await mkUsers();
  check("B01 empty database: count 0", (await call("admin_payment_attention_count")) === 0);
  const healthy = await mk({ transfer: {} });
  const parked = await mk({ transfer: { review: "transfer already settled when the dispute opened" } });
  const failed = await mk({ transfer: { status: "failed", settle: null, error: "razorpay 400" } });
  const stuck = await mk({ transfer: { status: "creating", settle: null, updated: "now() - interval '20 minutes'" } });
  const fresh = await mk({ transfer: { status: "creating", settle: null } });
  const both = await mk({ transfer: { status: "failed", settle: null, review: "parked and failed", error: "e" } });
  const r = await call("admin_payment_attention", 100);
  const by = (pid) => r.items.filter((i) => i.purchase_id === pid);
  check("B02 healthy held transfer is not listed", by(healthy.pid).length === 0);
  check("B03 parked transfer listed as parked_transfer with its reason", by(parked.pid)[0]?.kind === "parked_transfer" && /settled/.test(by(parked.pid)[0].detail));
  check("B04 failed transfer listed with its error", by(failed.pid)[0]?.kind === "transfer_failed" && by(failed.pid)[0].detail === "razorpay 400");
  check("B05 creating >15 min is stuck", by(stuck.pid)[0]?.kind === "transfer_stuck");
  check("B06 creating <15 min is NOT listed", by(fresh.pid).length === 0);
  check("B07 a parked AND failed transfer appears once, as parked", by(both.pid).length === 1 && by(both.pid)[0].kind === "parked_transfer");
  check("B08 total equals count equals list length", r.total === 3 + 1 && (await call("admin_payment_attention_count")) === 4 && r.items.length === 4, r.total);
  check("B09 amounts are integer paise", by(parked.pid)[0].amount_paise === 50000);
  check("B10 limit caps items but not total", ((await call("admin_payment_attention", 2)).items.length === 2) && (await call("admin_payment_attention", 2)).total === 4);
  const old = r.items.map((i) => i.age_seconds);
  check("B11 oldest first", old.every((v, i) => i === 0 || old[i - 1] >= v));
  check("B12 invalid limit -> CM073", (await adm(`select public.admin_payment_attention(0)`)).err?.code === "CM073" && (await adm(`select public.admin_payment_attention(501)`)).err?.code === "CM073");
});

await inTxn(async () => {
  const a = await mk({ transfer: {} });
  const { rows: [{ id: rid }] } = await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, error) values ($1,'pay_x',50000,'failed','nope') returning id`, [a.pid]);
  const b = await mk({});
  await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, updated_at) values ($1,'pay_y',50000,'creating', now() - interval '20 minutes')`, [b.pid]);
  const c = await mk({});
  await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, razorpay_refund_id, updated_at) values ($1,'pay_z',50000,'pending','rfnd_Pending0001', now() - interval '2 days')`, [c.pid]);
  const d = await mk({});
  await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, razorpay_refund_id) values ($1,'pay_w',50000,'pending','rfnd_Pending0002')`, [d.pid]);
  const e = await mk({});
  await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, razorpay_refund_id) values ($1,'pay_v',50000,'processed','rfnd_Done00000001')`, [e.pid]);
  const r = await call("admin_payment_attention", 100);
  const k = (pid) => r.items.filter((i) => i.purchase_id === pid).map((i) => i.kind);
  check("B20 failed refund listed", k(a.pid)[0] === "refund_failed" && r.items.find((i) => i.kind === "refund_failed").detail === "nope", rid);
  check("B21 creating >15 min listed as refund_stuck", k(b.pid)[0] === "refund_stuck");
  check("B22 pending >1 day listed", k(c.pid)[0] === "refund_stuck");
  check("B23 fresh pending refund NOT listed", k(d.pid).length === 0);
  check("B24 processed refund NOT listed", k(e.pid).length === 0);
});

await inTxn(async () => {
  const mkD = async (status, ago, transfer) => {
    const p = await mk({ transfer });
    await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status, created_at) values ($1,$2,$3,$4,'a53 test reason',$5, now() - $6::interval)`, [p.pid, p.lid, U.buyer, U.seller, status, ago]);
    return p;
  };
  const held = await mkD("open", "1 hour", { on_hold: true, hold: "null" });          // indefinite hold applied: fine
  const unheld = await mkD("open", "1 hour", { on_hold: false, hold: "null" });        // hold not applied: attention
  const stillwin = await mkD("open", "1 hour", { on_hold: true });                     // 48h hold, not yet indefinite: attention
  const recent = await mkD("open", "1 minute", { on_hold: false, hold: "null" });      // too new
  const noTransfer = await mkD("open", "1 hour", null);                                 // Route off / no account: not our problem
  const resolved = await mkD("resolved_denied", "1 hour", { on_hold: false, hold: "null" });
  const parkedOpen = await mkD("open", "1 hour", { on_hold: false, hold: "null", review: "settled before the dispute" });
  const r = await call("admin_payment_attention", 100);
  const k = (pid) => r.items.filter((i) => i.purchase_id === pid).map((i) => i.kind);
  check("B30 indefinite hold applied is fine", k(held.pid).length === 0);
  check("B31 open dispute whose hold was not applied", k(unheld.pid)[0] === "dispute_hold_pending");
  check("B32 open dispute still on the 48h hold", k(stillwin.pid)[0] === "dispute_hold_pending");
  check("B33 dispute under 10 minutes old is not flagged yet", k(recent.pid).length === 0);
  check("B34 open dispute with no transfer is not flagged", k(noTransfer.pid).length === 0);
  check("B35 resolved dispute is not flagged here", k(resolved.pid).length === 0);
  check("B36 a parked transfer with an open dispute appears once, as parked (not also as hold pending)", k(parkedOpen.pid).length === 1 && k(parkedOpen.pid)[0] === "parked_transfer", k(parkedOpen.pid));
});

await inTxn(async () => {
  await mkUsers();
  const ins = (evt, status, ago, extra = {}) => q(`insert into public.webhook_events (provider_event_id, event_type, payload_sha256, status, outcome, error, received_at)
     values ($1,$2,repeat('a',64),$3,$4,$5, now() - $6::interval)`, [`evt_${++seq}`, evt, status, extra.outcome ?? null, extra.error ?? null, ago]);
  await ins("payment.captured", "needs_review", "1 day", { outcome: "order_unknown" });
  await ins("payment.captured", "needs_review", "40 days", { outcome: "ancient" });
  await ins("payment.captured", "processed", "1 day");
  await ins("payment.captured", "failed", "5 minutes");
  await ins("payment.captured", "failed", "3 hours", { error: "db down" });
  const r = await call("admin_payment_attention", 100);
  check("B40 needs_review in the last 30 days listed", r.items.some((i) => i.kind === "webhook_needs_review" && /order_unknown/.test(i.detail)));
  check("B41 needs_review older than 30 days dropped", !r.items.some((i) => /ancient/.test(i.detail)));
  check("B42 processed never listed", r.items.every((i) => i.kind !== "webhook_processed"));
  check("B43 failed under an hour old not listed, older listed", r.items.filter((i) => i.kind === "webhook_failed").length === 1);
  check("B44 webhook rows carry an event id and no purchase id requirement", r.items.every((i) => !i.kind.startsWith("webhook_") || i.event_id));
});

// ---- C: ledger ------------------------------------------------------------------------------------------------------------
await inTxn(async () => {
  const held = await mk({ transfer: {} });
  const rel = await mk({ transfer: { on_hold: false, settle: "pending", hold: "now() - interval '1 hour'" } });
  const settled = await mk({ transfer: { status: "processed", settle: "settled", on_hold: false, hold: "now() - interval '3 days'" } });
  const reversed = await mk({ transfer: { status: "reversed", settle: "on_hold", reversed: 41000 } });
  const failed = await mk({ transfer: { status: "failed", settle: null } });
  const parked = await mk({ transfer: { review: "x" } });
  const bucketOf = async (pid) => (await call("admin_transfers_ledger", null, 100, 0)).items.find((i) => i.purchase_id === pid)?.bucket;
  check("C01 held", (await bucketOf(held.pid)) === "held");
  check("C02 hold ended, not settled -> releasing", (await bucketOf(rel.pid)) === "releasing");
  check("C03 settled", (await bucketOf(settled.pid)) === "settled");
  check("C04 reversed", (await bucketOf(reversed.pid)) === "reversed");
  check("C05 failed", (await bucketOf(failed.pid)) === "failed");
  check("C06 parked beats held", (await bucketOf(parked.pid)) === "parked");
  for (const [b, n] of [["held", 1], ["releasing", 1], ["settled", 1], ["reversed", 1], ["failed", 1], ["parked", 1], ["creating", 0]]) {
    const r = await call("admin_transfers_ledger", b, 100, 0);
    check(`C10 filter ${b}`, r.total === n && r.items.length === n && r.items.every((i) => i.bucket === b), r.total);
  }
  const all = await call("admin_transfers_ledger", null, 100, 0);
  check("C11 unfiltered total", all.total === 6 && all.items.length === 6);
  check("C12 paging: limit 2 offset 4 -> 2 rows, total unchanged", (await call("admin_transfers_ledger", null, 2, 4)).items.length === 2 && (await call("admin_transfers_ledger", null, 2, 4)).total === 6);
  check("C13 paging pages are disjoint", new Set([...(await call("admin_transfers_ledger", null, 3, 0)).items, ...(await call("admin_transfers_ledger", null, 3, 3)).items].map((i) => i.purchase_id)).size === 6);
  check("C14 unknown bucket -> CM073", (await adm(`select public.admin_transfers_ledger('bogus',10,0)`)).err?.code === "CM073");
  check("C15 bad limit/offset -> CM073", (await adm(`select public.admin_transfers_ledger(null,501,0)`)).err?.code === "CM073" && (await adm(`select public.admin_transfers_ledger(null,0,0)`)).err?.code === "CM073" && (await adm(`select public.admin_transfers_ledger(null,10,-1)`)).err?.code === "CM073");
  const h = all.items.find((i) => i.purchase_id === held.pid);
  check("C16 row carries seller share, fee and the sum is the amount", h.amount_paise === 41000 && h.platform_fee_paise === 9000 && h.amount_paise + h.platform_fee_paise === 50000);
});

// ---- D: timeline -----------------------------------------------------------------------------------------------------------
await inTxn(async () => {
  const p = await mk({ transfer: {} });
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a53 reason','open')`, [p.pid, p.lid, U.buyer, U.seller]);
  await q(`insert into public.audit_log (actor_id, action, target_type, target_id) values ($1,'transfer_review_cleared','purchase',$2)`, [U.admin, p.pid]);
  await q(`insert into public.audit_log (actor_id, action, target_type, target_id) values ($1,'other','purchase',$2)`, [U.admin, id(98)]);
  await q(`insert into public.webhook_events (provider_event_id, event_type, payload_sha256, status, purchase_id) values ('evt_tl1','payment.captured',repeat('b',64),'processed',$1)`, [p.pid]);
  await q(`insert into public.webhook_events (provider_event_id, event_type, payload_sha256, status, razorpay_payment_id) values ('evt_tl2','payment.captured',repeat('c',64),'processed','pay_someone_else')`);
  const t = await call("admin_purchase_timeline", p.pid);
  check("D01 found with purchase, transfer, dispute", t.found === true && t.purchase.amount_paise === 50000 && t.transfer.status === "created" && t.dispute.status === "open");
  check("D02 refund is null when none", t.refund === null);
  check("D03 webhook events and audit for this purchase only", t.webhook_events.length === 1 && t.audit.length === 1 && t.audit[0].action === "transfer_review_cleared");
  check("D04 webhook rows expose no payload hash", !JSON.stringify(t.webhook_events).includes("bbbb"));
  check("D05 unknown purchase -> found false", (await call("admin_purchase_timeline", id(97))).found === false);
  check("D06 null purchase -> CM073", (await adm(`select public.admin_purchase_timeline(null)`)).err?.code === "CM073");
  check("D07 names resolved", typeof t.purchase.buyer_name === "string" && typeof t.purchase.seller_name === "string");
});

// ---- D2: disputes + refunds list
await inTxn(async () => {
  const mkD = async (status, transfer, ref) => {
    const p = await mk({ transfer });
    await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'a53 reason',$5)`, [p.pid, p.lid, U.buyer, U.seller, status]);
    if (ref) await q(`insert into public.refunds (purchase_id, razorpay_payment_id, amount_paise, status, error) values ($1,'pay_x',50000,$2,$3)`, [p.pid, ref, ref === "failed" ? "denied" : null]);
    return p;
  };
  const a = await mkD("open", { on_hold: true, hold: "null" });
  const b = await mkD("resolved_refunded", { status: "reversed", reversed: 41000 }, "failed");
  const c = await mkD("resolved_denied", { on_hold: false, hold: "null" });
  const d = await mkD("resolved_refunded", null);
  const r = await call("admin_disputes_refunds", null, 100, 0);
  const row = (p) => r.items.find((i) => i.purchase_id === p.pid);
  check("D20 all disputes listed", r.total === 4 && r.items.length === 4);
  check("D21 open dispute shows its held transfer", row(a).dispute_status === "open" && row(a).transfer_bucket === "held" && row(a).refund_status === null);
  check("D22 refunded dispute shows reversed transfer and the failed refund with its error", row(b).transfer_bucket === "reversed" && row(b).refund_status === "failed" && row(b).refund_error === "denied");
  check("D23 dispute with no transfer shows null bucket", row(d).transfer_bucket === null);
  check("D24 filter by status", (await call("admin_disputes_refunds", "resolved_refunded", 100, 0)).total === 2 && (await call("admin_disputes_refunds", "open", 100, 0)).items.length === 1);
  check("D25 bad status / limit -> CM073", (await adm(`select public.admin_disputes_refunds('x',10,0)`)).err?.code === "CM073" && (await adm(`select public.admin_disputes_refunds(null,0,0)`)).err?.code === "CM073");
  check("D26 names and integer amount", row(c).buyer_name != null && row(c).seller_name != null && row(c).amount_paise === 50000);
});

// ---- E: seller balances ----------------------------------------------------------------------------------------------------
await inTxn(async () => {
  await mkUsers();
  await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,'acc_TestSeller001','active')`, [U.seller]);
  await mk({ transfer: {} });                                                                                      // held 41000
  await mk({ transfer: {} });                                                                                      // held 41000
  await mk({ transfer: { on_hold: false, settle: "pending", hold: "now() - interval '1 hour'" } });                  // releasing 41000
  await mk({ transfer: { status: "processed", settle: "settled", on_hold: false, hold: "now() - interval '3 days'" } }); // settled 41000
  await mk({ transfer: { status: "partially_reversed", settle: "settled", on_hold: false, reversed: 10000, hold: "now() - interval '3 days'" } }); // settled 31000, reversed 10000
  await mk({ transfer: { status: "reversed", reversed: 41000 } });                                                // reversed 41000, nothing owed
  await mk({ transfer: { status: "reversed", reversed: 30000 } });                                                // reversed 30000 (11000 left over is NOT held)
  await mk({ transfer: { status: "failed", settle: null } });                                                       // attention 41000
  await mk({ transfer: { review: "parked" } });                                                                      // attention 41000
  await mk({});                                                                                                      // paid, no transfer -> awaiting 41000
  await mk({ pay: null });                                                                                           // no payment id -> not counted
  await mk({ seller: U.seller2, transfer: {} });
  await mk({ seller: U.nobody, transfer: { status: "failed", settle: null } });
  const r = await call("admin_seller_balances", 100);
  const s = r.items.find((i) => i.seller_id === U.seller);
  check("E01 held", s.held_paise === 82000, s);
  check("E02 releasing", s.releasing_paise === 41000);
  check("E03 settled is net of reversals", s.settled_paise === 72000);
  check("E04 reversed total, and a reversed transfer is never counted as held", s.reversed_paise === 81000 && s.held_paise === 82000);
  check("E05 failed + parked -> attention", s.attention_paise === 82000 && s.attention_count === 2);
  check("E06 awaiting transfer counts only paid purchases with a payment id and no transfer row", s.awaiting_transfer_paise === 41000 && s.awaiting_transfer_count === 1);
  check("E07 payout account status shown", s.account_status === "active");
  const s2 = r.items.find((i) => i.seller_id === U.seller2);
  check("E08 second seller isolated; no account -> null status", s2.held_paise === 41000 && s2.settled_paise === 0 && s2.account_status === null);
  check("E09 total, and sellers with money needing attention sort first (largest first)", r.total === 3 && r.items[0].seller_id === U.seller && r.items[1].seller_id === U.nobody && r.items[2].seller_id === U.seller2, r.items.map((i) => i.seller_id.slice(-2)));
  check("E10 all money fields are integers", r.items.every((i) => Object.entries(i).filter(([k]) => k.endsWith("_paise")).every(([, v]) => Number.isInteger(v))));
  check("E12 with limit 2 the seller with attention money beats a healthier seller whose id sorts earlier", (await call("admin_seller_balances", 2)).items.some((i) => i.seller_id === U.nobody) && !(await call("admin_seller_balances", 2)).items.some((i) => i.seller_id === U.seller2));
  check("E11 limit keeps the sellers needing the most attention, and caps items not total", (await call("admin_seller_balances", 1)).items[0]?.seller_id === U.seller && (await call("admin_seller_balances", 1)).items.length === 1 && (await call("admin_seller_balances", 1)).total === 3);
});
await inTxn(async () => {
  await mkUsers();
  await q(`insert into public.seller_payout_accounts (user_id, razorpay_account_id, status) values ($1,'acc_TestSeller001','pending')`, [U.seller2]);
  const r = await call("admin_seller_balances", 10);
  check("E20 a seller with only a payout account (no sales) is listed with zeros", r.items.length === 1 && r.items[0].held_paise === 0 && r.items[0].account_status === "pending");
});

// ---- F: read-only ------------------------------------------------------------------------------------------------------------
await inTxn(async () => {
  const p = await mk({ transfer: { review: "x" } });
  const snap = async () => JSON.stringify((await q(`select (select count(*) from public.transfers) a, (select count(*) from public.refunds) b, (select count(*) from public.audit_log) c,
     (select count(*) from public.webhook_events) d, (select md5(string_agg(t::text, '|' order by id)) from public.transfers t) e`)).rows[0]);
  const before = await snap();
  for (const [fn, ...args] of FNS) await adm(`select public.${fn}(${argSql(args)})`, args);
  await call("admin_purchase_timeline", p.pid);
  check("F01 calling every reporting function changes nothing", before === (await snap()));
  check("F02 admin cannot run them as write: functions are STABLE", (await q(`select count(*)::int as v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_payment_attention_count','admin_payment_attention','admin_transfers_ledger','admin_purchase_timeline','admin_seller_balances','admin_disputes_refunds') and p.provolatile='s'`)).rows[0].v === 6);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
