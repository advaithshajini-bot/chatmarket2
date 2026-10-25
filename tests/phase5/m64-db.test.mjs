// A64-D -- direct UPI, instant unlock + seller report + admin decision (migration 20261025100000). REAL schema; rolled-back transactions.
import pg from "pg";
if (!process.env.DATABASE_URL) { console.log("SKIPPED: DATABASE_URL not set."); process.exit(0); }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const q = (sql, params) => client.query(sql, params);
const id = (n) => `00000000-0000-0000-0000-0000000ffc${n}`;
const U = { s1: id(11), s2: id(12), b1: id(13), b2: id(14), admin: id(16) };
const AAL2 = { aal: "aal2" };
const ID = ["Asha", "Rao", "asha@example.com", "9876543210", "12 MG Road, Bengaluru", "India", "ABCDE1234F", "aadhaar", "234567890123"];
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`); await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const rpc = (uid, fn, ...a) => as("authenticated", uid, null, `select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(",")}) as v`, a);
const adm = (fn, ...a) => as("authenticated", U.admin, AAL2, `select public.${fn}(${a.map((_, i) => `$${i + 1}`).join(",")}) as v`, a);
const val = async (r) => { const x = await r; if (x.err) throw x.err; return x.rows[0].v; };
const msg = (r) => r.err?.message;
const UTR = (n) => String(200000000000 + n);
async function setup() {
  for (const u of Object.values(U)) await q(`insert into auth.users (id,email) values ($1,$2) on conflict do nothing`, [u, `a64-${u.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
  await q(`update public.profiles set display_name = 'Seller One' where id = $1`, [U.s1]);
  await q(`update private.feature_flags set enabled = false where name='direct_upi_checkout'`);
  for (const s of [U.s1, U.s2]) { const r = await rpc(s, "set_seller_identity_details", ...ID); if (r.err) throw r.err; await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status, set_by) values ($1,$2,'active',$1)`, [s, `seller${s.slice(-2)}@okhdfcbank`]); }
  await q(`update private.feature_flags set enabled = true where name='direct_upi_checkout'`);
}
const mkListing = async (seller, price = 499.5) => (await q(`insert into public.listings (title,model,category,price,seller_name,seller_id,status) values ('L','Claude','Design',$1,'s',$2,'live') returning id`, [price, seller])).rows[0].id;

await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 499.5);
  const r = await rpc(U.b1, "submit_direct_payment_claim", L, " 4123 4567 8901 ");
  check("A01 submitting a UTR unlocks instantly: status confirmed, a purchase id returned", !r.err && r.rows[0].v.status === "confirmed" && !!r.rows[0].v.purchase_id, r.err?.message);
  const p = (await q(`select * from public.purchases where id=$1`, [r.rows[0]?.v?.purchase_id])).rows[0];
  check("A02 the purchase is paid, direct_upi, fee 0, amount 499.50, payment id direct_upi_<UTR>, for the buyer and listing", p && p.status === "paid" && p.payment_method === "direct_upi" && Number(p.platform_fee) === 0 && Number(p.amount) === 499.5 && p.razorpay_payment_id === "direct_upi_412345678901" && p.user_id === U.b1 && p.listing_id === L, p);
  const c = (await q(`select * from public.direct_payment_claims where id=$1`, [r.rows[0].v.claim_id])).rows[0];
  check("A03 the claim is confirmed, linked to the purchase, with seller/amount/UPI ID taken from the SERVER", c.status === "confirmed" && c.purchase_id === p.id && c.seller_id === U.s1 && Number(c.amount_paise) === 49950 && c.vpa_address.endsWith("@okhdfcbank") && c.utr === "412345678901");
  check("A04 the buyer can read the purchase straight away (library access)", (await as("authenticated", U.b1, null, `select 1 from public.purchases where listing_id=$1 and status='paid'`, [L])).rows.length === 1);
  check("A05 the lookup now says already_purchased and a second submit is refused", msg(await rpc(U.b1, "submit_direct_payment_claim", L, UTR(2))) === "already_purchased");
  check("A06 the same UTR cannot unlock a second listing, for anyone", msg(await rpc(U.b2, "submit_direct_payment_claim", await mkListing(U.s2), "412345678901")) === "utr_already_used" && msg(await rpc(U.b1, "submit_direct_payment_claim", await mkListing(U.s2), "412345678901")) === "utr_already_used");
  check("A07 a failed attempt leaves no purchase behind (all-or-nothing)", (await q(`select count(*)::int n from public.purchases where razorpay_payment_id = 'direct_upi_412345678901'`)).rows[0].n === 1);
  check("A08 validation still applies: bad UTR / own listing / flag off", msg(await rpc(U.b2, "submit_direct_payment_claim", L, "123")) === "invalid_utr" && msg(await rpc(U.s1, "submit_direct_payment_claim", L, UTR(3))) === "own_listing");
  const audit = (await q(`select metadata::text m from public.audit_log where action='direct_claim_unlocked'`)).rows[0].m;
  check("A09 the audit entry keeps only the last 4 digits of the UTR", audit.includes('"8901"') && !audit.includes("412345678901"));
  check("A10 direct sales still never enter the monthly settlement", (await q(`select count(*)::int n from private.settlement_eligible(now() + interval '1 minute') where purchase_id=$1`, [p.id])).rows[0].n === 0);
  check("A11 anon cannot submit", (await as("anon", null, null, `select public.submit_direct_payment_claim($1,$2)`, [L, UTR(4)])).err?.code === "42501");
  await q(`update private.feature_flags set enabled = false where name='direct_upi_checkout'`);
  check("A12 with the flag OFF nothing can be submitted", msg(await rpc(U.b2, "submit_direct_payment_claim", await mkListing(U.s2), UTR(5))) === "feature_off");
});

await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 100);
  const c = (await val(rpc(U.b1, "submit_direct_payment_claim", L, UTR(10)))).claim_id;
  check("B01 the seller sees the unlocked payment and may report it", (await val(rpc(U.s1, "seller_direct_claims"))).claims[0].can_report === true);
  check("B02 a short reason is refused", msg(await rpc(U.s1, "raise_direct_payment_dispute", c, "no")) === "invalid_reason");
  check("B03 another seller / the buyer cannot report it (claim_not_found)", msg(await rpc(U.s2, "raise_direct_payment_dispute", c, "I did not get this money")) === "claim_not_found" && msg(await rpc(U.b1, "raise_direct_payment_dispute", c, "I did not get this money")) === "claim_not_found");
  const r = await rpc(U.s1, "raise_direct_payment_dispute", c, "  UTR is not in my account statement  ");
  check("B04 the seller reports it: status disputed, reason stored trimmed", !r.err && r.rows[0].v.outcome === "reported" && (await q(`select status, dispute_reason from public.direct_payment_claims where id=$1`, [c])).rows[0].dispute_reason === "UTR is not in my account statement");
  check("B05 reporting again is idempotent", (await val(rpc(U.s1, "raise_direct_payment_dispute", c, "I did not get this money"))).outcome === "already_reported");
  check("B06 the buyer KEEPS access while the report is open", (await as("authenticated", U.b1, null, `select 1 from public.purchases where listing_id=$1 and status='paid'`, [L])).rows.length === 1);
  check("B07 the UTR stays locked while disputed", msg(await rpc(U.b2, "submit_direct_payment_claim", await mkListing(U.s2), UTR(10))) === "utr_already_used");
  check("B08 the seller view shows it as disputed with no report button", (await val(rpc(U.s1, "seller_direct_claims"))).claims[0].status === "disputed" && (await val(rpc(U.s1, "seller_direct_claims"))).disputed_count === 1);
  // admin
  check("B10 a non-admin cannot list or decide", (await rpc(U.s1, "admin_direct_claims")).err?.code === "42501" && (await rpc(U.s1, "admin_resolve_direct_dispute", c, "revoked", null)).err?.code === "42501");
  check("B11 an admin WITHOUT the second factor cannot either", (await as("authenticated", U.admin, { aal: "aal1" }, `select public.admin_direct_claims()`)).err?.code === "42501");
  const lst = await val(adm("admin_direct_claims"));
  check("B12 the admin sees the report with seller, buyer, UTR, UPI ID and reason", lst.disputed_count === 1 && lst.claims[0].utr === UTR(10) && lst.claims[0].seller_name === "Seller One" && lst.claims[0].dispute_reason.includes("statement") && lst.claims[0].seller_vpa.endsWith("@okhdfcbank"), lst);
  check("B13 invalid filter / decision are refused", msg(await adm("admin_direct_claims", "bogus", 10)) === "invalid_filter" && msg(await adm("admin_resolve_direct_dispute", c, "maybe", null)) === "invalid_decision");
  check("B14 upheld: the claim is confirmed again, access stays, the decision is recorded", (await val(adm("admin_resolve_direct_dispute", c, "upheld", "Seen in statement"))).outcome === "upheld" && (await q(`select status, resolution, resolution_note, resolved_by from public.direct_payment_claims where id=$1`, [c])).rows.every((x) => x.status === "confirmed" && x.resolution === "upheld" && x.resolution_note === "Seen in statement" && x.resolved_by === U.admin) && (await q(`select status from public.purchases where listing_id=$1`, [L])).rows[0].status === "paid");
  check("B15 an upheld claim cannot be reported again", msg(await rpc(U.s1, "raise_direct_payment_dispute", c, "Trying to report once more")) === "claim_not_reportable" && (await val(rpc(U.s1, "seller_direct_claims"))).claims[0].can_report === false);
  check("B16 deciding a claim that is not disputed is refused", msg(await adm("admin_resolve_direct_dispute", c, "revoked", null)) === "claim_not_disputed");
});

await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 100);
  const c = (await val(rpc(U.b1, "submit_direct_payment_claim", L, UTR(20)))).claim_id;
  await val(rpc(U.s1, "raise_direct_payment_dispute", c, "Money never arrived in my account"));
  check("C01 revoked: access is removed (the purchase is no longer paid) and the claim is revoked", (await val(adm("admin_resolve_direct_dispute", c, "revoked", "No such payment"))).outcome === "revoked"
    && (await q(`select status from public.purchases where listing_id=$1`, [L])).rows[0].status === "refunded" && (await q(`select status, resolution from public.direct_payment_claims where id=$1`, [c])).rows[0].status === "revoked");
  check("C02 the buyer no longer sees a paid purchase for it", (await as("authenticated", U.b1, null, `select 1 from public.purchases where listing_id=$1 and status='paid'`, [L])).rows.length === 0);
  const t = await val(rpc(U.b1, "get_direct_payment_target", L));
  check("C03 the buyer cannot simply pay again: reason payment_revoked, UPI ID not revealed", t.available === false && t.reason === "payment_revoked" && !JSON.stringify(t).includes("okhdfcbank"), t);
  check("C04 the revoked UTR stays locked for ever", msg(await rpc(U.b2, "submit_direct_payment_claim", await mkListing(U.s2), UTR(20))) === "utr_already_used");
  check("C05 a revoked claim cannot be reported or decided again", msg(await rpc(U.s1, "raise_direct_payment_dispute", c, "Reporting after the decision")) === "claim_not_reportable" && msg(await adm("admin_resolve_direct_dispute", c, "upheld", null)) === "claim_not_disputed");
  const f = await val(adm("admin_direct_claims", "revoked"));
  check("C06 the admin can list revoked claims, and 'all' shows unlocked ones too", f.claims.length === 1 && (await val(adm("admin_direct_claims", "all"))).claims.length === 1);
  const audit = (await q(`select string_agg(action, ' ') a from public.audit_log`)).rows[0].a;
  check("C07 unlock, report and decision are all in the audit log", /direct_claim_unlocked/.test(audit) && /direct_claim_disputed/.test(audit) && /direct_dispute_resolved/.test(audit));
});

await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 100);
  const c = (await val(rpc(U.b1, "submit_direct_payment_claim", L, UTR(30)))).claim_id;
  await q(`update public.direct_payment_claims set created_at = now() - interval '31 days' where id=$1`, [c]);
  check("D01 after the 30-day window the seller can no longer report", msg(await rpc(U.s1, "raise_direct_payment_dispute", c, "Money never arrived, sorry late")) === "report_window_passed" && (await val(rpc(U.s1, "seller_direct_claims"))).claims[0].can_report === false);
  await q(`update private.direct_upi_config set dispute_window_days = 90`);
  check("D02 the window is configurable", !(await rpc(U.s1, "raise_direct_payment_dispute", c, "Money never arrived, sorry late")).err);
});
await inTxn(async () => {
  await setup();
  const L = await mkListing(U.s1, 10);
  const c = (await val(rpc(U.b1, "submit_direct_payment_claim", L, UTR(40)))).claim_id;
  await q(`insert into public.audit_log (actor_id, action, target_type, metadata) select $1, 'direct_claim_disputed', 'listing', '{}'::jsonb from generate_series(1, 20)`, [U.s1]);
  check("E01 a seller can file at most 20 reports a day", msg(await rpc(U.s1, "raise_direct_payment_dispute", c, "Money never arrived in account")) === "too_many_reports");
});
await inTxn(async () => {
  const p = (fn) => q(`select has_function_privilege('anon','public.${fn}','execute') a, has_function_privilege('authenticated','public.${fn}','execute') u`);
  for (const f of ["raise_direct_payment_dispute(uuid, text)", "admin_direct_claims(text, integer)", "admin_resolve_direct_dispute(uuid, text, text)"]) { const r = (await p(f)).rows[0]; check(`F01 public.${f.split("(")[0]}: not for anon, for authenticated`, !r.a && r.u, r); }
  const d = (await q(`select proname, prosecdef, proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('raise_direct_payment_dispute','admin_direct_claims','admin_resolve_direct_dispute','submit_direct_payment_claim','seller_direct_claims')`)).rows;
  check("F02 all five are SECURITY DEFINER with an empty search_path", d.length === 5 && d.every((x) => x.prosecdef && (x.proconfig ?? []).includes('search_path=""')), d);
  const st = (await q(`select pg_get_constraintdef(oid) d from pg_constraint where conname='direct_payment_claims_status_check'`)).rows[0].d;
  check("F03 the status check lists all six states", ["pending", "confirmed", "rejected", "expired", "disputed", "revoked"].every((s) => st.includes(`'${s}'`)), st);
  check("F04 the dispute window defaults to 30 days", (await q(`select dispute_window_days d from private.direct_upi_config`)).rows[0].d === 30);
});

await client.end();
console.log(`\nA64-D: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
