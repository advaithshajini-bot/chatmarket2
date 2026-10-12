// A51-D -- Milestone 5.1 database tests: payment fulfilment (migration 20261012100000) against the REAL schema.
// Every test runs in a transaction that is ROLLED BACK.   Run:  DATABASE_URL=... node tests/phase5/m51-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000eee${n}`;
const U = { seller: id(51), buyer: id(52), other: id(53), admin: id(54) };

async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a51-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
}
async function mkListing({ price = 499, status = "live" } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status)
     values ('A51 listing','n','n',$1,'Sam Seller',$2,$3) returning id`, [price, U.seller, status]);
  return l.id;
}
async function mkOrder(lid, { order = "order_A", user = U.buyer, paise = 49900 } = {}) {
  await q(`select public.record_payment_order($1,$2,$3,$4)`, [order, user, lid, paise]);
  return order;
}
async function as(role, uid, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, rowCount: r.rowCount, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], rowCount: 0, err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const FULFIL = `select public.fulfil_captured_payment($1,$2,$3,$4,$5,$6,$7,$8,$9) as v`;
const fulfil = (o = {}) => as("service_role", null, FULFIL, [
  o.order ?? "order_A", o.payment ?? "pay_A", "amount" in o ? o.amount : 49900, o.currency ?? "INR", o.method ?? "upi",
  "sig" in o ? o.sig : null, "fee" in o ? o.fee : 0.18, "user" in o ? o.user : null, o.event ?? null]);
const code = (r) => r.err?.code;

// ---------------------------------------------------------------- grants / exposure
{
  const sigs = {
    fulfil_captured_payment: "text,text,integer,text,text,text,numeric,uuid,text",
    record_payment_order: "text,uuid,uuid,integer", begin_webhook_event: "text,text,text,text,text", finish_webhook_event: "text,text,text,text",
  };
  for (const [fn, args] of Object.entries(sigs)) {
    const v = async (role) => val(`select has_function_privilege('${role}', 'public.${fn}(${args})', 'execute') as v`);
    check(`D01 ${fn}: service_role can execute`, (await v("service_role")) === true);
    check(`D02 ${fn}: anon and authenticated can NOT execute (and not PUBLIC)`, (await v("anon")) === false && (await v("authenticated")) === false);
    const { rows: [r] } = await q(`select prosecdef, proconfig from pg_proc where oid = 'public.${fn}(${args})'::regprocedure`);
    check(`D03 ${fn}: SECURITY DEFINER with an empty search_path`, r.prosecdef === true && (r.proconfig ?? []).some((c) => /^search_path=("")?$/.test(c)), r);
  }
  await inTxn(async () => {
    await mkUsers();
    const r = await as("authenticated", U.buyer, `select public.fulfil_captured_payment('o','p',100,'INR','upi',null,0.18,null,null)`);
    check("D04 a logged-in user calling the fulfil function gets permission denied (42501)", code(r) === "42501", r.err?.message);
    const r2 = await as("anon", null, `select public.begin_webhook_event('e','payment.captured',null,null,$1)`, ["a".repeat(64)]);
    check("D05 anon calling begin_webhook_event gets permission denied", code(r2) === "42501", r2.err?.message);
  });
  for (const t of ["payment_orders", "webhook_events"]) {
    const rls = await val(`select relrowsecurity as v from pg_class where oid = 'public.${t}'::regclass`);
    check(`D06 ${t}: row level security is enabled`, rls === true);
    const w = await val(`select (has_table_privilege('authenticated','public.${t}','insert') or has_table_privilege('authenticated','public.${t}','update')
      or has_table_privilege('authenticated','public.${t}','delete') or has_table_privilege('anon','public.${t}','select')) as v`);
    check(`D07 ${t}: no write privileges for authenticated, no read for anon`, w === false);
  }
}

// ---------------------------------------------------------------- happy path
await inTxn(async () => {
  const lid = await mkListing();
  await mkOrder(lid);
  const r = await fulfil({ sig: "sigvalue" });
  check("D10 fulfil: outcome 'fulfilled' with a purchase id", !r.err && r.rows[0].v.outcome === "fulfilled" && !!r.rows[0].v.purchase_id, r);
  const p = (await q(`select * from public.purchases where razorpay_payment_id = 'pay_A'`)).rows[0];
  check("D11 purchase row: right buyer, listing, status paid, transfer_status pending",
    p?.user_id === U.buyer && p.listing_id === lid && p.status === "paid" && p.transfer_status === "pending", p);
  check("D12 amount is rupees (499), platform fee is 18% rounded to 2 dp (89.82), method and signature stored",
    Number(p.amount) === 499 && Number(p.platform_fee) === 89.82 && p.payment_method === "upi" && p.razorpay_signature === "sigvalue" && p.razorpay_order_id === "order_A", p);
  const a = (await q(`select * from public.audit_log where action='payment_fulfilled' and target_id = $1`, [p.id])).rows;
  check("D13 one audit row, source 'verify' (no event id)", a.length === 1 && a[0].metadata.source === "verify" && a[0].metadata.amount_paise === 49900, a);
});

// ---------------------------------------------------------------- idempotency
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const a = (await fulfil()).rows[0].v, b = (await fulfil()).rows[0].v;
  check("D20 the same payment twice: 'fulfilled' then 'already_fulfilled', SAME purchase id", a.outcome === "fulfilled" && b.outcome === "already_fulfilled" && a.purchase_id === b.purchase_id, [a, b]);
  check("D21 exactly one purchase row and one audit row", (await val(`select count(*)::int as v from public.purchases`)) === 1
    && (await val(`select count(*)::int as v from public.audit_log where action='payment_fulfilled'`)) === 1);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await fulfil();
  await q(`update public.listings set price = 999, status = 'removed' where id = $1`, [lid]);
  const r = (await fulfil({ amount: 12345 })).rows[0].v;
  check("D22 a replay of an already-fulfilled payment stays 'already_fulfilled' even if the listing changed or the replay's numbers differ", r.outcome === "already_fulfilled", r);
});

// ---------------------------------------------------------------- refusals (nothing granted)
await inTxn(async () => {
  await mkListing();
  const r = (await fulfil({ order: "order_nope", payment: "pay_x" })).rows[0].v;
  check("D30 unknown order: 'order_unknown', no purchase", r.outcome === "order_unknown" && r.purchase_id === null && (await val(`select count(*)::int as v from public.purchases`)) === 0, r);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  for (const [label, paise] of [["lower", 100], ["higher", 99900], ["one paise off", 49901]]) {
    const r = (await fulfil({ amount: paise, payment: `pay_${paise}` })).rows[0].v;
    check(`D31 amount ${label} than the order: 'amount_mismatch', no purchase`, r.outcome === "amount_mismatch" && r.purchase_id === null, r);
  }
  check("D31b still no purchase rows", (await val(`select count(*)::int as v from public.purchases`)) === 0);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const r = (await fulfil({ user: U.other })).rows[0].v;
  check("D32 browser path with a DIFFERENT logged-in user: 'order_user_mismatch', no purchase", r.outcome === "order_user_mismatch" && (await val(`select count(*)::int as v from public.purchases`)) === 0, r);
  const ok = (await fulfil({ user: U.buyer })).rows[0].v;
  check("D32b the right user then succeeds (the mismatch left no trace)", ok.outcome === "fulfilled", ok);
});
for (const st of ["removed", "pending_review", "flagged"]) {
  await inTxn(async () => {
    const lid = await mkListing({ status: "live" }); await mkOrder(lid);
    await q(`update public.listings set status = $2 where id = $1`, [lid, st]);
    const r = (await fulfil()).rows[0].v;
    check(`D33 listing '${st}' at payment time: 'listing_unavailable', no purchase`, r.outcome === "listing_unavailable" && (await val(`select count(*)::int as v from public.purchases`)) === 0, r);
  });
}
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await fulfil();
  await mkOrder(lid, { order: "order_B" });
  const r = (await fulfil({ order: "order_B", payment: "pay_B" })).rows[0].v;
  const first = await val(`select id as v from public.purchases where razorpay_payment_id='pay_A'`);
  check("D34 a SECOND payment for something already owned: 'duplicate_payment', points at the existing purchase, no second row",
    r.outcome === "duplicate_payment" && r.purchase_id === first && (await val(`select count(*)::int as v from public.purchases`)) === 1, r);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await q(`update public.listings set price = 10 where id = $1`, [lid]);
  const r = (await fulfil()).rows[0].v;
  check("D35 the order's price is the contract: a later listing price edit does not break an already-created order", r.outcome === "fulfilled", r);
  check("D35b ... and the purchase records what was actually paid (499), not the new price", Number(await val(`select amount as v from public.purchases`)) === 499);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const r = (await fulfil({ amount: null })).rows[0].v;
  check("D36 NULL amount (browser path, Razorpay lookup failed) uses the order's own amount", r.outcome === "fulfilled", r);
});

// ---------------------------------------------------------------- input validation raises CM070
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const bad = {
    "empty order id": { order: "" }, "empty payment id": { payment: "" }, "101-char payment id": { payment: "p".repeat(101) },
    "amount 0": { amount: 0 }, "negative amount": { amount: -5 }, "USD": { currency: "USD" }, "fee 1.5": { fee: 1.5 }, "fee -0.1": { fee: -0.1 }, "NULL fee": { fee: null },
  };
  for (const [label, o] of Object.entries(bad)) {
    const r = await fulfil(o);
    check(`D40 malformed input (${label}) raises CM070`, code(r) === "CM070", r.err?.message);
  }
  check("D41 none of those wrote anything", (await val(`select count(*)::int as v from public.purchases`)) === 0);
});
await inTxn(async () => {
  const lid = await mkListing();
  const bad = [["empty order id", ["", U.buyer, lid, 100]], ["no user", ["o", null, lid, 100]], ["no listing", ["o", U.buyer, null, 100]], ["zero amount", ["o", U.buyer, lid, 0]]];
  for (const [label, args] of bad) {
    const r = await as("service_role", null, `select public.record_payment_order($1,$2,$3,$4)`, args);
    check(`D42 record_payment_order rejects ${label} (CM070)`, code(r) === "CM070", r.err?.message);
  }
  await q(`select public.record_payment_order('dup', $1, $2, 100)`, [U.buyer, lid]);
  await q(`select public.record_payment_order('dup', $1, $2, 999)`, [U.other, lid]);
  const o = (await q(`select * from public.payment_orders where razorpay_order_id='dup'`)).rows;
  check("D43 recording the same order id again is a no-op (first write wins, it cannot be rewritten)", o.length === 1 && o[0].amount_paise === 100 && o[0].user_id === U.buyer, o);
});

// ---------------------------------------------------------------- webhook events
const SHA = "a".repeat(64);
const begin = (ev, type = "payment.captured", o = "order_A", p = "pay_A", sha = SHA) =>
  as("service_role", null, `select public.begin_webhook_event($1,$2,$3,$4,$5) as v`, [ev, type, o, p, sha]);
await inTxn(async () => {
  check("D50 first sight of an event id: 'new'", (await begin("evt_1")).rows[0].v === "new");
  check("D51 a received-but-unfinished event re-delivered: 'retry', attempts goes to 2",
    (await begin("evt_1")).rows[0].v === "retry" && (await val(`select attempts as v from public.webhook_events where provider_event_id='evt_1'`)) === 2);
  await as("service_role", null, `select public.finish_webhook_event('evt_1','processed','fulfilled')`);
  check("D52 after it is processed, a re-delivery is a 'duplicate'", (await begin("evt_1")).rows[0].v === "duplicate");
  await begin("evt_2"); await as("service_role", null, `select public.finish_webhook_event('evt_2','failed','fulfil_error','boom')`);
  check("D53 a FAILED event re-delivered is let through again ('retry')", (await begin("evt_2")).rows[0].v === "retry");
  await begin("evt_3"); await as("service_role", null, `select public.finish_webhook_event('evt_3','needs_review','amount_mismatch')`);
  check("D54 a needs_review event is a 'duplicate' (retrying cannot fix it; a human must)", (await begin("evt_3")).rows[0].v === "duplicate");
  await begin("evt_4"); await as("service_role", null, `select public.finish_webhook_event('evt_4','ignored','unhandled_event')`);
  check("D55 an ignored event is a 'duplicate'", (await begin("evt_4")).rows[0].v === "duplicate");
  const r = await as("service_role", null, `select public.finish_webhook_event('evt_4','bogus','x')`);
  check("D56 finish_webhook_event rejects an unknown status (CM070)", code(r) === "CM070");
  await as("service_role", null, `select public.finish_webhook_event('evt_1','failed','late','x')`);
  check("D57 a finished event cannot be flipped back by a late finish call", (await val(`select status as v from public.webhook_events where provider_event_id='evt_1'`)) === "processed");
  for (const [label, args] of [["empty id", ["", "t", null, null, SHA]], ["empty type", ["e", "", null, null, SHA]], ["bad sha", ["e", "t", null, null, "xyz"]], ["uppercase sha", ["e", "t", null, null, "A".repeat(64)]]]) {
    const rr = await as("service_role", null, `select public.begin_webhook_event($1,$2,$3,$4,$5)`, args);
    check(`D58 begin_webhook_event rejects ${label} (CM070)`, code(rr) === "CM070", rr.err?.message);
  }
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='webhook_events'`)).rows.map((r) => r.column_name);
  check("D59 webhook_events has NO column that could hold the payload body (only ids + a hash)", !cols.some((c) => /payload$|body|raw|json/i.test(c)) && cols.includes("payload_sha256"), cols);
});

