// A63-D -- direct seller-to-buyer UPI payments (migration 20261024100000). REAL schema (all migrations).
// Every test runs in a transaction that is ROLLED BACK.   Run:  DATABASE_URL=... node tests/phase5/m63-db.test.mjs
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
const id = (n) => `00000000-0000-0000-0000-0000000ffd${n}`;
const U = { s1: id(11), s2: id(12), b1: id(13), b2: id(14), b3: id(15), admin: id(16) };
const AAL2 = { aal: "aal2" };
const ID = { first: "Asha", last: "Rao", email: "Asha@Example.com", phone: "+91 98765 43210", addr: "12 MG Road, Bengaluru", country: "India", pan: "abcde1234f", type: "aadhaar", num: "2345 6789 0123" };
const idArgs = (o = {}) => { const v = { ...ID, ...o }; return [v.first, v.last, v.email, v.phone, v.addr, v.country, v.pan, v.type, v.num]; };
async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a63-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id = $1`, [U.admin]);
  await q(`update public.profiles set display_name = 'Seller One' where id = $1`, [U.s1]);
  await q(`update public.profiles set display_name = 'Buyer One' where id = $1`, [U.b1]);
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const au = (uid, sql, params) => as("authenticated", uid, null, sql, params);
const rpc = async (uid, fn, ...args) => { const r = await au(uid, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as v`, args); return r; };
const val = async (uid, fn, ...args) => { const r = await rpc(uid, fn, ...args); if (r.err) throw r.err; return r.rows[0].v; };
const msg = (r) => r.err?.message;
const flag = (on) => q(`update private.feature_flags set enabled = $1 where name = 'direct_upi_checkout'`, [on]);
async function seedSeller(uid, { identity = true, vpa = "asha@okhdfcbank", changedAgoHours = null } = {}) {
  if (identity) { await flag(false); const r = await au(uid, `select public.set_seller_identity_details($1,$2,$3,$4,$5,$6,$7,$8,$9)`, idArgs()); if (r.err) throw r.err; }
  if (vpa) await q(`insert into public.seller_payout_accounts (user_id, vpa_address, status, set_by) values ($1,$2,'active',$1)`, [uid, vpa]);
  if (changedAgoHours !== null) await q(`update public.seller_payout_accounts set vpa_changed_at = now() - make_interval(hours => $2) where user_id = $1`, [uid, changedAgoHours]);
}
async function mkListing(seller, price = 499.5, status = "live") {
  const r = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status) values ('L','Claude','Design',$1,'s',$2,$3) returning id`, [price, seller, status]);
  return r.rows[0].id;
}
const UTR = (n) => String(100000000000 + n);

// ================================================================= flag OFF: nothing changes
await inTxn(async () => {
  await mkUsers();
  check("A01 the flag is seeded OFF", (await q(`select enabled from private.feature_flags where name='direct_upi_checkout'`)).rows[0]?.enabled === false);
  check("A02 direct_upi_checkout_enabled() is callable by anon and reports false", (await as("anon", null, null, `select public.direct_upi_checkout_enabled() v`)).rows[0]?.v === false);
  await seedSeller(U.s2, { identity: false });
  const L = await mkListing(U.s2);
  check("A03 flag OFF: get_direct_payment_target says disabled", (await val(U.b1, "get_direct_payment_target", L)).enabled === false);
  check("A04 flag OFF: submitting a claim is refused (feature_off)", msg(await rpc(U.b1, "submit_direct_payment_claim", L, UTR(1))) === "feature_off");
  const noId = await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','Claude','Design',10,'s',$1)`, [U.s1]);
  check("A05 flag OFF: a seller with no identity and no UPI can still create a listing (old behaviour)", !noId.err, noId.err?.message);
  const v1 = await au(U.s1, `select public.set_my_payout_vpa('seller.one@okbank') v`);
  check("A06 flag OFF: set_my_payout_vpa works without identity details (old behaviour)", !v1.err && v1.rows[0].v.outcome === "saved", v1.err?.message);
  const ins = await q(`insert into public.purchases (user_id, listing_id, amount, status, payment_method, razorpay_payment_id, platform_fee) values ($1,$2,100,'paid','upi','pay_A07',18) returning id`, [U.b1, L]);
  const el = await q(`select count(*)::int n from private.settlement_eligible(now() + interval '1 minute') where purchase_id = $1`, [ins.rows[0].id]);
  check("A07 a normal Razorpay purchase is still settlement-eligible", el.rows[0].n === 1);
});

