// A44 -- Milestone 4.4 database tests: seller studio + admin review (migration 20260930100800).
// Every test runs in a transaction that is ROLLED BACK.   Run:  DATABASE_URL=... node tests/phase4/m44-db.test.mjs
import pg from "pg";
import { validateDraft, draftToConfig } from "../../lib/studio/demo-draft.js";

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
const HAIKU = "claude-haiku-4-5-20251001", SONNET = "claude-sonnet-4-6";
const id = (n) => `00000000-0000-0000-0000-0000000fff${n}`;
const U = { seller: id(81), other: id(82), admin: id(83), buyer: id(84), refunded: id(85), stranger: id(86), sellerAdmin: id(87) };
const step = (o = {}) => ({ id: "s1", model: HAIKU, system: "You are the SECRET-M44-PROMPT assistant.", maxOutputTokens: 300, timeoutSeconds: 20, ...o });
const CFG = (steps = [step()]) => ({ steps });
const SHA = "a".repeat(64), SHA2 = "b".repeat(64);
const AAL2 = { aal: "aal2" };

async function inTxn(fn) { await q("BEGIN"); try { await fn(); } finally { await q("ROLLBACK"); } }
async function mkUsers() {
  for (const uid of Object.values(U)) await q(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [uid, `a44-${uid.slice(-2)}@example.invalid`]);
  await q(`update public.profiles set is_admin = true where id in ($1,$2)`, [U.admin, U.sellerAdmin]);
}
async function setFlags(on = true) {
  await q(`update private.feature_flags set enabled=$1 where name in ('phase3_execution','phase4_demo')`, [on]);
}
async function mkListing({ seller = U.seller, status = "live", type = "workflow" } = {}) {
  await mkUsers();
  const { rows: [l] } = await q(`insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, configuration)
     values ('A44 listing','n','n',0,'Sam Seller',$1,$2,$3,'{}'::jsonb) returning id`, [seller, status, type]);
  return l.id;
}
async function as(role, uid, claims, sql, params) {
  await q(`select set_config('request.jwt.claims',$1,true)`, [JSON.stringify({ ...(uid ? { sub: uid } : {}), role, ...(claims ?? {}) })]);
  await q(`set local role ${role}`);
  await q("SAVEPOINT r");
  try { const r = await q(sql, params); await q("RELEASE SAVEPOINT r"); return { rows: r.rows, rowCount: r.rowCount, err: null }; }
  catch (e) { await q("ROLLBACK TO SAVEPOINT r"); return { rows: [], rowCount: 0, err: e }; }
  finally { await q("reset role"); await q(`select set_config('request.jwt.claims','',true)`); }
}
const rpc = (role, uid, claims, fn, ...args) =>
  as(role, uid, claims, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) as v`, args);
const seller = (fn, ...a) => rpc("authenticated", U.seller, null, fn, ...a);
const admin = (fn, ...a) => rpc("authenticated", U.admin, AAL2, fn, ...a);
const code = (r) => r.err?.code;
const jc = (o) => JSON.stringify(o);
const path = (lid, name = "bp.json", s = U.seller) => `${s}/${lid}/${name}`;
async function putObject(p, size = 1234) {
  await q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('listing-blueprints',$1,$2,$3::jsonb)`, [p, p.split("/")[0], jc({ size })]);
}
async function saveReady(lid, cfg = CFG(), sample = "Summarise this: hello") {
  const r = await seller("save_listing_demo", lid, jc(cfg), sample, true);
  if (r.err) throw r.err; return r.rows[0].v;
}
async function submitDemo(lid) { const r = await seller("submit_listing_demo_for_review", lid); if (r.err) throw r.err; return r.rows[0].v; }
const demoRow = async (lid) => (await q(`select * from public.listing_demos where listing_id=$1`, [lid])).rows[0];
const audit = async (lid) => (await q(`select action from public.review_audit where listing_id=$1 order by id`, [lid])).rows.map(r => r.action);