// ---------------------------------------------------------------- webhook + fulfil together
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await begin("evt_ok");
  const r = (await fulfil({ event: "evt_ok" })).rows[0].v;
  const e = (await q(`select * from public.webhook_events where provider_event_id='evt_ok'`)).rows[0];
  check("D60 fulfil with an event id finishes the event in the same transaction: processed, outcome, purchase id, timestamp",
    r.outcome === "fulfilled" && e.status === "processed" && e.outcome === "fulfilled" && e.purchase_id === r.purchase_id && e.processed_at !== null, e);
  const a = await val(`select metadata->>'source' as v from public.audit_log where action='payment_fulfilled'`);
  check("D61 audit source is 'webhook' when an event id is given", a === "webhook", a);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await begin("evt_bad");
  const r = (await fulfil({ event: "evt_bad", amount: 1 })).rows[0].v;
  const e = (await q(`select status, outcome, purchase_id from public.webhook_events where provider_event_id='evt_bad'`)).rows[0];
  check("D62 a mismatch marks the event needs_review with the outcome, no purchase id", r.outcome === "amount_mismatch" && e.status === "needs_review" && e.outcome === "amount_mismatch" && e.purchase_id === null, e);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const r1 = (await fulfil({ user: U.buyer, sig: "s" })).rows[0].v;     // browser got there first
  await begin("evt_late");
  const r2 = (await fulfil({ event: "evt_late" })).rows[0].v;            // webhook arrives after
  check("D63 verify first, webhook later: second is 'already_fulfilled', event processed, still ONE purchase",
    r1.outcome === "fulfilled" && r2.outcome === "already_fulfilled" && (await val(`select status as v from public.webhook_events where provider_event_id='evt_late'`)) === "processed"
    && (await val(`select count(*)::int as v from public.purchases`)) === 1);
});
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  await begin("evt_first");
  await fulfil({ event: "evt_first" });                                  // webhook got there first
  const r = (await fulfil({ user: U.buyer, sig: "s" })).rows[0].v;       // browser later
  check("D64 webhook first, verify later: verify gets 'already_fulfilled' with the purchase id (buyer sees success)", r.outcome === "already_fulfilled" && !!r.purchase_id, r);
});

