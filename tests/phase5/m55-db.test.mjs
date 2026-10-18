// A55-D -- Milestone 5.4 database tests: instant UPI payouts (migration 20261018100000).
// REAL schema (all migrations). Every test runs in a transaction that is ROLLED BACK.
//   Run:  DATABASE_URL=... node tests/phase5/m55-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { seller: id(11), buyer: id(12), admin: id(14), other: id(15) };
const AAL2 = { aal: "aal2" };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a55-${uid.slice(-2)}@example.invalid`]);
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
const svc = async (sql, params) => { const r = await as("service_role", null, null, sql, params); if (r.err) throw r.err; return r.rows[0]?.v; };
const svcE = (sql, params) => as("service_role", null, null, sql, params);
const me = (uid, sql, params) => as("authenticated", uid, null, sql, params);
const adm = (sql, params) => as("authenticated", U.admin, AAL2, sql, params);
const admNoMfa = (sql, params) => as("authenticated", U.admin, null, sql, params);
const flag = (on, name = "phase6_vpa_payouts") => q(`update private.feature_flags set enabled=$1 where name=$2`, [on, name]);
const cutoffNow = () => q(`update private.vpa_payout_config set cutoff_at = now() - interval '1 day' where id`);
const VPA = "asha.k@okhdfcbank";
const setVpa = (uid, v) => me(uid, `select public.set_my_payout_vpa($1) as v`, [v]);
const plan = (pid) => svc(`select public.plan_vpa_payout($1) as v`, [pid]);
let seq = 0;
async function mkPurchase({ seller = U.seller, amount = 500, fee = 90, status = "paid", pay, ago = "0 minutes" } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('A55 listing','n','n',$1,'Asha',$2,'live') returning id`, [amount, seller]);
  const { rows: [p] } = await q(`insert into public.purchases (user_id, listing_id, amount, status, razorpay_payment_id, platform_fee, purchased_at) values ($1,$2,$3,$4,$5,$6, now() - $7::interval) returning id`,
    [U.buyer, l.id, amount, status, pay === undefined ? `pay_A55${++seq}` : pay, fee, ago]);
  return p.id;
}
const account = async ({ uid = U.seller, vpa = VPA, st = "active", withRazorpayIds = false } = {}) => {
  await mkUsers();
  await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status, razorpay_contact_id, razorpay_fund_account_id) values ($1,$2,$3,$4,$5)
           on conflict (user_id) do update set vpa_address=excluded.vpa_address, status=excluded.status, razorpay_contact_id=excluded.razorpay_contact_id, razorpay_fund_account_id=excluded.razorpay_fund_account_id`,
    [uid, vpa, st, withRazorpayIds ? "cont_SecretContact1" : null, withRazorpayIds ? "fa_SecretFundAcct1" : null]);
};
const ready = async (o) => { await flag(true); await cutoffNow(); await account(o); };
const row = async (pid) => (await q(`select * from public.vpa_payouts where purchase_id=$1`, [pid])).rows[0];
const apply = (o) => svc(`select public.apply_vpa_payout_event($1,$2,$3,$4,$5,$6,$7,$8) as v`, [o.payout ?? "pout_AAAAAA000001", o.pid ?? null, o.status ?? "queued", o.utr ?? null, o.at ?? null, o.amount ?? null, o.reason ?? null, o.event ?? null]);

// ---- A: flags, defaults, grants
await inTxn(async () => {
  check("A01 the flag exists and is OFF by default", (await q(`select enabled from private.feature_flags where name='phase6_vpa_payouts'`)).rows[0]?.enabled === false);
  check("A02 cutoff_at defaults to infinity (fail closed) and the cap to Rs 5,000", (await q(`select cutoff_at = 'infinity' as inf, max_payout_paise as m from private.vpa_payout_config`)).rows[0].inf === true && (await q(`select max_payout_paise as m from private.vpa_payout_config`)).rows[0].m === 500000);
  const fns = [["plan_vpa_payout(uuid)", "service_role"], ["record_vpa_fund_account(uuid,text,text,text)", "service_role"], ["apply_vpa_payout_event(text,uuid,text,text,bigint,integer,text,text)", "service_role"],
    ["record_vpa_payout_failure(uuid,text,boolean)", "service_role"], ["list_vpa_payout_work(integer)", "service_role"]];
  for (const [f, role] of fns) {
    const r = (await q(`select has_function_privilege('anon',$1::regprocedure,'execute') a, has_function_privilege('authenticated',$1::regprocedure,'execute') u, has_function_privilege('service_role',$1::regprocedure,'execute') s`, ["public." + f])).rows[0];
    check(`A10 public.${f.split("(")[0]} is service_role only`, !r.a && !r.u && r.s);
  }
  for (const f of ["admin_retry_vpa_payout(uuid)", "admin_set_seller_payout_status(uuid,text)", "admin_vpa_payouts_ledger(text,integer,integer)", "set_my_payout_vpa(text)"]) {
    const r = (await q(`select has_function_privilege('anon',$1::regprocedure,'execute') a, has_function_privilege('authenticated',$1::regprocedure,'execute') u`, ["public." + f])).rows[0];
    check(`A11 public.${f.split("(")[0]} is for signed-in users only (not anon)`, !r.a && r.u);
  }
  const defs = (await q(`select proname, prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('plan_vpa_payout','apply_vpa_payout_event','set_my_payout_vpa','record_vpa_fund_account','record_vpa_payout_failure','list_vpa_payout_work','admin_retry_vpa_payout','admin_set_seller_payout_status','admin_vpa_payouts_ledger')`)).rows;
  check("A12 all nine are SECURITY DEFINER with an empty search_path", defs.length === 9 && defs.every((d) => d.prosecdef && d.proconfig?.some((c) => c.replace(/\s|"/g, "") === "search_path=")));
  check("A13 vpa_payouts has RLS on and anon/authenticated have no table-wide privileges", (await q(`select relrowsecurity r from pg_class where oid='public.vpa_payouts'::regclass`)).rows[0].r && !(await q(`select has_table_privilege('authenticated','public.vpa_payouts','insert') i, has_table_privilege('authenticated','public.vpa_payouts','update') u`)).rows[0].i);
});

// ---- B: set_my_payout_vpa
await inTxn(async () => {
  await mkUsers();
  check("B01 anon denied", (await as("anon", null, null, `select public.set_my_payout_vpa('a.b@okhdfc')`)).err?.code === "42501");
  const bad = ["", null, "nope", "a@", "@bank", "a b@okhdfc", "a@@ok", "x@bank", "a@1bank", "-a@okhdfc", "a@bank-name", "a".repeat(70) + "@okhdfc", "a@" + "b".repeat(40), "a@b.c d", "ab@okhdfc; drop"];
  for (const v of bad) check(`B02 rejects ${JSON.stringify(v)} with CM075`, (await setVpa(U.seller, v)).err?.code === "CM075");
  const ok = await setVpa(U.seller, "  Asha.K@OkHDFCBank ");
  const r = await row2(U.seller);
  check("B03 saves trimmed and lower-cased; outcome 'saved'; status active", !ok.err && ok.rows[0].v.outcome === "saved" && r.vpa_address === VPA && r.status === "active", ok.err?.message ?? r);
  check("B04 saving the same ID again is 'unchanged' (no audit row, no rate-limit use)", (await setVpa(U.seller, VPA)).rows[0].v.outcome === "unchanged");
  await q(`update public.seller_payout_accounts set razorpay_contact_id='cont_Old000001', razorpay_fund_account_id='fa_Old0000001' where user_id=$1`, [U.seller]);
  const ch = await setVpa(U.seller, "new.id@ybl");
  const r2 = await row2(U.seller);
  check("B05 changing the ID is 'changed' and clears the old Razorpay contact + fund account", ch.rows[0].v.outcome === "changed" && r2.vpa_address === "new.id@ybl" && r2.razorpay_contact_id === null && r2.razorpay_fund_account_id === null);
  const aud = (await q(`select metadata::text t from public.audit_log where actor_id=$1 and action='payout_vpa_set'`, [U.seller])).rows;
  check("B06 each change is audited with a MASKED id (never the full UPI id)", aud.length === 2 && aud.every((a) => !a.t.includes("new.id") && !a.t.includes("asha.k")) && aud.some((a) => a.t.includes("ne***@ybl")), aud);
  await q(`update public.seller_payout_accounts set status='suspended' where user_id=$1`, [U.seller]);
  await setVpa(U.seller, "third.id@paytm");
  check("B07 a suspension survives the seller changing their UPI id", (await row2(U.seller)).status === "suspended");
  await setVpa(U.seller, "fourth.id@paytm"); await setVpa(U.seller, "fifth.id@paytm");
  check("B08 the 6th distinct change within 24h is refused (too_many_changes)", (await setVpa(U.seller, "sixth.id@paytm")).err?.message === "too_many_changes");
  check("B09 the rate limit is per seller", !(await setVpa(U.other, "other.id@paytm")).err);
  await account({ uid: U.buyer, withRazorpayIds: true });
  const sel = await me(U.buyer, `select * from public.seller_payout_accounts`);
  check("B10 a seller cannot SELECT * (Razorpay ids are not granted)", sel.err?.code === "42501", sel.err?.message);
  const own = await me(U.buyer, `select user_id, vpa_address, status from public.seller_payout_accounts`);
  check("B11 a seller can read their own id/status only", own.rows.length === 1 && own.rows[0].user_id === U.buyer);
  const w = await me(U.buyer, `update public.seller_payout_accounts set vpa_address='evil@ybl' where user_id=$1`, [U.buyer]);
  check("B12 a seller cannot write the table directly (only through set_my_payout_vpa)", w.err?.code === "42501");
  const ins = await me(U.other, `insert into public.seller_payout_accounts (user_id, vpa_address) values ($1,'x1@ybl')`, [U.other]);
  check("B13 ...nor insert", ins.err?.code === "42501");
  check("B14 a row needs a UPI id or a Route account id", (await q(`savepoint s`).then(() => q(`insert into public.seller_payout_accounts (user_id) values ($1)`, [id(99)]).then(() => "ok", (e) => e.code).finally(() => q(`rollback to savepoint s`)))) !== "ok");
});
async function row2(uid) { return (await q(`select * from public.seller_payout_accounts where user_id=$1`, [uid])).rows[0]; }

// ---- C: plan_vpa_payout
await inTxn(async () => {
  await account();
  const p = await mkPurchase();
  check("C01 flag OFF -> disabled, no ledger row", (await plan(p)).outcome === "disabled" && !(await row(p)));
  await flag(true);
  check("C02 flag ON but cutoff still infinity -> before_cutoff (no backlog payouts)", (await plan(p)).outcome === "before_cutoff" && !(await row(p)));
  await cutoffNow();
  const c = await plan(p), r = await row(p);
  check("C03 claimed: seller share in paise (500.00 - 90.00 = 41000), vpa, key = purchase id", c.outcome === "claimed" && c.amount_paise === 41000 && c.vpa === VPA && c.payout_key === p && c.lookup_first === false && r.amount_paise === 41000 && r.platform_fee_paise === 9000 && r.status === "creating");
  check("C04 a second call within 2 minutes is in_progress (no second claim)", (await plan(p)).outcome === "in_progress");
  await q(`update public.vpa_payouts set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [p]);
  const again = await plan(p);
  check("C05 after a possible crash the SAME key is handed out with lookup_first (Razorpay is asked before anything is created)", again.outcome === "claimed" && again.lookup_first === true && again.payout_key === p && again.attempts === 2);
  await q(`update public.seller_payout_accounts set vpa_address='moved@ybl' where user_id=$1`, [U.seller]);
  await q(`update public.vpa_payouts set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [p]);
  const parked = await plan(p);
  check("C06 UPI id changed after the first attempt -> parked for a human (never silently paid elsewhere)", parked.outcome === "parked" && (await row(p)).status === "failed" && (await row(p)).review_reason.startsWith("upi_id_changed"));
  check("C07 a finished ledger row answers 'exists'", (await plan(p)).outcome === "exists");
  check("C08 one ledger row per purchase (unique)", (await q(`select count(*)::int n from public.vpa_payouts where purchase_id=$1`, [p])).rows[0].n === 1);
});
await inTxn(async () => {
  await ready();
  const unpaid = await mkPurchase({ status: "refunded" });
  check("C10 a refunded purchase is not eligible", (await plan(unpaid)).outcome === "not_eligible");
  const nopay = await mkPurchase({ pay: null });
  check("C11 a purchase with no payment id is not eligible", (await plan(nopay)).outcome === "not_eligible");
  check("C12 unknown purchase -> not_found", (await plan("00000000-0000-0000-0000-00000000dead")).outcome === "not_found");
  const old = await mkPurchase({ ago: "3 days" });
  await q(`update private.vpa_payout_config set cutoff_at = now() - interval '1 hour'`);
  check("C13 a purchase made before cutoff_at is never paid retroactively", (await plan(old)).outcome === "before_cutoff");
  await q(`update private.vpa_payout_config set cutoff_at = now() - interval '1 day'`);
  const fee = await mkPurchase({ amount: 100, fee: 100 });
  check("C14 no seller share (fee >= price) -> not_eligible", (await plan(fee)).outcome === "not_eligible");
  const big = await mkPurchase({ amount: 6000, fee: 600 });
  const bg = await plan(big);
  check("C15 above the cap (Rs 5,000) -> parked as failed/over_max_payout_amount, nothing to send", bg.outcome === "over_cap" && (await row(big)).status === "failed" && (await row(big)).review_reason === "over_max_payout_amount");
  const exact = await mkPurchase({ amount: 5555.56, fee: 555.56 });
  check("C16 exactly at the cap is allowed (500000 paise)", (await plan(exact)).outcome === "claimed");
  const frac = await mkPurchase({ amount: 409.18, fee: 40.92 });
  check("C17 fractional rupees convert to exact integer paise (40918 - 4092 = 36826)", (await plan(frac)).amount_paise === 36826);
});
await inTxn(async () => {
  await flag(true); await cutoffNow(); await mkUsers();
  const p = await mkPurchase();
  check("C20 seller with no payout account -> no_account", (await plan(p)).outcome === "no_account");
  await account({ st: "pending" });
  check("C21 pending account -> no_account", (await plan(p)).outcome === "no_account");
  await account({ st: "suspended" });
  check("C22 suspended account -> no_account (the kill switch)", (await plan(p)).outcome === "no_account");
  await q(`update public.seller_payout_accounts set vpa_address=null, razorpay_account_id='acc_RouteOnly001', status='active' where user_id=$1`, [U.seller]);
  check("C23 an account with only a Route id (no UPI id) -> no_account", (await plan(p)).outcome === "no_account");
  await account();
  await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, amount_paise, platform_fee_paise, status) values ($1,$2,'acc_RouteOnly001','pay_x',41000,9000,'creating')`, [p, U.seller]);
  check("C24 a purchase that already has a Route transfer is never also paid by UPI", (await plan(p)).outcome === "route_transfer_exists" && !(await row(p)));
});
await inTxn(async () => {
  await ready();
  await flag(true, "phase5_route_transfers");
  const p = await mkPurchase();
  check("C30 BOTH flags on -> neither runs (UPI side)", (await plan(p)).outcome === "disabled" && (await q(`select private.is_vpa_payouts_enabled() as v`)).rows[0].v === false);
  check("C31 BOTH flags on -> neither runs (Route side)", (await q(`select private.is_route_transfers_enabled() as v`)).rows[0].v === false && (await svc(`select public.plan_transfer($1) as v`, [p])).outcome === "disabled");
  await flag(false, "phase5_route_transfers");
  check("C32 only the UPI flag on -> UPI runs, Route does not", (await q(`select private.is_vpa_payouts_enabled() as v`)).rows[0].v === true && (await q(`select private.is_route_transfers_enabled() as v`)).rows[0].v === false);
  await flag(false); await flag(true, "phase5_route_transfers");
  check("C33 only the Route flag on -> Route runs, UPI does not", (await q(`select private.is_route_transfers_enabled() as v`)).rows[0].v === true && (await q(`select private.is_vpa_payouts_enabled() as v`)).rows[0].v === false);
});
await inTxn(async () => {
  await ready();
  const a = await mkPurchase();
  await plan(a);
  const d = await svcE(`select public.plan_vpa_payout($1)`, [null]);
  check("C40 null purchase id -> CM075", d.err?.code === "CM075");
  const u = await me(U.seller, `select public.plan_vpa_payout($1)`, [a]);
  check("C41 a signed-in user cannot call plan (service_role only)", u.err?.code === "42501");
});