// =================================================================== schema + privileges
{
  const cols = (await q(`select column_name from information_schema.columns where table_schema='public' and table_name='listing_demos'`)).rows.map(r => r.column_name);
  check("A44-S01 listing_demos has the review columns", ["sample_input", "review_status", "review_note", "submitted_at", "reviewed_at", "reviewed_by", "config_version"].every(c => cols.includes(c)), cols);
  const pub = ["list_demo_models()", "save_listing_demo(uuid,jsonb,text,boolean)", "submit_listing_demo_for_review(uuid)", "submit_listing_blueprint(uuid,text,text,text,integer,jsonb)",
    "admin_review_queue(integer)", "admin_get_demo_for_review(uuid)", "admin_get_blueprint_for_review(uuid)", "review_listing_demo(uuid,text,integer,text)", "review_listing_blueprint(uuid,text,text,text)"];
  const priv = async (r, f) => val(`select has_function_privilege($1,$2,'execute') as v`, [r, `public.${f}`]);
  let ok = true, why = [];
  for (const f of pub) {
    const a = await priv("authenticated", f), an = await priv("anon", f), sr = await priv("service_role", f);
    if (!a || an || sr) { ok = false; why.push(f); }
  }
  check("A44-P01 every new public RPC: authenticated yes, anon NO, service_role NO", ok, why);
  const secdef = (await q(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
     and p.proname = any($1)`, [["list_demo_models", "save_listing_demo", "submit_listing_demo_for_review", "submit_listing_blueprint", "admin_review_queue", "admin_get_demo_for_review", "admin_get_blueprint_for_review", "review_listing_demo", "review_listing_blueprint"]])).rows;
  check("A44-P02 every new public RPC is SECURITY DEFINER with search_path=''", secdef.length === 9 && secdef.every(r => r.prosecdef && (r.proconfig ?? []).some(c => /search_path=""|search_path=''/.test(c))), secdef);
  const owner = ["private.review_audit_immutable()", "private.write_review_audit(text,text,uuid,text,text,jsonb)", "private.listings_guard_blueprint()"];
  let o2 = true;
  for (const f of owner) for (const r of ["anon", "authenticated", "service_role"]) if (await val(`select has_function_privilege($1,$2,'execute') as v`, [r, f])) o2 = false;
  check("A44-P03 audit writer + triggers are owner-only", o2);
  const helpers = ["private.is_current_blueprint(text)", "private.is_pending_blueprint(text)", "private.can_download_blueprint(text,uuid)"];
  let h = true;
  for (const f of helpers) { if (!(await val(`select has_function_privilege('authenticated',$1,'execute') as v`, [f])) || (await val(`select has_function_privilege('anon',$1,'execute') as v`, [f])) || (await val(`select has_function_privilege('service_role',$1,'execute') as v`, [f]))) h = false; }
  check("A44-P04 storage-policy helpers: authenticated only (they return a boolean)", h);
  check("A44-P05 listing_demo_info and set_listing_demo_approval keep their grants (create or replace)",
    await val(`select has_function_privilege('anon','public.listing_demo_info(uuid)','execute') as v`)
    && await val(`select has_function_privilege('authenticated','public.set_listing_demo_approval(uuid,boolean)','execute') as v`)
    && !(await val(`select has_function_privilege('anon','public.set_listing_demo_approval(uuid,boolean)','execute') as v`)));
  const tbl = async (t, r, p) => val(`select has_table_privilege($1,$2,$3) as v`, [r, t, p]);
  check("A44-P06 review_audit and blueprint_submissions: authenticated can only SELECT; anon / service_role nothing",
    await tbl("public.review_audit", "authenticated", "select") && !(await tbl("public.review_audit", "authenticated", "insert")) && !(await tbl("public.review_audit", "authenticated", "update"))
    && !(await tbl("public.blueprint_submissions", "authenticated", "insert")) && !(await tbl("public.blueprint_submissions", "authenticated", "update")) && !(await tbl("public.blueprint_submissions", "authenticated", "delete"))
    && !(await tbl("public.review_audit", "anon", "select")) && !(await tbl("public.blueprint_submissions", "anon", "select")) && !(await tbl("public.review_audit", "service_role", "select")));
  check("A44-P07 RLS is enabled on both new tables", (await q(`select relrowsecurity from pg_class where oid in ('public.review_audit'::regclass,'public.blueprint_submissions'::regclass)`)).rows.every(r => r.relrowsecurity));
  const cm = (await q(`select (regexp_matches(pg_get_functiondef(p.oid), 'CM0[0-9]{2}', 'g'))[1] as c from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1)`, [["save_listing_demo", "review_listing_demo", "review_listing_blueprint", "submit_listing_blueprint"]])).rows.map(r => r.c);
  check("A44-P08 new RPCs raise only CM051..CM062 plus the existing CM001/CM002 config errors", cm.length > 0 && cm.every(c => /^CM05[1-9]$|^CM06[0-2]$|^CM00[12]$/.test(c)) , [...new Set(cm)]);
}

// =================================================================== seller: save / submit
await inTxn(async () => {
  const lid = await mkListing();
  let r = await seller("list_demo_models");
  const models = r.rows[0]?.v ?? [];
  check("A44-M01 list_demo_models returns active models only, no prices", models.length === 2 && models[0].model === HAIKU && models[0].isDefault === true && !/inr|usd|price/i.test(jc(models)), models);
  check("A44-M02 list_demo_models needs a signed-in user", code(await rpc("anon", null, null, "list_demo_models")) === "42501");
  await q(`update private.model_pricing set is_active=false where model=$1`, [SONNET]);
  check("A44-M03 a deactivated model disappears from the list", ((await seller("list_demo_models")).rows[0].v).length === 1);
  await q(`update private.model_pricing set is_active=true where model=$1`, [SONNET]);

  const s1 = await saveReady(lid);
  check("A44-D01 first save -> draft, configVersion 1, enabled", s1.reviewStatus === "draft" && s1.configVersion === 1 && s1.isEnabled === true, s1);
  const s2 = await saveReady(lid);
  check("A44-D02 saving identical content does NOT bump the version", s2.configVersion === 1, s2);
  const s3 = await saveReady(lid, CFG(), "A different sample");
  check("A44-D03 changing only the sample input bumps the version", s3.configVersion === 2, s3);
  const s4 = await saveReady(lid, CFG([step(), step({ id: "s2", model: SONNET })]), "A different sample");
  check("A44-D04 two steps are fine; changing the config bumps the version again", s4.configVersion === 3, s4);

  check("A44-D05 three steps -> CM001 (cap is 2)", code(await seller("save_listing_demo", lid, jc(CFG([step(), step({ id: "b" }), step({ id: "c" })])), "x", true)) === "CM001");
  check("A44-D06 an unknown key (e.g. a tool) -> CM002", code(await seller("save_listing_demo", lid, jc(CFG([{ ...step(), tools: ["x"] }])), "x", true)) === "CM002");
  check("A44-D07 a model that is not on the allowlist -> CM002", code(await seller("save_listing_demo", lid, jc(CFG([step({ model: "gpt-5" })])), "x", true)) === "CM002");
  check("A44-D08 blank / over-long sample input -> CM052",
    code(await seller("save_listing_demo", lid, jc(CFG()), "   \n ", true)) === "CM052" && code(await seller("save_listing_demo", lid, jc(CFG()), "x".repeat(2001), true)) === "CM052");
  check("A44-D09 a failed save changes nothing (version still 3)", (await demoRow(lid)).config_version === 3);
  check("A44-D10 another seller -> CM051; anonymous -> 28000/42501",
    code(await rpc("authenticated", U.other, null, "save_listing_demo", lid, jc(CFG()), "x", true)) === "CM051"
    && ["28000", "42501"].includes(code(await rpc("anon", null, null, "save_listing_demo", lid, jc(CFG()), "x", true))));
  const pb = await mkListing({ type: "playbook" });
  check("A44-D11 playbook listings cannot have demos -> CM053", code(await seller("save_listing_demo", pb, jc(CFG()), "x", true)) === "CM053");
  check("A44-D12 save -> not found for an unknown listing id (CM051)", code(await seller("save_listing_demo", "00000000-0000-4000-8000-00000000dead", jc(CFG()), "x", true)) === "CM051");

  const direct = await as("authenticated", U.seller, null, `update public.listing_demos set review_status='approved' where listing_id=$1`, [lid]);
  const direct2 = await as("authenticated", U.seller, null, `update public.listing_demos set approved_at=now() where listing_id=$1`, [lid]);
  const direct3 = await as("authenticated", U.seller, null, `update public.listing_demos set sample_input='sneaky' where listing_id=$1`, [lid]);
  check("A44-D13 a seller cannot write review_status / approved_at / sample_input directly (column grants)", [direct, direct2, direct3].every(x => code(x) === "42501"), [direct.err?.message, direct2.err?.message, direct3.err?.message]);
  const ins = await as("authenticated", U.seller, null, `insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [pb, jc(CFG())]);
  check("A44-D14 direct INSERT by a seller still works (4.2 grant) but always lands as draft with no approval", ins.err === null && (await demoRow(pb)).review_status === "draft" && (await demoRow(pb)).approved_at === null);
});
await inTxn(async () => {
  const lid = await mkListing();
  check("A44-D15 submitting with no demo -> CM054", code(await seller("submit_listing_demo_for_review", lid)) === "CM054");
  await seller("save_listing_demo", lid, jc(CFG()), null, true);
  check("A44-D16 submitting without a sample input -> CM054", code(await seller("submit_listing_demo_for_review", lid)) === "CM054");
  await saveReady(lid);
  await seller("save_listing_demo", lid, jc(CFG()), "Summarise this: hello", false);
  check("A44-D17 submitting a DISABLED demo -> CM054", code(await seller("submit_listing_demo_for_review", lid)) === "CM054");
  await saveReady(lid);
  check("A44-D18 another seller cannot submit -> CM051", code(await rpc("authenticated", U.other, null, "submit_listing_demo_for_review", lid)) === "CM051");
  const s = await submitDemo(lid);
  const d = await demoRow(lid);
  check("A44-D19 submit -> pending_admin_approval with submitted_at, still NOT approved", s.reviewStatus === "pending_admin_approval" && d.submitted_at !== null && d.approved_at === null, s);
  check("A44-D20 submitting twice -> CM055", code(await seller("submit_listing_demo_for_review", lid)) === "CM055");
  await seller("save_listing_demo", lid, jc(CFG()), "Edited while pending", true);
  const e = await demoRow(lid);
  check("A44-D21 editing while pending withdraws the submission: draft, version bumped, submitted_at cleared", e.review_status === "draft" && e.config_version === 3 && e.submitted_at === null, e);
  check("A44-D22 submission is audited", (await audit(lid)).join() === "demo_submitted");
});