// ---------------------------------------------------------------- RLS on the new tables
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid); await begin("evt_rls");
  const cnt = async (role, uid, t) => (await as(role, uid, `select count(*)::int as c from public.${t}`)).rows[0]?.c;
  check("D70 a buyer sees none of payment_orders / webhook_events", (await cnt("authenticated", U.buyer, "payment_orders")) === 0 && (await cnt("authenticated", U.buyer, "webhook_events")) === 0);
  check("D71 a seller sees none either", (await cnt("authenticated", U.seller, "payment_orders")) === 0 && (await cnt("authenticated", U.seller, "webhook_events")) === 0);
  check("D72 an admin sees them", (await cnt("authenticated", U.admin, "payment_orders")) === 1 && (await cnt("authenticated", U.admin, "webhook_events")) === 1);
  const w = await as("authenticated", U.admin, `insert into public.webhook_events (provider_event_id,event_type,payload_sha256) values ('x','y',$1)`, [SHA]);
  check("D73 even an admin cannot write the tables directly", w.err !== null);
});

// ---------------------------------------------------------------- pre-existing purchases insert hole (documents current behaviour)
await inTxn(async () => {
  const lid = await mkListing();
  const r = await as("authenticated", U.buyer, `insert into public.purchases (user_id, listing_id, amount) values ($1,$2,0) returning id`, [U.buyer, lid]);
  console.log(`INFO: today a logged-in user ${r.err ? "CANNOT" : "CAN"} insert their own 'paid' purchase directly (migration 5.1 deliberately does not change this; see supabase/manual/phase5_close_purchase_insert_policy.sql).`);
});