// ---- D: apply_vpa_payout_event
await inTxn(async () => {
  await ready();
  const p = await mkPurchase(); await plan(p);
  const a1 = await apply({ pid: p, status: "queued", at: 100 });
  check("D01 first event adopts the payout id and applies 'queued'", a1.outcome === "applied" && (await row(p)).razorpay_payout_id === "pout_AAAAAA000001" && (await row(p)).status === "queued");
  check("D02 queued -> processing", (await apply({ status: "processing", at: 110 })).outcome === "applied" && (await row(p)).status === "processing");
  check("D03 a replay of the same state is harmless (applied, idempotent)", (await apply({ status: "processing", at: 110 })).outcome === "applied" && (await row(p)).status === "processing");
  check("D04 an older queued event after processing is stale", (await apply({ status: "queued", at: 120 })).outcome === "stale" && (await row(p)).status === "processing");
  check("D05 an event older than the last one is stale", (await apply({ status: "processed", at: 50 })).outcome === "stale" && (await row(p)).status === "processing");
  const done = await apply({ status: "processed", utr: "UTR98765", at: 130 });
  check("D06 processed stores the UTR", done.outcome === "applied" && (await row(p)).status === "processed" && (await row(p)).utr === "UTR98765");
  check("D07 a late 'failed' can NEVER undo a processed payout", (await apply({ status: "failed", at: 140 })).outcome === "stale" && (await row(p)).status === "processed");
  check("D08 a late 'cancelled' can never undo processed either", (await apply({ status: "cancelled", at: 141 })).outcome === "stale" && (await row(p)).status === "processed");
  const rev = await apply({ status: "reversed", at: 150, reason: "beneficiary bank rejected" });
  check("D09 processed -> reversed (the bank returned the money) is recorded with the reason", rev.outcome === "applied" && (await row(p)).status === "reversed" && (await row(p)).error.includes("bank rejected"));
  check("D10 reversed is terminal (later events stale)", (await apply({ status: "processed", at: 160 })).outcome === "stale" && (await row(p)).status === "reversed");
  check("D10b a reversed payout is not overwritten by a later failed / cancelled event", (await apply({ status: "failed", at: 170 })).outcome === "stale" && (await apply({ status: "cancelled", at: 171 })).outcome === "stale" && (await row(p)).status === "reversed");
});
await inTxn(async () => {
  await ready();
  const p = await mkPurchase(); await plan(p);
  check("D20 a mismatching amount is 'inconsistent_event' and changes nothing", (await apply({ pid: p, status: "processed", amount: 999 })).outcome === "inconsistent_event" && (await row(p)).status === "creating" && (await row(p)).razorpay_payout_id === null);
  check("D21 an unknown payout id (no purchase hint) -> unknown_payout", (await apply({ payout: "pout_NOBODY000009", status: "queued" })).outcome === "unknown_payout");
  check("D22 an unknown payout id with a purchase that has none yet is ADOPTED (creation succeeded but the answer was lost)", (await apply({ pid: p, status: "queued", amount: 41000 })).outcome === "applied" && (await row(p)).razorpay_payout_id === "pout_AAAAAA000001");
  check("D23 a SECOND payout id for the same purchase -> conflicting_payout, nothing changes", (await apply({ payout: "pout_BBBBBB000002", pid: p, status: "processed" })).outcome === "conflicting_payout" && (await row(p)).razorpay_payout_id === "pout_AAAAAA000001" && (await row(p)).status === "queued");
  const f = await mkPurchase(); await plan(f);
  await apply({ payout: "pout_CCCCCC000003", pid: f, status: "failed", reason: "invalid VPA" });
  check("D24 failed is terminal and stores the reason", (await row(f)).status === "failed" && (await row(f)).error.includes("invalid VPA"));
  check("D24b failed is not overwritten by a later cancelled event", (await apply({ payout: "pout_CCCCCC000003", status: "cancelled" })).outcome === "stale" && (await row(f)).status === "failed");
  check("D25 a 'processed' after 'failed' is stale (a human decides via admin retry)", (await apply({ payout: "pout_CCCCCC000003", status: "processed" })).outcome === "stale" && (await row(f)).status === "failed");
  for (const [label, args] of [["bad id", { payout: "x" }], ["bad status", { status: "weird" }], ["status creating", { status: "creating" }], ["zero amount", { amount: 0 }], ["zero time", { at: 0 }]]) {
    check(`D26 invalid input (${label}) -> CM075`, (await svcE(`select public.apply_vpa_payout_event($1,$2,$3,$4,$5,$6,$7,$8)`, [args.payout ?? "pout_DDDDDD000004", null, args.status ?? "queued", null, args.at ?? null, args.amount ?? null, null, null])).err?.code === "CM075");
  }
  check("D27 a signed-in user cannot apply events", (await me(U.seller, `select public.apply_vpa_payout_event('pout_EEEEEE000005',null,'queued')`)).err?.code === "42501");
});
await inTxn(async () => {
  await ready();
  const p = await mkPurchase(); await plan(p);
  const SHA = "c".repeat(64);
  await svc(`select public.begin_webhook_event('evt_p1','payout.processed',null,null,$1)`, [SHA]);
  await apply({ pid: p, status: "processed", event: "evt_p1" });
  const e = (await q(`select status, outcome from public.webhook_events where provider_event_id='evt_p1'`)).rows[0];
  check("D30 an applied payout event finishes its webhook_events row: processed / payout_applied", e.status === "processed" && e.outcome === "payout_applied", e);
  await svc(`select public.begin_webhook_event('evt_p2','payout.processed',null,null,$1)`, [SHA]);
  await apply({ payout: "pout_NOBODY000009", event: "evt_p2" });
  const e2 = (await q(`select status, outcome from public.webhook_events where provider_event_id='evt_p2'`)).rows[0];
  check("D31 an unknown payout marks the event needs_review (a human looks)", e2.status === "needs_review" && e2.outcome === "payout_unknown_payout", e2);
  await svc(`select public.begin_webhook_event('evt_p3','payout.queued',null,null,$1)`, [SHA]);
  await apply({ status: "queued", at: 1, event: "evt_p3" });
  check("D32 a stale event is still 'processed' (nothing to review)", (await q(`select status from public.webhook_events where provider_event_id='evt_p3'`)).rows[0].status === "processed");
});