// =================================================================== admin review: demos
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  await saveReady(lid); await submitDemo(lid);
  for (const [label, who] of [["anon", () => rpc("anon", null, null, "admin_review_queue")], ["seller", () => seller("admin_review_queue")],
    ["admin without MFA (aal1)", () => rpc("authenticated", U.admin, { aal: "aal1" }, "admin_review_queue")], ["admin with no aal claim", () => rpc("authenticated", U.admin, null, "admin_review_queue")]]) {
    check(`A44-A01 admin_review_queue refused for ${label} (42501)`, code(await who()) === "42501");
  }
  let all = true;
  for (const [fn, args] of [["admin_get_demo_for_review", [lid]], ["review_listing_demo", [lid, "approve", 1, null]], ["review_listing_blueprint", [lid, "approve", SHA, null]], ["admin_get_blueprint_for_review", [lid]]]) {
    for (const who of [() => seller(fn, ...args), () => rpc("authenticated", U.admin, { aal: "aal1" }, fn, ...args)]) if (code(await who()) !== "42501") all = false;
  }
  check("A44-A02 every admin RPC refuses a seller and an admin without aal2 BEFORE touching anything", all);
  check("A44-A03 ...and nothing changed", (await demoRow(lid)).review_status === "pending_admin_approval");

  const qr = (await admin("admin_review_queue")).rows[0].v;
  check("A44-A04 queue lists the pending demo (no prompts, no sample text)", qr.demos.length === 1 && qr.demos[0].listingId === lid && qr.demos[0].stepCount === 1 && qr.demos[0].title === "A44 listing" && !jc(qr).includes("SECRET-M44-PROMPT") && qr.blueprints.length === 0, qr);
  const det = (await admin("admin_get_demo_for_review", lid)).rows[0].v;
  check("A44-A05 the detail view DOES show the prompts + sample + version (the reviewer must see what they approve)", det.demoConfig.steps[0].system.includes("SECRET-M44-PROMPT") && det.sampleInput === "Summarise this: hello" && det.configVersion === 1, det);
  check("A44-A06 unknown demo -> CM062", code(await admin("admin_get_demo_for_review", "00000000-0000-4000-8000-00000000dead")) === "CM062");

  check("A44-A07 bad decision -> CM061", code(await admin("review_listing_demo", lid, "maybe", 1, null)) === "CM061");
  check("A44-A08 reject without a note / with a short note -> CM057", code(await admin("review_listing_demo", lid, "reject", 1, null)) === "CM057" && code(await admin("review_listing_demo", lid, "reject", 1, "too short")) === "CM057");
  check("A44-A09 stale version -> CM056 and nothing changes", code(await admin("review_listing_demo", lid, "approve", 7, null)) === "CM056" && (await demoRow(lid)).review_status === "pending_admin_approval");
  check("A44-A10 before approval the public sees NO demo", (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v.available === false);

  const rej = await admin("review_listing_demo", lid, "reject", 1, "  Prompt 1 asks for private data; please remove.  ");
  const dr = await demoRow(lid);
  check("A44-A11 reject -> rejected, note trimmed + kept, approved_at stays NULL", rej.err === null && dr.review_status === "rejected" && dr.approved_at === null && dr.review_note === "Prompt 1 asks for private data; please remove." && dr.reviewed_by === U.admin, dr);
  check("A44-A12 a rejected demo is not available and is not in the queue again", (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v.available === false && (await admin("admin_review_queue")).rows[0].v.demos.length === 0);
  check("A44-A13 approving a non-pending demo -> CM055", code(await admin("review_listing_demo", lid, "approve", 1, null)) === "CM055");

  await seller("save_listing_demo", lid, jc(CFG()), "Fixed sample", true);
  check("A44-A14 the seller's fix resets rejected -> draft (version 2) and clears the note", (await demoRow(lid)).review_status === "draft" && (await demoRow(lid)).review_note === null && (await demoRow(lid)).config_version === 2);
  await submitDemo(lid);
  check("A44-A15 an approve decision made against the OLD version is stale (CM056)", code(await admin("review_listing_demo", lid, "approve", 1, null)) === "CM056");
  const ok = await admin("review_listing_demo", lid, "approve", 2, "Looks fine");
  const da = await demoRow(lid);
  check("A44-A16 approve -> approved, approved_at/by set, reviewed_by set", ok.err === null && da.review_status === "approved" && da.approved_at !== null && da.approved_by === U.admin && da.reviewed_by === U.admin, da);
  const pub = (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v;
  check("A44-A17 only now is the demo surfaced: available, with the approved sampleInput, and still no prompt", pub.available === true && pub.sampleInput === "Fixed sample" && !jc(pub).includes("SECRET-M44-PROMPT") && Object.keys(pub).sort().join() === "available,budgetExhausted,maxInputChars,remainingToday,runsPerDay,sampleInput,stepNames", pub);
  const run = await as("authenticated", U.buyer, null, `select public.start_demo_run($1,$2::jsonb) as v`, [lid, jc({ text: "hi" })]);
  check("A44-A18 an approved demo can actually be started (the 4.2 gate reads approved_at)", run.err === null && !!run.rows[0]?.v, run.err?.message);

  await seller("save_listing_demo", lid, jc(CFG()), "Sneaky post-approval edit", true);
  const after = await demoRow(lid);
  check("A44-A19 ANY content edit after approval withdraws it at once: draft, approved_at NULL", after.review_status === "draft" && after.approved_at === null && after.config_version === 3, after);
  check("A44-A20 ...and the public demo disappears; start_demo_run refuses (CM031)",
    (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v.available === false
    && code(await as("authenticated", U.stranger, null, `select public.start_demo_run($1,$2::jsonb) as v`, [lid, jc({ text: "hi" })])) === "CM031");
  const a = await audit(lid);
  check("A44-A21 audit trail: submitted, rejected, submitted, approved (in order)", a.join() === "demo_submitted,demo_rejected,demo_submitted,demo_approved", a);
  check("A44-A22 admin can read the audit; the seller cannot",
    (await as("authenticated", U.admin, AAL2, `select count(*)::int as n from public.review_audit where listing_id=$1`, [lid])).rows[0].n === 4
    && (await as("authenticated", U.seller, null, `select count(*)::int as n from public.review_audit where listing_id=$1`, [lid])).rows[0].n === 0);
  const u1 = await q("SAVEPOINT x").then(() => q(`update public.review_audit set note='x'`)).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT x");
  const u2 = await q("SAVEPOINT x").then(() => q(`delete from public.review_audit`)).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT x");
  check("A44-A23 audit rows cannot be updated or deleted", u1?.code === "42501" && u2?.code === "42501", [u1?.message, u2?.message]);
});
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing({ seller: U.sellerAdmin });
  await rpc("authenticated", U.sellerAdmin, AAL2, "save_listing_demo", lid, jc(CFG()), "sample", true);
  await rpc("authenticated", U.sellerAdmin, AAL2, "submit_listing_demo_for_review", lid);
  check("A44-A24 an admin cannot review their OWN listing (CM060)", code(await rpc("authenticated", U.sellerAdmin, AAL2, "review_listing_demo", lid, "approve", 1, null)) === "CM060");
  check("A44-A25 ...another admin can", (await admin("review_listing_demo", lid, "approve", 1, null)).err === null);
});
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  await saveReady(lid); await submitDemo(lid);
  await q(`update private.model_pricing set is_active=false where model=$1`, [HAIKU]);
  check("A44-A26 approve re-validates the config: a model deactivated while pending -> CM002, nothing approved", code(await admin("review_listing_demo", lid, "approve", 1, null)) === "CM002" && (await demoRow(lid)).review_status === "pending_admin_approval");
  await q(`update private.model_pricing set is_active=true where model=$1`, [HAIKU]);
  await seller("save_listing_demo", lid, jc(CFG()), "Summarise this: hello", false);   // disable while pending
  check("A44-A27 a demo disabled while pending cannot be approved (CM054)", code(await admin("review_listing_demo", lid, "approve", 1, null)) === "CM054");
});