// ================================================================= identity details
await inTxn(async () => {
  await mkUsers(); await flag(true);
  const r = await rpc(U.s1, "set_seller_identity_details", ...idArgs());
  check("B01 valid identity saves", !r.err && r.rows[0].v.outcome === "saved", r.err?.message);
  const row = (await au(U.s1, `select * from public.seller_identity_details where user_id = $1`, [U.s1])).rows[0];
  check("B02 values are normalised (email lower-case, phone 10 digits, PAN upper-case, country India)", row.contact_email === "asha@example.com" && row.phone_number === "9876543210" && row.pan_number === "ABCDE1234F" && row.country === "India", row);
  check("B03 only the ID TYPE and LAST 4 are stored; the full number is nowhere in the row", row.govt_id_type === "aadhaar" && row.govt_id_last4 === "0123" && !JSON.stringify(row).includes("234567890123") && !JSON.stringify(row).includes("2345 6789"), row);
  const aud = (await q(`select metadata::text m from public.audit_log where actor_id=$1 and action='seller_identity_set'`, [U.s1])).rows[0]?.m ?? "";
  check("B04 the audit entry has a masked PAN and no ID number, e-mail or phone", aud.includes("AB******4F") && !aud.includes("ABCDE1234F") && !aud.includes("0123") && !aud.includes("9876543210") && !aud.includes("example.com"), aud);
  check("B05 saving again reports 'updated'", (await val(U.s1, "set_seller_identity_details", ...idArgs({ first: "Asha B" }))).outcome === "updated");
  const bad = [
    ["invalid_first_name", { first: "" }], ["invalid_first_name", { first: "A1" }], ["invalid_last_name", { last: "  " }],
    ["invalid_email", { email: "nope" }], ["invalid_email", { email: "a@b" }],
    ["invalid_phone", { phone: "12345" }], ["invalid_phone", { phone: "5876543210" }],
    ["invalid_address", { addr: "ab" }], ["invalid_address", { addr: "x<script>yy" }],
    ["invalid_country", { country: "Nepal" }],
    ["invalid_pan", { pan: "ABCDE12345" }], ["invalid_pan", { pan: "ABCD1234F" }], ["invalid_pan", { pan: "" }],
    ["invalid_id_type", { type: "licence" }],
    ["invalid_id_number", { num: "123456789012" }], ["invalid_id_number", { type: "voter_id", num: "AB1234567" }], ["invalid_id_number", { type: "passport", num: "12345678" }],
  ];
  for (const [code, o] of bad) { const e = await rpc(U.s1, "set_seller_identity_details", ...idArgs(o)); check(`B06 ${code} for ${JSON.stringify(o).slice(0, 40)}`, msg(e) === code && e.err.code === "CM077", e.err?.message); }
  check("B07 voter id and passport formats are accepted", !(await rpc(U.s1, "set_seller_identity_details", ...idArgs({ type: "voter_id", num: "ABC1234567" }))).err && !(await rpc(U.s1, "set_seller_identity_details", ...idArgs({ type: "passport", num: "K1234567" }))).err);
});
await inTxn(async () => {
  await mkUsers(); await flag(true);
  check("B08 phone forms 0XXXXXXXXXX and 91XXXXXXXXXX are accepted", !(await rpc(U.s1, "set_seller_identity_details", ...idArgs({ phone: "09876543210" }))).err && !(await rpc(U.s1, "set_seller_identity_details", ...idArgs({ phone: "919876543210" }))).err);
});
await inTxn(async () => {
  await mkUsers(); await flag(true);
  let last; for (let i = 0; i < 6; i++) last = await rpc(U.s1, "set_seller_identity_details", ...idArgs());
  check("B09 the 6th save in 24 hours is refused (too_many_changes)", msg(last) === "too_many_changes");
  check("B10 anon cannot call it", (await as("anon", null, null, `select public.set_seller_identity_details('a','b','c@d.ef','9876543210','12 Street','India','ABCDE1234F','aadhaar','234567890123')`)).err?.code === "42501");
  check("B11 a seller cannot write the table directly (insert/update/delete denied)", (await au(U.s1, `insert into public.seller_identity_details values ($1,'a','b','c@d.ef','9876543210','12 Street','India','ABCDE1234F','aadhaar','0123')`, [U.s1])).err?.code === "42501"
    && (await au(U.s1, `update public.seller_identity_details set pan_number='AAAAA0000A'`)).err?.code === "42501" && (await au(U.s1, `delete from public.seller_identity_details`)).err?.code === "42501");
});
await inTxn(async () => {
  await mkUsers(); await flag(true);
  await val(U.s1, "set_seller_identity_details", ...idArgs());
  check("B14 the owner can read their own details", (await au(U.s1, `select pan_number from public.seller_identity_details`)).rows[0]?.pan_number === "ABCDE1234F");
  check("B15 a buyer sees none", (await au(U.b1, `select 1 from public.seller_identity_details`)).rows.length === 0);
  check("B16 an admin WITHOUT the second factor sees none", (await as("authenticated", U.admin, { aal: "aal1" }, `select 1 from public.seller_identity_details`)).rows.length === 0);
  check("B17 an admin WITH the second factor sees it", (await as("authenticated", U.admin, AAL2, `select 1 from public.seller_identity_details`)).rows.length === 1);
});