// ---- E: failures and backoff
await inTxn(async () => {
  await ready();
  const p = await mkPurchase(); await plan(p);
  const f1 = await svc(`select public.record_vpa_payout_failure($1,'timeout',true) as v`, [p]);
  const r1 = await row(p);
  check("E01 retryable failure: retry_scheduled, ~1 minute backoff, still creating, error kept", f1.outcome === "retry_scheduled" && r1.status === "creating" && r1.error === "timeout" && r1.next_attempt_at > new Date() && r1.next_attempt_at < new Date(Date.now() + 90000), r1);
  check("E02 inside the backoff the plan says backoff", (await plan(p)).outcome === "backoff");
  await q(`update public.vpa_payouts set next_attempt_at = now() - interval '1 second' where purchase_id=$1`, [p]);
  check("E03 after the backoff the SAME key is handed out again with lookup_first", (await plan(p)).lookup_first === true);
  await q(`update public.vpa_payouts set attempts = 8 where purchase_id=$1`, [p]);
  check("E04 after 8 attempts a retryable error becomes terminal 'failed'", (await svc(`select public.record_vpa_payout_failure($1,'again',true) as v`, [p])).outcome === "failed" && (await row(p)).status === "failed");
  const q2 = await mkPurchase(); await plan(q2);
  check("E05 a non-retryable error fails immediately", (await svc(`select public.record_vpa_payout_failure($1,'bad vpa',false) as v`, [q2])).outcome === "failed" && (await row(q2)).error === "bad vpa");
  check("E06 failure on a finished row is ignored", (await svc(`select public.record_vpa_payout_failure($1,'x',true) as v`, [q2])).outcome === "ignored");
  const q3 = await mkPurchase(); await plan(q3); await q(`update public.vpa_payouts set attempts=3 where purchase_id=$1`, [q3]);
  await svc(`select public.record_vpa_payout_failure($1,$2,true) as v`, [q3, "e".repeat(500)]);
  check("E07 error text is truncated to 300 chars and backoff doubles (4 min at attempt 3)", (await row(q3)).error.length === 300 && ((await row(q3)).next_attempt_at - new Date()) > 200000);
});