// =================================================================== legacy approval path + constraints
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  await saveReady(lid);
  check("A44-L01 set_listing_demo_approval still needs admin + MFA", code(await rpc("authenticated", U.admin, { aal: "aal1" }, "set_listing_demo_approval", lid, true)) === "42501");
  check("A44-L02 legacy approve works from draft and keeps review_status consistent", (await rpc("authenticated", U.admin, AAL2, "set_listing_demo_approval", lid, true)).err === null && (await demoRow(lid)).review_status === "approved" && (await demoRow(lid)).approved_at !== null);
  await rpc("authenticated", U.admin, AAL2, "set_listing_demo_approval", lid, false);
  check("A44-L03 legacy revoke -> draft, approval cleared", (await demoRow(lid)).review_status === "draft" && (await demoRow(lid)).approved_at === null);
  check("A44-L04 both legacy actions are audited", (await audit(lid)).join() === "demo_approval_set,demo_approval_revoked");
  await q(`update public.listing_demos set approved_at = now(), approved_by=$2 where listing_id=$1`, [lid, U.admin]);
  check("A44-L05 an owner script that only sets approved_at (4.2 style) is normalised to 'approved'", (await demoRow(lid)).review_status === "approved");
  await q(`update public.listing_demos set approved_at = null where listing_id=$1`, [lid]);
  check("A44-L06 clearing approved_at normalises back to draft", (await demoRow(lid)).review_status === "draft");
  await q("SAVEPOINT c");
  const bad = await q(`update public.listing_demos set review_status='approved', approved_at=null where listing_id=$1`, [lid]).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT c");
  check("A44-L07 the CHECK constraint is a real backstop: approved without approved_at is impossible", bad?.code === "23514" || bad === null && false, bad?.message);
  await q("SAVEPOINT c");
  const bad2 = await q(`update public.listing_demos set review_status='bogus' where listing_id=$1`, [lid]).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT c");
  check("A44-L08 unknown review_status values are rejected", bad2?.code === "23514", bad2?.message);
  await q(`update public.listing_demos set is_enabled=false where listing_id=$1`, [lid]);
  await q(`update private.model_pricing set is_active=false where model=$1`, [HAIKU]);
  const dis = await q("SAVEPOINT c").then(() => q(`update public.listing_demos set is_enabled=false, updated_at=now() where listing_id=$1`, [lid])).then(() => null, (e) => e);
  check("A44-L09 non-content writes (e.g. disabling) are NOT blocked by a model deactivated since approval", dis === null, dis?.message);
});