// ---------------------------------------------------------------- the closing script (manual, not a migration)
await inTxn(async () => {
  const lid = await mkListing(); await mkOrder(lid);
  const script = (await import("node:fs")).readFileSync(new URL("../../supabase/manual/phase5_close_purchase_insert_policy.sql", import.meta.url), "utf8");
  await q(script.replace(/^\s*begin\s*;|commit\s*;\s*$/gim, ""));
  const direct = await as("authenticated", U.buyer, `insert into public.purchases (user_id, listing_id, amount) values ($1,$2,0)`, [U.buyer, lid]);
  check("D80 after the manual script: a logged-in user can NO LONGER insert a purchase directly", direct.err !== null && ["42501"].includes(code(direct)), direct.err?.message);
  const r = (await fulfil({ user: U.buyer })).rows[0].v;
  check("D81 ... and the fulfilment function still creates the purchase (it is SECURITY DEFINER)", r.outcome === "fulfilled", r);
  const read = await as("authenticated", U.buyer, `select count(*)::int as c from public.purchases`);
  check("D82 ... and the buyer can still READ their own purchase", read.rows[0]?.c === 1, read);
  const sel = await as("authenticated", U.seller, `select count(*)::int as c from public.purchases`);
  check("D83 ... and the seller can still read purchases of their listings", sel.rows[0]?.c === 1, sel);
});

console.log(`\nA51-D: ${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