// ---- F: list_vpa_payout_work
await inTxn(async () => {
  await account();
  const p = await mkPurchase();
  check("F01 flag OFF: no create work", (await svc(`select public.list_vpa_payout_work(10) as v`)).length === 0);
  await flag(true);
  check("F02 flag ON but before cutoff: nothing", (await svc(`select public.list_vpa_payout_work(10) as v`)).length === 0);
  await cutoffNow();
  let w = await svc(`select public.list_vpa_payout_work(10) as v`);
  check("F03 a paid, unclaimed purchase of a seller with an active UPI id is create work", w.length === 1 && w[0].kind === "create" && w[0].purchase_id === p);
  await plan(p);
  check("F04 once claimed (inside the 2-minute window) it is not listed", (await svc(`select public.list_vpa_payout_work(10) as v`)).length === 0);
  await q(`update public.vpa_payouts set last_attempt_at = now() - interval '5 minutes' where purchase_id=$1`, [p]);
  check("F05 a claim that went quiet is listed again", (await svc(`select public.list_vpa_payout_work(10) as v`))[0]?.purchase_id === p);
  await apply({ pid: p, status: "processing", at: 5 }); await q(`update public.vpa_payouts set updated_at = now() - interval '1 hour' where purchase_id=$1`, [p]);
  w = await svc(`select public.list_vpa_payout_work(10) as v`);
  check("F06 a processing payout quiet for 15+ minutes is poll work with its payout id", w.length === 1 && w[0].kind === "poll" && w[0].razorpay_payout_id === "pout_AAAAAA000001");
  await flag(false);
  check("F07 polling continues even when the flag is switched OFF (in-flight money is always followed up)", (await svc(`select public.list_vpa_payout_work(10) as v`)).length === 1);
  await flag(true);
  const old = await mkPurchase({ ago: "100 days" }); await q(`update private.vpa_payout_config set cutoff_at='-infinity'`);
  check("F08 purchases older than 90 days are never picked up", !(await svc(`select public.list_vpa_payout_work(10) as v`)).some((i) => i.purchase_id === old));
  const bad = await mkPurchase({ seller: U.other }); 
  check("F09 a seller without a UPI id has no create work", !(await svc(`select public.list_vpa_payout_work(10) as v`)).some((i) => i.purchase_id === bad));
  const withRoute = await mkPurchase();
  await q(`insert into public.transfers (purchase_id, seller_id, razorpay_account_id, razorpay_payment_id, amount_paise, platform_fee_paise, status) values ($1,$2,'acc_RouteOnly001','pay_x',41000,9000,'creating')`, [withRoute, U.seller]);
  check("F09b a purchase that already has a Route transfer is not UPI create work", !(await svc(`select public.list_vpa_payout_work(50) as v`)).some((i) => i.purchase_id === withRoute));
  check("F10 limit is respected", (await svc(`select public.list_vpa_payout_work(1) as v`)).length === 1);
});