// =================================================================== blueprints
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const other = await mkListing({ seller: U.other });
  const p = path(lid);
  await putObject(p, 1234);
  const sub = (...o) => seller("submit_listing_blueprint", ...[lid, p, "n8n", SHA, 1234, jc({ blocking: 0 })].map((v, i) => o[i] ?? v));
  check("A44-B01 non-owner -> CM051", code(await rpc("authenticated", U.other, null, "submit_listing_blueprint", lid, p, "n8n", SHA, 1234, "{}")) === "CM051");
  check("A44-B02 anon refused", ["28000", "42501"].includes(code(await rpc("anon", null, null, "submit_listing_blueprint", lid, p, "n8n", SHA, 1234, "{}"))));
  check("A44-B03 bad format / hash / size -> CM058",
    [code(await sub(undefined, undefined, "excel")), code(await sub(undefined, undefined, undefined, "xyz")), code(await sub(undefined, undefined, undefined, undefined, 0)), code(await sub(undefined, undefined, undefined, undefined, 5242881)), code(await sub(undefined, undefined, undefined, SHA.toUpperCase()))].every(c => c === "CM058"));
  check("A44-B04 a path outside the caller's folder, or for another listing, or with a bad shape -> CM058",
    code(await sub(undefined, path(lid, "bp.json", U.other))) === "CM058" && code(await sub(undefined, path(other))) === "CM058"
    && code(await sub(undefined, `${U.seller}/${lid}/../x.json`)) === "CM058" && code(await sub(undefined, `${U.seller}/${lid}/bp.txt`)) === "CM058");
  check("A44-B05 an object that is not in the bucket -> CM058", code(await sub(undefined, path(lid, "missing.json"))) === "CM058");
  check("A44-B06 a size that disagrees with Storage's own record -> CM058", code(await sub(undefined, undefined, undefined, undefined, 999)) === "CM058");
  check("A44-B07 a non-object scan -> CM058", code(await seller("submit_listing_blueprint", lid, p, "n8n", SHA, 1234, "[]")) === "CM058");
  const ok = await sub();
  const id1 = ok.rows[0]?.v;
  check("A44-B08 a valid submission returns an id and is 'pending'; listings.blueprint_* is UNCHANGED", ok.err === null && !!id1
    && (await val(`select status as v from public.blueprint_submissions where id=$1`, [id1])) === "pending" && (await val(`select blueprint_path as v from public.listings where id=$1`, [lid])) === null);
  await putObject(path(lid, "bp2.json"), 2000);
  const ok2 = await seller("submit_listing_blueprint", lid, path(lid, "bp2.json"), "flowise", SHA2, 2000, "{}");
  const st = (await q(`select status from public.blueprint_submissions where listing_id=$1 order by submitted_at, id`, [lid])).rows.map(r => r.status).sort().join();
  check("A44-B09 a new submission supersedes the pending one (exactly one pending per listing)", ok2.err === null && st === "pending,superseded", st);
  check("A44-B10 the sellers see their submissions; other sellers do not",
    (await as("authenticated", U.seller, null, `select count(*)::int as n from public.blueprint_submissions`)).rows[0].n === 2
    && (await as("authenticated", U.other, null, `select count(*)::int as n from public.blueprint_submissions`)).rows[0].n === 0
    && (await as("authenticated", U.buyer, null, `select count(*)::int as n from public.blueprint_submissions`)).rows[0].n === 0);
  check("A44-B11 no one can write submissions directly", code(await as("authenticated", U.seller, null, `insert into public.blueprint_submissions (listing_id, seller_id, storage_path, format, sha256, size_bytes) values ($1,$2,$3,'n8n',$4,1)`, [lid, U.seller, p, SHA])) === "42501"
    && code(await as("authenticated", U.seller, null, `update public.blueprint_submissions set status='approved'`)) === "42501");
});
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const p = path(lid);
  await putObject(p, 500);
  const sid = (await seller("submit_listing_blueprint", lid, p, "n8n", SHA, 500, jc({ blocking: 0, warnings: 1 }))).rows[0].v;
  const qr = (await admin("admin_review_queue")).rows[0].v;
  check("A44-R01 the queue lists the pending blueprint (no hash/path)", qr.blueprints.length === 1 && qr.blueprints[0].submissionId === sid && qr.blueprints[0].format === "n8n" && !jc(qr.blueprints[0]).includes(SHA) && !jc(qr.blueprints[0]).includes(p), qr);
  const det = (await admin("admin_get_blueprint_for_review", sid)).rows[0].v;
  check("A44-R02 the detail view gives the admin the path + recorded hash to re-verify", det.storagePath === p && det.sha256 === SHA && det.scanSummary.warnings === 1, det);
  check("A44-R03 unknown submission -> CM062", code(await admin("admin_get_blueprint_for_review", "00000000-0000-4000-8000-00000000dead")) === "CM062");
  check("A44-R04 approve with NO / wrong / malformed verified hash -> CM059, nothing changes",
    [code(await admin("review_listing_blueprint", sid, "approve", null, null)), code(await admin("review_listing_blueprint", sid, "approve", SHA2, null)), code(await admin("review_listing_blueprint", sid, "approve", "nope", null))].every(c => c === "CM059")
    && (await val(`select blueprint_path as v from public.listings where id=$1`, [lid])) === null && (await val(`select status as v from public.blueprint_submissions where id=$1`, [sid])) === "pending");
  check("A44-R05 reject needs a note of >= 10 chars (CM057); bad decision CM061",
    code(await admin("review_listing_blueprint", sid, "reject", null, null)) === "CM057" && code(await admin("review_listing_blueprint", sid, "reject", null, "short")) === "CM057" && code(await admin("review_listing_blueprint", sid, "burn", SHA, null)) === "CM061");
  await q(`delete from storage.objects where name=$1`, [p]);
  check("A44-R06 approve when the object has vanished -> CM058", code(await admin("review_listing_blueprint", sid, "approve", SHA, null)) === "CM058");
  await putObject(p, 500);
  const ap = await admin("review_listing_blueprint", sid, "approve", SHA, "Verified");
  const l = (await q(`select blueprint_path, blueprint_format, blueprint_sha256, blueprint_size_bytes from public.listings where id=$1`, [lid])).rows[0];
  check("A44-R07 approve with the matching re-computed hash publishes the blueprint on the listing", ap.err === null && l.blueprint_path === p && l.blueprint_format === "n8n" && l.blueprint_sha256 === SHA && l.blueprint_size_bytes === 500, l);
  check("A44-R08 submission is approved with reviewer + time; the queue is empty again", (await q(`select status, reviewed_by, reviewed_at from public.blueprint_submissions where id=$1`, [sid])).rows[0].status === "approved" && (await admin("admin_review_queue")).rows[0].v.blueprints.length === 0);
  check("A44-R09 approving again -> CM055", code(await admin("review_listing_blueprint", sid, "approve", SHA, null)) === "CM055");
  check("A44-R10 the GUC does not stay on after the RPC (a later raw write is refused)",
    (await q(`select current_setting('chatmarket.blueprint_write', true) as v`)).rows[0].v === "off");

  // replace with a second blueprint
  const p2 = path(lid, "v2.json"); await putObject(p2, 700);
  const sid2 = (await seller("submit_listing_blueprint", lid, p2, "langflow", SHA2, 700, "{}")).rows[0].v;
  await admin("review_listing_blueprint", sid2, "approve", SHA2, null);
  check("A44-R11 a second approval replaces the live blueprint and supersedes the first", (await val(`select blueprint_path as v from public.listings where id=$1`, [lid])) === p2
    && (await val(`select status as v from public.blueprint_submissions where id=$1`, [sid])) === "superseded");
  const p3 = path(lid, "v3.json"); await putObject(p3, 800);
  const sid3 = (await seller("submit_listing_blueprint", lid, p3, "n8n", SHA, 800, "{}")).rows[0].v;
  const rj = await admin("review_listing_blueprint", sid3, "reject", null, "Contains a hard-coded webhook URL.");
  check("A44-R12 reject leaves the live blueprint untouched and records the note", rj.err === null && (await val(`select blueprint_path as v from public.listings where id=$1`, [lid])) === p2
    && (await val(`select review_note as v from public.blueprint_submissions where id=$1`, [sid3])) === "Contains a hard-coded webhook URL.");
  const a = await audit(lid);
  check("A44-R13 every step is audited", a.join() === "blueprint_submitted,blueprint_approved,blueprint_submitted,blueprint_approved,blueprint_submitted,blueprint_rejected", a);
});
await inTxn(async () => {
  const lid = await mkListing({ seller: U.sellerAdmin });
  const p = path(lid, "bp.json", U.sellerAdmin); await putObject(p, 10);
  const sid = (await rpc("authenticated", U.sellerAdmin, AAL2, "submit_listing_blueprint", lid, p, "n8n", SHA, 10, "{}")).rows[0].v;
  check("A44-R14 an admin cannot approve their own blueprint (CM060)", code(await rpc("authenticated", U.sellerAdmin, AAL2, "review_listing_blueprint", sid, "approve", SHA, null)) === "CM060");
});

