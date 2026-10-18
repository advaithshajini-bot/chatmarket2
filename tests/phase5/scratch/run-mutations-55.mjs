// Mutation check for Milestone 5.4 (instant UPI payouts). Run as the postgres OS user:  node run-mutations-55.mjs <repoDir>
// Needs template DB m55tpl = stub + every migration EXCEPT 20261016100000.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/tmp/m55mut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261018100000_add_vpa_payouts.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const URL = "postgres://postgres@/m55mut?host=/var/run/postgresql";
const SQLM = [
  ["flag seeded ON", "values ('phase6_vpa_payouts', false)", "values ('phase6_vpa_payouts', true)"],
  ["cutoff defaults to now (backlog paid)", "cutoff_at        timestamptz not null default 'infinity'", "cutoff_at        timestamptz not null default now()"],
  ["cap default removed (huge)", "max_payout_paise integer not null default 500000", "max_payout_paise integer not null default 2000000000"],
  ["route helper ignores UPI flag", "     and coalesce((select f.enabled from private.feature_flags f where f.name = 'phase6_vpa_payouts'), false) is not true;", ";"],
  ["upi helper ignores route flag", "     and coalesce((select f.enabled from private.feature_flags f where f.name = 'phase5_route_transfers'), false) is not true;", ";"],
  ["razorpay ids readable by sellers", "grant select (user_id, vpa_address, status, updated_at) on public.seller_payout_accounts to authenticated;", "grant select on public.seller_payout_accounts to authenticated;"],
  ["vpa format not checked in set_my_payout_vpa", "if v_vpa is null or length(v_vpa) > 100 or v_vpa !~ '^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$' then", "if v_vpa is null then"],
  ["no rate limit", "and a.created_at > now() - interval '24 hours') >= 5 then", "and a.created_at > now() - interval '24 hours') >= 5000 then"],
  ["not lower-cased", "v_vpa  text := lower(btrim(p_vpa));", "v_vpa  text := btrim(p_vpa);"],
  ["audit stores the full id", "jsonb_build_object('vpa', private.mask_vpa(v_vpa))", "jsonb_build_object('vpa', v_vpa)"],
  ["changed id keeps old fund account", "razorpay_contact_id = null, razorpay_fund_account_id = null,        -- a new UPI ID needs a new Razorpay fund account", "razorpay_contact_id = public.seller_payout_accounts.razorpay_contact_id, razorpay_fund_account_id = public.seller_payout_accounts.razorpay_fund_account_id,"],
  ["suspension lifted by changing id", "status = case when public.seller_payout_accounts.status = 'suspended' then 'suspended' else 'active' end,", "status = 'active',"],
  ["plan ignores the flag", "  if not private.is_vpa_payouts_enabled() then\n    return jsonb_build_object('outcome', 'disabled');\n  end if;\n\n  perform pg_advisory_xact_lock(hashtextextended('vpa_payout:'", "  perform pg_advisory_xact_lock(hashtextextended('vpa_payout:'"],
  ["no cutoff", "  if v_p.purchased_at < v_cfg.cutoff_at then", "  if false then"],
  ["route transfer not excluded", "  if exists (select 1 from public.transfers t where t.purchase_id = p_purchase_id) then\n    return jsonb_build_object('outcome', 'route_transfer_exists');\n  end if;", ""],
  ["unpaid purchase eligible", "  if v_p.status <> 'paid' or v_p.razorpay_payment_id is null then", "  if false then"],
  ["suspended seller paid", "if not found or v_acct.status <> 'active' or v_acct.vpa_address is null then\n    return jsonb_build_object('outcome', 'no_account');", "if not found or v_acct.vpa_address is null then\n    return jsonb_build_object('outcome', 'no_account');"],
  ["fee ignored", "v_fee    := round(coalesce(v_p.platform_fee, 0) * 100)::integer;", "v_fee    := 0;"],
  ["over-cap not parked", "  if v_amount - v_fee > v_cfg.max_payout_paise then", "  if false then"],
  ["cap off by one (>=)", "  if v_amount - v_fee > v_cfg.max_payout_paise then", "  if v_amount - v_fee >= v_cfg.max_payout_paise then"],
  ["no 2-minute in-flight guard", "    if v_v.next_attempt_at is null and v_v.last_attempt_at > now() - interval '2 minutes' then\n      return jsonb_build_object('outcome', 'in_progress');\n    end if;", ""],
  ["backoff ignored", "    if v_v.next_attempt_at is not null and v_v.next_attempt_at > now() then\n      return jsonb_build_object('outcome', 'backoff', 'next_attempt_at', v_v.next_attempt_at);\n    end if;", ""],
  ["changed vpa not parked", "if not found or v_acct.vpa_address is distinct from v_v.vpa_address or v_acct.status <> 'active' then", "if false then"],
  ["retry not lookup_first", "      'lookup_first', true, 'attempts', v_v.attempts + 1);", "      'lookup_first', false, 'attempts', v_v.attempts + 1);"],
  ["retry key not versioned", "'payout_key', case when v_v.key_version > 1 then p_purchase_id::text || '-v' || v_v.key_version else p_purchase_id::text end,", "'payout_key', p_purchase_id::text,"],
  ["late failed undoes processed", "    elsif p_status in ('failed', 'cancelled') and v_v.status = 'processed' then\n      v_outcome := 'stale';                                -- a late \"failed\" can never undo a processed payout", "    elsif false then\n      v_outcome := 'stale';"],
  ["terminal states not terminal", "if v_v.status in ('failed', 'cancelled', 'reversed') then", "if false then"],
  ["rank regression allowed", "elsif p_status not in ('failed', 'cancelled') and v_rank_new < v_rank_old then", "elsif false then"],
  ["old events not stale", "elsif p_event_at is not null and v_v.last_event_at is not null and p_event_at < v_v.last_event_at then", "elsif false then"],
  ["amount mismatch accepted", "if v_outcome is null and p_amount_paise is not null and p_amount_paise <> v_v.amount_paise then", "if false then"],
  ["second payout id accepted", "v_outcome := 'conflicting_payout';                  -- a SECOND Razorpay payout for one purchase: a human must look", "v_outcome := null;"],
  ["webhook row not finished", "  if p_event_id is not null then\n    update public.webhook_events e", "  if false then\n    update public.webhook_events e"],
  ["retry never gives up", "if p_retryable and v_v.attempts < 8 then", "if p_retryable then"],
  ["backoff constant", "next_attempt_at = now() + least(power(2, x.attempts - 1) * interval '1 minute', interval '6 hours'),", "next_attempt_at = now() + interval '1 minute',"],
  ["poll ignores flag-off (never polls)", "(v.status = 'processing' and v.updated_at < now() - interval '15 minutes')", "(false)"],
  ["old purchases picked up", "p.purchased_at >= v_cutoff and p.purchased_at > now() - interval '90 days'", "p.purchased_at >= v_cutoff"],
  ["create work ignores route transfers", "          and not exists (select 1 from public.transfers t where t.purchase_id = p.id)\n          and (round", "          and (round"],
  ["admin retry allows processed", "if not found or v_v.status not in ('failed', 'cancelled', 'reversed') then", "if not found or v_v.status not in ('failed', 'cancelled', 'reversed', 'processed') then"],
  ["admin retry same key", "set status = 'creating', razorpay_payout_id = null, key_version = x.key_version + 1,", "set status = 'creating', razorpay_payout_id = null, key_version = x.key_version,"],
  ["admin retry not audited", "values ((select auth.uid()), 'vpa_payout_retried'", "select null where false; -- values ((select auth.uid()), 'vpa_payout_retried'"],
  ["suspend without admin check", "  if not (select private.is_admin_mfa()) then\n    raise exception using errcode = '42501', message = 'admin_required';\n  end if;\n  if p_user_id is null or p_status is null", "  if p_user_id is null or p_status is null"],
  ["ledger without admin check", "  if not (select private.is_admin_mfa()) then\n    raise exception using errcode = '42501', message = 'admin_required';\n  end if;\n  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset", "  if p_limit is null or p_limit < 1 or p_limit > 500 or p_offset"],
  ["plan granted to authenticated", "grant execute on function public.plan_vpa_payout(uuid) to service_role;", "grant execute on function public.plan_vpa_payout(uuid) to service_role, authenticated;"],
  ["apply granted to anon", "grant execute on function public.apply_vpa_payout_event(text, uuid, text, text, bigint, integer, text, text) to service_role;", "grant execute on function public.apply_vpa_payout_event(text, uuid, text, text, bigint, integer, text, text) to service_role, anon;"],
  ["seller sees refunded as reversed after payout", "        when s.vstatus = 'processed'                                                           then 'instant_paid'", "        when s.pstatus = 'refunded'                                                            then 'reversed'\n        when s.vstatus = 'processed'                                                           then 'instant_paid'"],
  ["open dispute changes UPI status", "        when s.vstatus = 'processed'                                                           then 'instant_paid'", "        when s.dstatus = 'open'                                                                then 'dispute'\n        when s.vstatus = 'processed'                                                           then 'instant_paid'"],
  ["failed payout shown as in progress", "when s.vid is not null and s.vstatus in ('failed', 'cancelled', 'reversed')            then 'action_needed'", "when false then 'action_needed'"],
  ["no UPI id not flagged", "when v_mode and s.tid is null and v_account is null                                    then 'action_needed'", "when false then 'action_needed'"],
  ["upi masked leak", "'upi_masked', private.mask_vpa(v_vpa)", "'upi_masked', v_vpa"],
  ["negative share allowed", "greatest(round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100), 0)::bigint as share", "(round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100))::bigint as share"],
  ["attention: failed payout not listed", "when v.status = 'failed' and v.review_reason is not null then 'payout_parked'", "when v.status = 'zzz' then 'payout_parked'"],
  ["balances: UPI paid not counted", "upi_paid_paise", "upi_paid_paise_x"],
];
const JSM = [
  ["client: no idempotency header", "lib/payments/razorpay-client.js", '{ "X-Payout-Idempotency": idempotencyKey }', "undefined"],
  ["client: wrong mode", "lib/payments/razorpay-client.js", 'mode: "UPI"', 'mode: "IMPS"'],
  ["client: queue_if_low_balance dropped", "lib/payments/razorpay-client.js", "queue_if_low_balance: true, ", ""],
  ["client: list not filtered by reference", "lib/payments/razorpay-client.js", "&reference_id=${encodeURIComponent(referenceId)}", ""],
  ["client: payouts allowed without account number", "lib/payments/razorpay-client.js", "if (!accountNumber) return { ok: false, retryable: false, status: 0, code: \"payouts_not_configured\", description: \"RAZORPAYX_ACCOUNT_NUMBER missing\" };\n      const r = await request(\"POST\"", "const r = await request(\"POST\""],
  ["events: pending not queued", "lib/payments/payout-events.js", 'pending: "queued"', 'pending: "zzz"'],
  ["events: rejected not failed", "lib/payments/payout-events.js", 'rejected: "failed"', 'rejected: "processed"'],
  ["events: purchase id not parsed from -vN", "lib/payments/payout-events.js", "e.reference_id.slice(0, 36)", "e.reference_id"],
  ["events: currency unchecked", "lib/payments/payout-events.js", 'if (e.currency !== undefined && e.currency !== "INR") return null;', ""],
  ["orch: no lookup before create", "lib/payments/vpa-payouts.js", "if (plan.lookup_first) {", "if (false) {"],
  ["orch: duplicates at razorpay tolerated", "lib/payments/vpa-payouts.js", "if (listed.payouts.length > 1)", "if (false)"],
  ["orch: amount mismatch on adopt tolerated", "lib/payments/vpa-payouts.js", "if (p.amountPaise !== plan.amount_paise) return await fail({ code: \"existing_payout_mismatch\"", "if (false) return await fail({ code: \"existing_payout_mismatch\""],
  ["orch: response mismatch tolerated", "lib/payments/vpa-payouts.js", "if (p.amountPaise !== plan.amount_paise || (p.fundAccountId && p.fundAccountId !== fundAccountId)) {", "if (false) {"],
  ["orch: wrong idempotency key", "lib/payments/vpa-payouts.js", "idempotencyKey: plan.payout_key,", "idempotencyKey: purchaseId + \"x\" + Date.now(),"],
  ["orch: vpa change mid-flight ignored", "lib/payments/vpa-payouts.js", 'if (rec?.outcome !== "ok")', "if (false)"],
  ["orch: fund account mismatch ignored", "lib/payments/vpa-payouts.js", "if (f.vpa && f.vpa.toLowerCase() !== plan.vpa)", "if (false)"],
  ["orch: exception not retryable", "lib/payments/vpa-payouts.js", 'description: "unexpected error while creating the payout", retryable: true', 'description: "unexpected error while creating the payout", retryable: false'],
  ["orch: sweep ignores time budget", "lib/payments/vpa-payouts.js", "if (nowMs() - started > budgetMs)", "if (false)"],
  ["orch: poll time not taken before request", "lib/payments/vpa-payouts.js", "  const at = now();\n  const r = await rzp.fetchPayout(payoutId);", "  const r = await rzp.fetchPayout(payoutId);\n  const at = now();"],
  ["webhook: payout events ignored", "lib/payments/webhook-handler.js", "const isPayout = PAYOUT_EVENT_RE.test(eventType);", "const isPayout = false;"],
  ["webhook: db error swallowed", "lib/payments/webhook-handler.js", 'outcome: "payout_error", error: String(e?.code ?? e?.message ?? "error") }); } catch { /* best effort */ }\n        throw e;', 'outcome: "payout_error" }); } catch { }\n        return { status: 200, json: { ok: true } };'],
  ["webhook route: payout hook dropped", "app/api/razorpay/webhook/route.js", "    await payoutPurchase({ db, rzp, purchaseId });\n", ""],
  ["reconcile: payouts skipped", "lib/payments/reconcile.js", "const payouts = await runPayoutSweep({ db, rzp, limit, budgetMs: left2, nowMs });", "const payouts = { items: 0 };"],
  ["upi: regex loosened", "lib/domain/upi.js", "^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$", "^.+@.+$"],
  ["upi: not lower-cased", "lib/domain/upi.js", "raw.trim().toLowerCase()", "raw.trim()"],
  ["upi: mask shows all", "lib/domain/upi.js", "return `${name.slice(0, 2)}***@${handle}`;", "return vpa;"],
  ["wording: paid label", "lib/domain/seller-payouts.js", '"Instant payout: Paid"', '"Paid"'],
  ["wording: in progress label", "lib/domain/seller-payouts.js", '"Instant payout: In progress"', '"Pending"'],
  ["wording: action needed tone", "lib/domain/seller-payouts.js", 'detail: "We couldn\'t send this payout. Check that your UPI ID is saved and correct, and our team will retry it.", tone: "red"', 'detail: "x", tone: "green"'],
  ["page: all sales are final removed", "app/sell/payout/page.jsx", "All sales are final.", "Thanks."],
  ["page: saves directly to the table", "app/sell/payout/page.jsx", 'supabase.rpc("set_my_payout_vpa", { p_vpa: v.value })', 'supabase.from("seller_payout_accounts").upsert({ vpa_address: v.value })'],
  ["page: validation removed", "app/sell/payout/page.jsx", "disabled={!v.ok || saving || unchanged}", "disabled={saving}"],
  ["gate: KYC again", "app/sell/page.jsx", "if (!hasUpi) {", "if (false) {"],
  ["route gate dropped", "app/api/listings/create-workflow-agent/route.js", "if (!payoutAccount?.vpa_address) {", "if (false) {"],
  ["earnings: refunded red card back", "components/SellerEarningsClient.jsx", '<SummaryCard icon={Zap} label="Instant payouts sent"', '<SummaryCard icon={Zap} label="Refunded"'],
  ["panel: negative concept", "components/SellerPayoutPanel.jsx", 'Stat label="Paid"', 'Stat label="Negative balance"'],
  ["desk: retry button on processed", "components/AdminPaymentsDesk.jsx", 'RETRYABLE_PAYOUT_STATUSES.includes(t.status) &&', "true &&"],
  ["desk lib: retryable includes processed", "lib/domain/admin-payments.js", 'RETRYABLE_PAYOUT_STATUSES = ["failed", "cancelled", "reversed"]', 'RETRYABLE_PAYOUT_STATUSES = ["failed", "cancelled", "reversed", "processed"]'],
];
const resetDb = (t) => { sh(`dropdb --if-exists m55mut; createdb -T m55tpl m55mut`); fs.writeFileSync("/tmp/_mut_mig_55.sql", t); return sh(`psql -v ON_ERROR_STOP=1 -q -d m55mut -f /tmp/_mut_mig_55.sql`); };
const suites = {
  integ: () => sh(`PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL='${URL}' ${node} tests/phase5/m55-integration.test.mjs`, work),
  db: () => sh(`DATABASE_URL='${URL}' ${node} tests/phase5/m55-db.test.mjs`, work),
  logic: () => sh(`${node} tests/phase5/m55-logic.test.mjs`, work),
  guard: () => sh(`${node} tests/phase5/m55-guardrails.test.mjs`, work),
};
const runUntilDead = (order) => { for (const k of order) { const r = suites[k](); const out = `${r.stdout}${r.stderr}`; if (r.status !== 0 || /^FAIL:/m.test(out)) return `${k}:${out.match(/^FAIL: (\S+)/m)?.[1] ?? "error"}`; } return null; };
let killed = 0, total = 0; const survivors = [];
const report = (label, kind, by) => { total++; if (by) killed++; else survivors.push(label); console.log(`${by ? "killed  " : "SURVIVED"}  [${kind}] ${label}${by ? "  <- " + by : ""}`); };
const SRC = orig(MIG);
for (const [label, from, to] of SQLM) {
  if (!SRC.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  const mutated = SRC.replace(from, to);
  fs.writeFileSync(path.join(work, MIG), mutated);
  if (resetDb(mutated).status !== 0) { report(label, "sql", "migration no longer applies"); fs.writeFileSync(path.join(work, MIG), SRC); continue; }
  report(label, "sql", runUntilDead(["db", "guard", "integ"]));
  fs.writeFileSync(path.join(work, MIG), SRC);
}
for (const [label, file, from, to] of JSM) {
  const src = orig(file);
  if (!src.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  fs.writeFileSync(path.join(work, file), src.replace(from, to));
  report(label, "js", runUntilDead(["logic", "guard", "integ"]));
  fs.writeFileSync(path.join(work, file), src);
}
console.log(`\nmutants killed: ${killed}/${total}`); if (survivors.length) console.log("survivors:", survivors);