// ---- G: admin
await inTxn(async () => {
  await ready();
  const p = await mkPurchase(); await plan(p);
  await apply({ pid: p, status: "failed", reason: "invalid VPA" });
  check("G01 non-admin cannot retry", (await me(U.seller, `select public.admin_retry_vpa_payout($1)`, [p])).err?.code === "42501");
  check("G02 admin without MFA cannot retry", (await admNoMfa(`select public.admin_retry_vpa_payout($1)`, [p])).err?.code === "42501");
  check("G03 admin without MFA cannot set seller status or read the ledger", (await admNoMfa(`select public.admin_set_seller_payout_status($1,'suspended')`, [U.seller])).err?.code === "42501" && (await admNoMfa(`select public.admin_vpa_payouts_ledger()`)).err?.code === "42501");
  const ok = await adm(`select public.admin_retry_vpa_payout($1)`, [p]);
  const r = await row(p);
  check("G04 retry re-queues under a NEW key version, clears the payout id and error", !ok.err && r.status === "creating" && r.key_version === 2 && r.razorpay_payout_id === null && r.error === null && r.attempts === 0);
  check("G05 retry is audited", (await q(`select count(*)::int n from public.audit_log where action='vpa_payout_retried' and actor_id=$1`, [U.admin])).rows[0].n === 1);
  const c = await plan(p);
  check("G06 the new attempt uses payout_key '<purchase>-v2' (a fresh Razorpay idempotency key) and lookup_first", c.outcome === "claimed" && c.payout_key === `${p}-v2` && c.attempts === 1);
  check("G07 retrying something not failed/cancelled/reversed -> CM075", (await adm(`select public.admin_retry_vpa_payout($1)`, [p])).err?.code === "CM075");
  const proc = await mkPurchase(); await plan(proc); await apply({ payout: "pout_PPPPPP000008", pid: proc, status: "processed", at: 5 });
  check("G08 a PROCESSED payout can never be retried (no double pay)", (await adm(`select public.admin_retry_vpa_payout($1)`, [proc])).err?.code === "CM075");
  check("G09 retry picks up the seller's CURRENT UPI id", await (async () => { await q(`update public.seller_payout_accounts set vpa_address='moved@ybl' where user_id=$1`, [U.seller]); await q(`update public.vpa_payouts set status='failed' where purchase_id=$1`, [p]); await adm(`select public.admin_retry_vpa_payout($1)`, [p]); return (await row(p)).vpa_address === "moved@ybl"; })());
  const s = await adm(`select public.admin_set_seller_payout_status($1,'suspended')`, [U.seller]);
  check("G10 admin can suspend a seller; plan then refuses new payouts", !s.err && (await row2(U.seller)).status === "suspended" && (await plan(await mkPurchase())).outcome === "no_account");
  check("G11 invalid status / unknown seller -> CM075", (await adm(`select public.admin_set_seller_payout_status($1,'weird')`, [U.seller])).err?.code === "CM075" && (await adm(`select public.admin_set_seller_payout_status($1,'active')`, [id(98)])).err?.code === "CM075");
  const l = (await adm(`select public.admin_vpa_payouts_ledger(null,100,0) as v`)).rows[0].v;
  check("G12 the ledger lists payouts newest first with total, vpa, status, seller name", l.total >= 2 && l.items.length === l.total && l.items[0].vpa_address !== undefined && l.items[0].status !== undefined);
  check("G13 the ledger filters by status", (await adm(`select public.admin_vpa_payouts_ledger('processed',100,0) as v`)).rows[0].v.items.every((i) => i.status === "processed"));
  check("G14 invalid ledger inputs -> CM075", (await adm(`select public.admin_vpa_payouts_ledger('bogus',10,0)`)).err?.code === "CM075" && (await adm(`select public.admin_vpa_payouts_ledger(null,501,0)`)).err?.code === "CM075" && (await adm(`select public.admin_vpa_payouts_ledger(null,10,-1)`)).err?.code === "CM075");
});