// =================================================================== guard: listings.blueprint_* only through review
await inTxn(async () => {
  const lid = await mkListing();
  const upd = (role, uid, claims) => as(role, uid, claims, `update public.listings set blueprint_path=$2, blueprint_format='n8n', blueprint_sha256=$3, blueprint_size_bytes=5 where id=$1`, [lid, path(lid), SHA]);
  check("A44-G01 a seller cannot set blueprint_* on their own listing (42501)", code(await upd("authenticated", U.seller)) === "42501");
  check("A44-G02 an admin (aal2) cannot either, outside the review RPC", code(await upd("authenticated", U.admin, AAL2)) === "42501");
  const ins = await as("authenticated", U.seller, null, `insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type, blueprint_path, blueprint_format, blueprint_sha256, blueprint_size_bytes)
     values ('x','n','n',0,'x',$1,'pending_review','workflow',$2,'n8n',$3,5)`, [U.seller, path(lid), SHA]);
  check("A44-G03 a seller cannot INSERT a listing with blueprint_* pre-filled", code(ins) === "42501", ins.err?.message);
  await q(`select set_config('chatmarket.blueprint_write','on',true)`);
  check("A44-G04 the setting alone is not enough: as an API role with the GUC on it is still refused", code(await upd("authenticated", U.seller)) === "42501" && code(await upd("service_role", null)) === "42501");
  await q(`select set_config('chatmarket.blueprint_write','off',true)`);
  await q("SAVEPOINT g");
  const raw = await q(`update public.listings set blueprint_path=$2, blueprint_format='n8n', blueprint_sha256=$3, blueprint_size_bytes=5 where id=$1`, [lid, path(lid), SHA]).then(() => null, (e) => e);
  await q("ROLLBACK TO SAVEPOINT g");
  check("A44-G05 even the owner role is refused without the review RPC's setting", raw?.code === "42501", raw?.message);
  check("A44-G06 ordinary listing updates (title, price) are unaffected", (await as("authenticated", U.seller, null, `update public.listings set title='New title', price=5 where id=$1`, [lid])).err === null);
  check("A44-G07 writing blueprint_* with an unchanged value is not a change", (await as("authenticated", U.seller, null, `update public.listings set blueprint_path = blueprint_path where id=$1`, [lid])).err === null);
});