// ================================================================= flag ON: step order and listing gate
await inTxn(async () => {
  await mkUsers(); await flag(true);
  const e = await au(U.s1, `select public.set_my_payout_vpa('seller.one@okbank')`);
  check("C01 flag ON: saving a UPI ID before identity details is refused (CM077 identity_required)", e.err?.code === "CM077" && msg(e) === "identity_required", e.err?.message);
  check("C02 nothing was saved by the refused attempt", (await q(`select 1 from public.seller_payout_accounts where user_id=$1`, [U.s1])).rows.length === 0);
  const g1 = await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','Claude','Design',10,'s',$1)`, [U.s1]);
  check("C03 flag ON: listing creation needs identity (CM079)", g1.err?.code === "CM079" && msg(g1) === "seller_setup_incomplete", g1.err?.message);
  await val(U.s1, "set_seller_identity_details", ...idArgs());
  const g2 = await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','Claude','Design',10,'s',$1)`, [U.s1]);
  check("C04 identity alone is not enough: a UPI ID is needed too", g2.err?.code === "CM079");
  const s = await au(U.s1, `select public.set_my_payout_vpa('seller.one@okbank') v`);
  check("C05 with identity saved, the UPI ID saves (first save: no cooldown)", !s.err && s.rows[0].v.outcome === "saved" && s.rows[0].v.upi_unlocks_at === null, s.err?.message);
  const g3 = await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('x','Claude','Design',10,'s',$1)`, [U.s1]);
  check("C06 identity + active UPI: the listing is created", !g3.err, g3.err?.message);
  await au(U.s1, `select public.set_my_payout_vpa('seller.new@okbank')`);
  const g4 = await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('y','Claude','Design',10,'s',$1)`, [U.s1]);
  check("C07 a CHANGED UPI ID blocks new listings until it matures (CM079 upi_in_cooldown)", g4.err?.code === "CM079" && msg(g4) === "upi_in_cooldown", g4.err?.message);
  await q(`update public.seller_payout_accounts set vpa_changed_at = now() - interval '73 hours' where user_id=$1`, [U.s1]);
  check("C08 after the cooldown the seller can list again", !(await au(U.s1, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('y','Claude','Design',10,'s',$1)`, [U.s1])).err);
  check("C09 the service role (no end user) is not blocked by the trigger", !(await as("service_role", null, null, `insert into public.listings (title, model, category, price, seller_name, seller_id) values ('z','Claude','Design',10,'s',$1)`, [U.s2])).err);
  const st = await val(U.s1, "my_direct_seller_status");
  check("C10 my_direct_seller_status reports flag, identity, UPI", st.flag_on === true && st.identity_complete === true && st.has_upi === true && st.upi_active === true && st.upi_unlocks_at === null, st);
  const st2 = await val(U.s2, "my_direct_seller_status");
  check("C11 …and an unprepared seller", st2.identity_complete === false && st2.has_upi === false, st2);
  check("C12 anon cannot read the seller status", (await as("anon", null, null, `select public.my_direct_seller_status()`)).err?.code === "42501");
});

// ================================================================= checkout lookup
await inTxn(async () => {
  await mkUsers(); await flag(true);
  await seedSeller(U.s1); await flag(true);
  const L = await mkListing(U.s1, 499.5);
  const t = await val(U.b1, "get_direct_payment_target", L);
  check("D01 an available listing returns the UPI ID, payee name and the price in paise", t.enabled && t.available && t.vpa === "asha@okhdfcbank" && t.payee_name === "Seller One" && t.amount_paise === 49950 && t.claim === null, t);
  check("D02 logged-out visitors cannot look up a UPI ID", (await as("anon", null, null, `select public.get_direct_payment_target($1)`, [L])).err?.code === "42501");
  check("D03 the seller cannot buy their own listing", (await val(U.s1, "get_direct_payment_target", L)).reason === "own_listing");
  const L2 = await mkListing(U.s1, 10, "pending_review");
  const t2 = await val(U.b1, "get_direct_payment_target", L2);
  check("D04 a listing that is not live is unavailable and reveals no UPI ID", t2.available === false && t2.reason === "listing_unavailable" && !JSON.stringify(t2).includes("okhdfcbank"), t2);
  await seedSeller(U.s2, { identity: false, vpa: "x.y@ybl" }); await flag(true);
  const L3 = await mkListing(U.s2);
  const t3 = await val(U.b1, "get_direct_payment_target", L3);
  check("D05 a seller without identity details is 'seller_not_ready' and the UPI ID is not revealed", t3.available === false && t3.reason === "seller_not_ready" && !JSON.stringify(t3).includes("ybl"), t3);
  await q(`update public.seller_payout_accounts set vpa_changed_at = now() - interval '5 hours' where user_id=$1`, [U.s1]);
  const t4 = await val(U.b1, "get_direct_payment_target", L);
  const unlock = new Date(t4.unlocks_at).getTime() - Date.now();
  check("D06 a UPI ID changed 5 hours ago is in cooldown: not revealed, unlock time ~67h away", t4.available === false && t4.reason === "upi_in_cooldown" && unlock > 66.9 * 3600e3 && unlock < 67.1 * 3600e3 && !JSON.stringify(t4).includes("okhdfcbank"), t4);
  await q(`update private.direct_upi_config set upi_cooldown_hours = 0`);
  check("D07 cooldown hours = 0 switches the cooldown off", (await val(U.b1, "get_direct_payment_target", L)).available === true);
  await q(`update private.direct_upi_config set upi_cooldown_hours = 72`);
  await q(`update public.seller_payout_accounts set status = 'suspended' where user_id=$1`, [U.s1]);
  check("D08 a suspended payout account makes the seller not ready", (await val(U.b1, "get_direct_payment_target", L)).reason === "seller_not_ready");
});

// ================================================================= claims, confirm, reject
await inTxn(async () => {
  await mkUsers(); await seedSeller(U.s1); await flag(true);
  const L = await mkListing(U.s1, 499.5), LB = await mkListing(U.s1, 100);
  const s1 = await rpc(U.b1, "submit_direct_payment_claim", L, " 1234 5678 9012 ");
  check("E01 a claim is created (pending, expires ~48h, spaces in the UTR ignored)", !s1.err && s1.rows[0].v.status === "pending" && Math.abs(new Date(s1.rows[0].v.expires_at) - Date.now() - 48 * 3600e3) < 60e3, s1.err?.message);
  const claim = (await q(`select * from public.direct_payment_claims where buyer_id=$1`, [U.b1])).rows[0];
  check("E02 the claim snapshots seller, amount in paise, UPI ID and UTR from the SERVER (not the client)", claim.seller_id === U.s1 && Number(claim.amount_paise) === 49950 && claim.vpa_address === "asha@okhdfcbank" && claim.utr === "123456789012", claim);
  for (const bad of ["12345", "abcdefghijkl", "1234567890123", ""]) check(`E03 invalid UTR '${bad}' refused`, msg(await rpc(U.b1, "submit_direct_payment_claim", LB, bad)) === "invalid_utr");
  check("E04 a second pending claim by the same buyer on the same listing is refused", msg(await rpc(U.b1, "submit_direct_payment_claim", L, UTR(2))) === "claim_already_pending");
  check("E05 the same UTR cannot be used by another buyer", msg(await rpc(U.b2, "submit_direct_payment_claim", L, "123456789012")) === "utr_already_used");
  check("E06 …nor on another listing", msg(await rpc(U.b2, "submit_direct_payment_claim", LB, "123456789012")) === "utr_already_used");
  check("E07 the seller cannot claim on their own listing", msg(await rpc(U.s1, "submit_direct_payment_claim", L, UTR(3))) === "own_listing");
  check("E08 a buyer sees only their own claims", (await au(U.b2, `select 1 from public.direct_payment_claims`)).rows.length === 0 && (await au(U.b1, `select 1 from public.direct_payment_claims`)).rows.length === 1);
  check("E09 the seller sees claims on their listings; another seller sees none", (await au(U.s1, `select 1 from public.direct_payment_claims`)).rows.length === 1 && (await au(U.s2, `select 1 from public.direct_payment_claims`)).rows.length === 0);
  check("E10 nobody can write the claims table directly", (await au(U.b1, `update public.direct_payment_claims set status='confirmed'`)).err?.code === "42501" && (await au(U.b1, `insert into public.direct_payment_claims (buyer_id, seller_id, listing_id, amount_paise, vpa_address, utr, expires_at) values ($1,$2,$3,1,'a@b','123456789099', now())`, [U.b1, U.s1, L])).err?.code === "42501");
  const tgt = await val(U.b1, "get_direct_payment_target", L);
  check("E11 the buyer's lookup includes their pending claim", tgt.claim?.status === "pending" && tgt.claim.overdue === false, tgt);
  const list = await val(U.s1, "seller_direct_claims");
  check("E12 the seller's desk lists the claim with buyer name, listing, amount and UTR", list.pending_count === 1 && list.claims[0].buyer_name === "Buyer One" && list.claims[0].amount_paise === 49950 && list.claims[0].utr === "123456789012" && list.claims[0].listing_title === "L", list);
  check("E13 another seller sees an empty desk", (await val(U.s2, "seller_direct_claims")).claims.length === 0);
  const cid = claim.id;
  check("E14 another seller cannot confirm or reject it (claim_not_found)", msg(await rpc(U.s2, "confirm_direct_payment_claim", cid)) === "claim_not_found" && msg(await rpc(U.s2, "reject_direct_payment_claim", cid)) === "claim_not_found");
  check("E15 the BUYER cannot confirm their own claim", msg(await rpc(U.b1, "confirm_direct_payment_claim", cid)) === "claim_not_found");
  const c1 = await rpc(U.s1, "confirm_direct_payment_claim", cid);
  check("E16 the seller confirms: outcome 'confirmed'", !c1.err && c1.rows[0].v.outcome === "confirmed", c1.err?.message);
  const p = (await q(`select * from public.purchases where id = $1`, [c1.rows[0]?.v?.purchase_id])).rows[0];
  check("E17 the purchase is paid, direct_upi, fee 0, amount 499.50, payment id direct_upi_<UTR>, for the buyer and listing", p && p.status === "paid" && p.payment_method === "direct_upi" && Number(p.platform_fee) === 0 && Number(p.amount) === 499.5 && p.razorpay_payment_id === "direct_upi_123456789012" && p.user_id === U.b1 && p.listing_id === L, p);
  const cl = (await q(`select status, purchase_id, decided_at from public.direct_payment_claims where id=$1`, [cid])).rows[0];
  check("E18 the claim is confirmed and linked to the purchase", cl.status === "confirmed" && cl.purchase_id === p.id && cl.decided_at);
  check("E19 confirming again is idempotent: no second purchase", (await val(U.s1, "confirm_direct_payment_claim", cid)).outcome === "already_confirmed" && (await q(`select count(*)::int n from public.purchases where listing_id=$1`, [L])).rows[0].n === 1);
  check("E20 the buyer can now read the purchase (library access path)", (await au(U.b1, `select 1 from public.purchases where listing_id=$1`, [L])).rows.length === 1);
  check("E21 the lookup now says already_purchased and a new claim is refused", (await val(U.b1, "get_direct_payment_target", L)).reason === "already_purchased" && msg(await rpc(U.b1, "submit_direct_payment_claim", L, UTR(4))) === "already_purchased");
  check("E22 a confirmed claim cannot be rejected", msg(await rpc(U.s1, "reject_direct_payment_claim", cid)) === "claim_not_pending");
  const aud = (await q(`select string_agg(metadata::text, ' ') m from public.audit_log where action like 'direct_claim_%'`)).rows[0].m;
  check("E23 the audit log records submit + confirm with only the last 4 digits of the UTR", /direct_claim_submitted/.test((await q(`select string_agg(action,' ') a from public.audit_log`)).rows[0].a) && aud.includes('"9012"') && !aud.includes("123456789012"), aud);
  // settlement isolation
  const el = await q(`select count(*)::int n from private.settlement_eligible(now() + interval '1 minute') where purchase_id = $1`, [p.id]);
  check("E24 the direct sale is NOT settlement-eligible", el.rows[0].n === 0);
  const prev = await as("authenticated", U.admin, AAL2, `select public.admin_settlement_pending() v`);
  check("E25 the admin settlement preview does not include it", !prev.err && JSON.stringify(prev.rows[0].v).includes("499") === false && Number(prev.rows[0].v.totals?.payable_paise ?? 0) === 0, prev.rows[0]?.v?.totals);
});

await inTxn(async () => {
  await mkUsers(); await seedSeller(U.s1); await flag(true);
  const L = await mkListing(U.s1, 50);
  const c = (await val(U.b1, "submit_direct_payment_claim", L, UTR(10))).claim_id;
  const r = await rpc(U.s1, "reject_direct_payment_claim", c, "  Not received  ");
  check("F01 the seller rejects with a reason (trimmed)", !r.err && r.rows[0].v.outcome === "rejected" && (await q(`select reject_reason from public.direct_payment_claims where id=$1`, [c])).rows[0].reject_reason === "Not received");
  check("F02 rejecting again is idempotent; confirming a rejected claim is refused", (await val(U.s1, "reject_direct_payment_claim", c)).outcome === "already_rejected" && msg(await rpc(U.s1, "confirm_direct_payment_claim", c)) === "claim_not_pending");
  check("F03 no purchase was created", (await q(`select count(*)::int n from public.purchases where listing_id=$1`, [L])).rows[0].n === 0);
  const t = await val(U.b1, "get_direct_payment_target", L);
  check("F04 the buyer sees the rejection and may submit a fresh claim (even with the same UTR)", t.claim.status === "rejected" && t.claim.reject_reason === "Not received" && !(await rpc(U.b1, "submit_direct_payment_claim", L, UTR(10))).err);
  const c2 = (await val(U.b2, "submit_direct_payment_claim", L, UTR(11))).claim_id;
  check("F05 a reason over 200 characters is refused", msg(await rpc(U.s1, "reject_direct_payment_claim", c2, "x".repeat(201))) === "reason_too_long");
  // overdue handling
  await q(`update public.direct_payment_claims set expires_at = now() - interval '1 hour' where id=$1`, [c2]);
  const t2 = await val(U.b2, "get_direct_payment_target", L);
  check("F06 a pending claim past its window is reported overdue", t2.claim.status === "pending" && t2.claim.overdue === true);
  const lst = await val(U.s1, "seller_direct_claims");
  check("F07 the seller's list marks it overdue and still lists it", lst.claims.find((x) => x.id === c2)?.overdue === true);
  const c3 = await rpc(U.b2, "submit_direct_payment_claim", L, UTR(12));
  check("F08 a new claim supersedes an overdue one: the old one becomes 'expired'", !c3.err && (await q(`select status from public.direct_payment_claims where id=$1`, [c2])).rows[0].status === "expired");
  check("F09 an expired claim can no longer be confirmed", msg(await rpc(U.s1, "confirm_direct_payment_claim", c2)) === "claim_not_pending");
  // overdue but not superseded can still be confirmed (late confirmation)
  const L2 = await mkListing(U.s1, 20);
  const c4 = (await val(U.b3, "submit_direct_payment_claim", L2, UTR(13))).claim_id;
  await q(`update public.direct_payment_claims set expires_at = now() - interval '1 day' where id=$1`, [c4]);
  check("F10 a seller may still confirm a late (overdue, not superseded) claim", (await val(U.s1, "confirm_direct_payment_claim", c4)).outcome === "confirmed");
  // buyer already owns
  const L3 = await mkListing(U.s1, 30);
  const c5 = (await val(U.b1, "submit_direct_payment_claim", L3, UTR(14))).claim_id;
  await q(`insert into public.purchases (user_id, listing_id, amount, status, payment_method, razorpay_payment_id, platform_fee) values ($1,$2,30,'paid','upi','pay_F11',5.4)`, [U.b1, L3]);
  check("F11 if the buyer already owns the listing (bought another way), confirming is refused (buyer_already_owns)", msg(await rpc(U.s1, "confirm_direct_payment_claim", c5)) === "buyer_already_owns");
  // flag switched off afterwards: pending claims are never stranded
  const L4 = await mkListing(U.s1, 40);
  const c6 = (await val(U.b3, "submit_direct_payment_claim", L4, UTR(15))).claim_id;
  await flag(false);
  check("F12 with the flag OFF a pending claim can still be confirmed (nothing is stranded)", (await val(U.s1, "confirm_direct_payment_claim", c6)).outcome === "confirmed");
  check("F13 …but no NEW claim can be submitted", msg(await rpc(U.b1, "submit_direct_payment_claim", L4, UTR(16))) === "feature_off");
});
await inTxn(async () => {
  await mkUsers(); await seedSeller(U.s1); await flag(true);
  let last;
  for (let i = 0; i < 11; i++) { const L = await mkListing(U.s1, 10 + i); last = await rpc(U.b1, "submit_direct_payment_claim", L, UTR(100 + i)); }
  check("G01 the 11th claim within 24 hours is refused (too_many_claims)", msg(last) === "too_many_claims");
  check("G02 the claim list limit is validated", msg(await rpc(U.s1, "seller_direct_claims", 0)) === "invalid_limit" && msg(await rpc(U.s1, "seller_direct_claims", 201)) === "invalid_limit");
});

// ================================================================= privileges and shape
await inTxn(async () => {
  const fns = ["set_seller_identity_details(text, text, text, text, text, text, text, text, text)", "get_direct_payment_target(uuid)", "submit_direct_payment_claim(uuid, text)", "confirm_direct_payment_claim(uuid)", "reject_direct_payment_claim(uuid, text)", "seller_direct_claims(integer)", "my_direct_seller_status()"];
  for (const f of fns) {
    const p = (await q(`select has_function_privilege('anon', 'public.${f}', 'execute') a, has_function_privilege('authenticated', 'public.${f}', 'execute') u`)).rows[0];
    check(`H01 public.${f.split("(")[0]}: not executable by anon, executable by authenticated`, p.a === false && p.u === true, p);
  }
  for (const f of ["private.direct_upi_enabled()", "private.seller_identity_complete(uuid)", "private.direct_target(uuid, uuid)", "private.require_seller_ready()"]) {
    const p = (await q(`select has_function_privilege('authenticated', '${f}', 'execute') u, has_function_privilege('anon', '${f}', 'execute') a`)).rows[0];
    check(`H02 ${f} is not callable by anon/authenticated`, !p.u && !p.a, p);
  }
  const defs = (await q(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1)`, [["set_seller_identity_details", "get_direct_payment_target", "submit_direct_payment_claim", "confirm_direct_payment_claim", "reject_direct_payment_claim", "seller_direct_claims", "my_direct_seller_status", "direct_upi_checkout_enabled", "set_my_payout_vpa"]])).rows;
  check("H03 every new/changed public function is SECURITY DEFINER with an empty search_path", defs.length === 9 && defs.every((d) => d.prosecdef && (d.proconfig ?? []).includes('search_path=""')), defs);
  check("H04 the listings trigger exists", (await q(`select 1 from pg_trigger where tgname='listings_require_seller_ready' and not tgisinternal`)).rows.length === 1);
  check("H05 RLS is on for both new tables", (await q(`select relname from pg_class where relname in ('seller_identity_details','direct_payment_claims') and relrowsecurity`)).rows.length === 2);
  check("H06 anon has no table privileges on either", (await q(`select has_table_privilege('anon','public.seller_identity_details','select') a, has_table_privilege('anon','public.direct_payment_claims','select') b`)).rows.every((r) => !r.a && !r.b));
  check("H07 the 5.7 cooldown setting is untouched by this feature (separate direct_upi_config row)", (await q(`select (select upi_cooldown_hours from private.settlement_config where id) a, (select upi_cooldown_hours from private.direct_upi_config where id) b`)).rows[0].b === 72);
});

await client.end();
console.log(`\nA63-D: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