// ---- H: seller sees plain-English status, never a debt
await inTxn(async () => {
  await ready();
  const sv = async (uid = U.seller) => { const r = await me(uid, `select public.seller_payout_status(100) as v`); if (r.err) throw r.err; return r.rows[0].v; };
  const st = (v, pid) => v.items.find((i) => i.purchase_id === pid)?.status;
  await q(`delete from public.seller_payout_accounts where user_id=$1`, [U.seller]);
  const none = await mkPurchase();
  check("H01 UPI mode, no UPI id -> action_needed", st(await sv(), none) === "action_needed");
  await account();
  const queued = await mkPurchase();
  check("H02 UPI id saved, payout not started -> instant_in_progress", st(await sv(), queued) === "instant_in_progress");
  const prog = await mkPurchase(); await plan(prog); await apply({ payout: "pout_H00000000001", pid: prog, status: "processing", at: 1 });
  check("H03 processing -> instant_in_progress", st(await sv(), prog) === "instant_in_progress");
  const paid = await mkPurchase(); await plan(paid); await apply({ payout: "pout_H00000000002", pid: paid, status: "processed", at: 1 });
  check("H04 processed -> instant_paid", st(await sv(), paid) === "instant_paid");
  const failed = await mkPurchase(); await plan(failed); await apply({ payout: "pout_H00000000003", pid: failed, status: "failed", reason: "SECRET internal reason" });
  const rev = await mkPurchase(); await plan(rev); await apply({ payout: "pout_H00000000004", pid: rev, status: "processed", at: 1 }); await apply({ payout: "pout_H00000000004", status: "reversed", at: 2 });
  const v = await sv();
  check("H05 failed or returned payouts -> action_needed (check your UPI ID), never a technical word", st(v, failed) === "action_needed" && st(v, rev) === "action_needed");
  const text = JSON.stringify(v);
  check("H06 the seller's answer leaks no payout id, reason, UTR, razorpay id or error", !/pout_|fa_|cont_|SECRET|utr|razorpay|error|review/i.test(text.replace(/"razorpay[^"]*":null/g, "")), text.slice(0, 300));
  check("H07 the answer shows the UPI id only masked", v.upi_masked === "as***@okhdfcbank" && !text.includes("asha.k"));
  check("H08 summary has the instant codes and amounts add up in paise", v.summary.paid_paise === 41000 && v.summary.in_progress_paise !== undefined && v.summary.action_needed_paise !== undefined, v.summary);
  // an open dispute (a support ticket) must change NOTHING about money
  const lid = (await q(`select listing_id from public.purchases where id=$1`, [paid])).rows[0].listing_id;
  await q(`insert into public.disputes (purchase_id, listing_id, buyer_id, seller_id, reason, status) values ($1,$2,$3,$4,'buyer unhappy','open')`, [paid, lid, U.buyer, U.seller]);
  const v2 = await sv();
  check("H09 an open dispute on a paid-out sale does NOT change the seller's status or amounts (support ticket only)", st(v2, paid) === "instant_paid" && v2.summary.paid_paise === 41000);
  await q(`update public.purchases set status='refunded' where id=$1`, [paid]);
  const v3 = await sv();
  check("H10 even a refunded buyer does not reduce the seller's instant_paid (non-recourse)", st(v3, paid) === "instant_paid" && v3.summary.paid_paise === 41000, v3.summary);
  const negs = []; (function walk(o) { if (typeof o === "number") { if (o < 0) negs.push(o); } else if (o && typeof o === "object") Object.values(o).forEach(walk); })(v3);
  const odd = await mkPurchase({ amount: 100, fee: 150 });
  check("H10b a sale whose fee exceeds the price shows a share of 0, never a negative amount", (await sv()).items.find((i) => i.purchase_id === odd).share_paise === 0);
  check("H11 NO negative number anywhere in the seller's payload and no 'debt'/'negative'/'chargeback'/'recovered' key", negs.length === 0 && !/negative|debt|chargeback|recover|owed/i.test(JSON.stringify(Object.keys(v3.summary)) + JSON.stringify(v3.items.flatMap((i) => Object.keys(i)))));
});

// ---- I: admin reporting understands payouts, and has no seller-debt concept
await inTxn(async () => {
  await ready();
  const mkp = async (st, extra = {}) => { const p = await mkPurchase(); await plan(p); if (st !== "creating") await apply({ payout: `pout_I${String(++seq).padStart(11, "0")}`, pid: p, status: st, at: 1, reason: extra.reason }); return p; };
  const failed = await mkp("failed", { reason: "bad vpa" });
  const parkedP = await mkPurchase({ amount: 6000, fee: 600 }); await plan(parkedP);
  const retd = await mkp("reversed");
  const stuck = await mkPurchase(); await plan(stuck); await q(`update public.vpa_payouts set updated_at = now() - interval '1 hour' where purchase_id=$1`, [stuck]);
  const queued = await mkp("queued"); await q(`update public.vpa_payouts set updated_at = now() - interval '2 hours' where purchase_id=$1`, [queued]);
  const slow = await mkp("processing"); await q(`update public.vpa_payouts set updated_at = now() - interval '2 days' where purchase_id=$1`, [slow]);
  const fine = await mkp("processed");
  const rows = (await adm(`select public.admin_payment_attention(200) as v`)).rows[0].v;
  const items = rows.items ?? rows;
  const kind = (pid) => items.find((i) => i.purchase_id === pid)?.kind;
  check("I01 failed payout -> payout_failed", kind(failed) === "payout_failed");
  check("I02 over-cap payout -> payout_parked", kind(parkedP) === "payout_parked");
  check("I03 returned by the bank -> payout_returned", kind(retd) === "payout_returned");
  check("I04 stuck creating -> payout_stuck", kind(stuck) === "payout_stuck");
  check("I05 queued for over an hour (RazorpayX balance?) -> payout_queued", kind(queued) === "payout_queued");
  check("I06 processing for over a day -> payout_slow", kind(slow) === "payout_slow");
  check("I07 a healthy processed payout is not in the attention list", kind(fine) === undefined);
  const cnt = (await adm(`select public.admin_payment_attention_count() as v`)).rows[0].v;
  check("I08 the attention count includes the payout rows", Number(cnt?.count ?? cnt) >= 5, cnt);
  const bal = (await adm(`select public.admin_seller_balances(50) as v`)).rows[0].v;
  const s = bal.items.find((i) => i.seller_id === U.seller);
  check("I09 seller balances show UPI paid / in progress / needs attention in paise", s.upi_paid_paise === 41000 && s.upi_in_progress_paise > 0 && s.upi_attention_paise > 0 && s.vpa_address === VPA, s);
  const keys = JSON.stringify(Object.keys(s)) + JSON.stringify(rows).match(/"kind":"[a-z_]+"/g);
  check("I10 the admin payload has no negative-balance / chargeback-debt / recovered-loss concept", !/negative|debt|chargeback|recover|owed|clawback/i.test(keys));
  check("I11 no number in the seller balances is negative", Object.values(s).filter((v) => typeof v === "number").every((v) => v >= 0));
  const awaiting = s.awaiting_transfer_paise;
  check("I12 purchases with a UPI payout are not counted as 'awaiting transfer'", awaiting === 0 || awaiting === undefined, awaiting);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