// =================================================================== storage policies
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  const cur = path(lid, "live.json"), pend = path(lid, "pending.json"), rej = path(lid, "rejected.json");
  for (const n of [cur, pend, rej]) await putObject(n, 100);
  const s1 = (await seller("submit_listing_blueprint", lid, cur, "n8n", SHA, 100, "{}")).rows[0].v;
  await admin("review_listing_blueprint", s1, "approve", SHA, null);
  const s2 = (await seller("submit_listing_blueprint", lid, rej, "n8n", SHA2, 100, "{}")).rows[0].v;
  await admin("review_listing_blueprint", s2, "reject", null, "Not acceptable, sorry.");
  await seller("submit_listing_blueprint", lid, pend, "n8n", SHA2, 100, "{}");
  await q(`insert into public.purchases (listing_id, user_id, status) values ($1,$2,'paid'),($1,$3,'refunded')`, [lid, U.buyer, U.refunded]);
  const sel = (uid, claims, name) => as("authenticated", uid, claims, `select name from storage.objects where bucket_id='listing-blueprints' and name=$1`, [name]).then(r => r.rows.length);
  check("A44-T01 a paid buyer can read the CURRENT blueprint", (await sel(U.buyer, null, cur)) === 1);
  check("A44-T02 ...but NOT a pending or a rejected upload under the same listing", (await sel(U.buyer, null, pend)) === 0 && (await sel(U.buyer, null, rej)) === 0);
  check("A44-T03 a refunded buyer and a stranger read nothing", (await sel(U.refunded, null, cur)) === 0 && (await sel(U.stranger, null, cur)) === 0);
  check("A44-T04 the seller and an admin can read every object (review needs it)", (await sel(U.seller, null, pend)) === 1 && (await sel(U.admin, AAL2, pend)) === 1 && (await sel(U.admin, AAL2, cur)) === 1);
  const del = (name, uid = U.seller) => as("authenticated", uid, null, `delete from storage.objects where bucket_id='listing-blueprints' and name=$1`, [name]).then(r => r.rowCount);
  check("A44-T05 the seller cannot delete (replace) the LIVE blueprint object", (await del(cur)) === 0);
  check("A44-T06 ...nor an object that is pending review", (await del(pend)) === 0);
  check("A44-T07 ...but can delete a rejected upload", (await del(rej)) === 1);
  check("A44-T08 another seller can delete nothing of theirs here", (await del(pend, U.other)) === 0);
  await admin("review_listing_blueprint", (await val(`select id as v from public.blueprint_submissions where storage_path=$1`, [pend])), "reject", null, "Rejected for the test run.");
  check("A44-T09 once a pending submission is decided its object becomes deletable again", (await del(pend)) === 1);
  check("A44-T10 can_download_blueprint is false for a null user and for a non-current object",
    !(await val(`select private.can_download_blueprint($1, null) as v`, [cur])) && !(await val(`select private.can_download_blueprint($1,$2) as v`, [rej, U.buyer])) && (await val(`select private.can_download_blueprint($1,$2) as v`, [cur, U.buyer])));
  const up = (uid, name) => as("authenticated", uid, null, `insert into storage.objects (bucket_id, name, owner, metadata) values ('listing-blueprints',$1,$2,'{}'::jsonb)`, [name, uid]);
  check("A44-T11 the 4.2 upload policy is unchanged: own folder + own listing only",
    (await up(U.seller, path(lid, "new.json"))).err === null && code(await up(U.other, path(lid, "x.json", U.other))) !== undefined && (await up(U.other, path(lid, "x.json", U.other))).err !== null);
});

// =================================================================== public payload parity
await inTxn(async () => {
  await setFlags();
  const lid = await mkListing();
  await q(`insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [lid, jc(CFG())]);
  await q(`update public.listing_demos set approved_at=now(), approved_by=$2 where listing_id=$1`, [lid, U.admin]);
  const v = (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v;
  check("A44-I01 listing_demo_info now carries sampleInput (null when the seller gave none)", v.available === true && "sampleInput" in v && v.sampleInput === null, v);
  await q(`update public.listing_demos set review_status='draft', approved_at=null where listing_id=$1`, [lid]);
  check("A44-I02 review_status is an extra gate: not approved -> unavailable", (await as("anon", null, null, `select public.listing_demo_info($1) as v`, [lid])).rows[0].v.available === false);
});

// =================================================================== client rules == database rules (parity)
await inTxn(async () => {
  const models = [HAIKU, SONNET];
  const base = () => ({ sampleInput: "x", isEnabled: true, steps: [{ name: "n", model: HAIKU, system: "s", maxOutputTokens: "300", timeoutSeconds: "20" }] });
  const cases = [
    ["baseline", (d) => d], ["tokens 1", (d) => (d.steps[0].maxOutputTokens = "1")], ["tokens 1024", (d) => (d.steps[0].maxOutputTokens = "1024")], ["tokens 1025", (d) => (d.steps[0].maxOutputTokens = "1025")],
    ["tokens 0", (d) => (d.steps[0].maxOutputTokens = "0")], ["timeout 30", (d) => (d.steps[0].timeoutSeconds = "30")], ["timeout 31", (d) => (d.steps[0].timeoutSeconds = "31")], ["timeout 0", (d) => (d.steps[0].timeoutSeconds = "0")],
    ["system 3000", (d) => (d.steps[0].system = "x".repeat(3000))], ["system 3001", (d) => (d.steps[0].system = "x".repeat(3001))], ["name 100", (d) => (d.steps[0].name = "n".repeat(100))], ["name 101", (d) => (d.steps[0].name = "n".repeat(101))],
    ["two steps", (d) => d.steps.push({ ...d.steps[0] })], ["three steps", (d) => d.steps.push({ ...d.steps[0] }, { ...d.steps[0] })], ["sonnet", (d) => (d.steps[0].model = SONNET)], ["unknown model", (d) => (d.steps[0].model = "gpt-5")],
    ["blank name", (d) => (d.steps[0].name = "")], ["emoji system 3000", (d) => (d.steps[0].system = "😀".repeat(3000))], ["emoji system 3001", (d) => (d.steps[0].system = "😀".repeat(3001))],
  ];
  const mismatches = [];
  for (const [label, mut] of cases) {
    const d = base(); mut(d);
    const client = validateDraft({ ...d }, models);
    // the DB rule covers the CONFIG only (sample input is checked separately); compare on config-relevant errors
    const clientOk = !Object.keys(client.errors).some((k) => k.startsWith("steps"));
    let dbOk = true;
    if (clientOk) { const r = await q("SAVEPOINT p").then(() => q(`select private.assert_demo_config($1::jsonb)`, [jc(draftToConfig(d))])).then(() => null, (e) => e); await q("ROLLBACK TO SAVEPOINT p"); dbOk = r === null; }
    else {
      // build the closest config the client WOULD have sent if it did not validate, and make sure the DB also refuses it
      const cfg = { steps: d.steps.map((s, i) => ({ id: `step-${i + 1}`, ...(s.name ? { name: s.name } : {}), model: s.model, system: s.system.trim() || "s", maxOutputTokens: Number(s.maxOutputTokens), timeoutSeconds: Number(s.timeoutSeconds) })) };
      const r = await q("SAVEPOINT p").then(() => q(`select private.assert_demo_config($1::jsonb)`, [jc(cfg)])).then(() => null, (e) => e); await q("ROLLBACK TO SAVEPOINT p");
      dbOk = r === null;
    }
    if (clientOk !== dbOk) mismatches.push(label);
  }
  check("A44-X01 for every boundary case the browser-side verdict equals private.assert_demo_config's verdict", mismatches.length === 0, mismatches);
  const lid = await mkListing();
  const d = base(); d.steps.push({ ...d.steps[0], model: SONNET, name: "Second" });
  const saved = await seller("save_listing_demo", lid, jc(draftToConfig(d)), d.sampleInput, true);
  check("A44-X02 a config built by draftToConfig is accepted end-to-end by public.save_listing_demo", saved.err === null && saved.rows[0].v.reviewStatus === "draft", saved.err?.message);
});

console.log(`\n${pass} passed, ${fail} failed`);
await client.end();
process.exit(fail ? 1 : 0);
