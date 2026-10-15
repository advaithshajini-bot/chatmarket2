// Mutation check for Milestone 5.2c: break the code on purpose; the suites MUST fail. Run as the postgres OS user:
//   node run-mutations-52c.mjs <repoDir>
// Needs template DB m52ctpl = stub + every migration EXCEPT the 5.2c one (see scratch/build-real.sh).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/tmp/m52cmut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261014100000_add_dispute_actions.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const URL = "postgres://postgres@/m52cmut?host=/var/run/postgresql";
const SQLM = [
  ["refund flag ignored by plan_refund", "if not private.is_auto_refunds_enabled() then\n    return jsonb_build_object('outcome', 'disabled');", "if false then\n    return jsonb_build_object('outcome', 'disabled');"],
  ["refund offered without the refund flag", "  if not private.is_auto_refunds_enabled() then\n    return null;\n  end if;", "  if false then\n    return null;\n  end if;"],
  ["release done with the transfers flag OFF", "and coalesce(v_t.settlement_status, '') <> 'settled' and private.is_route_transfers_enabled() then\n      return 'release';", "and coalesce(v_t.settlement_status, '') <> 'settled' then\n      return 'release';"],
  ["claim release ignores the transfers flag", "if p_action = 'release' and not private.is_route_transfers_enabled() then", "if false then"],
  ["parked transfers keep being retried", "if v_t.review_reason is not null then\n      return null;                                           -- parked: a human decides\n    end if;", ""],
  ["lease ignored (two workers can act at once)", "if v_t.action_lease_until is not null and v_t.action_lease_until > now() then\n      return null;", "if false then\n      return null;"],
  ["action backoff ignored", "if v_t.action_next_attempt_at is not null and v_t.action_next_attempt_at > now() then\n      return null;", "if false then\n      return null;"],
  ["an open dispute no longer holds", "      if not (v_t.on_hold and v_t.hold_until is null) then\n        return 'hold';", "      if false then\n        return 'hold';"],
  ["an already-held transfer is held again forever", "      if not (v_t.on_hold and v_t.hold_until is null) then\n        return 'hold';", "      if true then\n        return 'hold';"],
  ["a settled transfer is not flagged", "        return 'flag';                                       -- too late to hold: the money has already left", "        return null;"],
  ["a partial reversal is treated as done", "if v_live and v_t.amount_reversed_paise < v_t.amount_paise then\n    return 'reverse';", "if v_live and v_t.amount_reversed_paise < 1 then\n    return 'reverse';"],
  ["refund offered while the transfer is still being created", "if v_tfound and v_t.status = 'creating' then\n    return null;", "if false then\n    return null;"],
  ["refund offered while a live transfer is unreversed", "if v_live and v_t.amount_reversed_paise < v_t.amount_paise then\n    return 'reverse';", "if false then\n    return 'reverse';"],
  ["refund offered when the purchase is not 'refunded'", "if not found or v_p.status <> 'refunded' or v_p.razorpay_payment_id is null then", "if not found or v_p.razorpay_payment_id is null then"],
  ["a processed/failed refund is offered again", "  if v_r.status = 'creating'\n     and ((v_r.next_attempt_at", "  if true\n     and ((v_r.next_attempt_at"],
  ["release does not restore the original window", "v_hold := v_end > now() + interval '5 minutes';", "v_hold := false;"],
  ["release always restores a window", "v_hold := v_end > now() + interval '5 minutes';", "v_hold := true;"],
  ["a settled transfer can be re-held by a late ok", "if v_t.settlement_status is distinct from 'settled' then\n      if p_action = 'hold' then", "if true then\n      if p_action = 'hold' then"],
  ["retry cap removed (actions)", "if p_retryable and v_t.action_attempts < 8 then", "if p_retryable then"],
  ["a non-retryable failure is not parked", "     set action_lease_until = null, action_next_attempt_at = null, updated_at = now(),\n         review_reason = left('dispute_' || p_action || ': ' || coalesce(p_error, 'unknown'), 300)", "     set action_lease_until = null, action_next_attempt_at = null, updated_at = now(),\n         review_reason = null"],
  ["a success leaves the lease in place", "set on_hold = v_hold, hold_until = v_until, action_lease_until = null, action_attempts = 0,", "set on_hold = v_hold, hold_until = v_until, action_attempts = 0,"],
  ["purchases mapping not refreshed after a hold change", "    if p_action in ('hold', 'release') then\n      update public.purchases pu set transfer_status", "    if false then\n      update public.purchases pu set transfer_status"],
  ["refund amount is not the full amount", "v_amount := round(v_p.amount * 100)::integer;\n  if v_amount <= 0 then", "v_amount := round(v_p.amount * 100)::integer / 2;\n  if v_amount <= 0 then"],
  ["plan_refund does not require the derived need", "if private.dispute_action_needed(p_purchase_id) is distinct from 'refund' then\n    return jsonb_build_object('outcome', 'not_needed');", "if false then\n    return jsonb_build_object('outcome', 'not_needed');"],
  ["refund: one per purchase UNIQUE removed", "purchase_id          uuid not null unique references public.purchases(id) on delete cascade,\n  razorpay_payment_id  text not null check (length(razorpay_payment_id) between 1 and 100),\n  razorpay_refund_id", "purchase_id          uuid not null references public.purchases(id) on delete cascade,\n  razorpay_payment_id  text not null check (length(razorpay_payment_id) between 1 and 100),\n  razorpay_refund_id"],
  ["refund: processed can go back", "if v_r.status in ('processed', 'failed') then\n      v_outcome := 'stale';", "if false then\n      v_outcome := 'stale';"],
  ["refund: staleness guard removed", "elsif p_event_at is not null and v_r.last_event_at is not null and p_event_at < v_r.last_event_at then", "elsif false then"],
  ["refund: rank guard removed", "elsif v_rank_n < v_rank_o then", "elsif false then"],
  ["refund: a second refund id is not flagged", "if found and v_r.razorpay_refund_id is not null and v_r.razorpay_refund_id <> p_refund_id then", "if false then"],
  ["refund: amount mismatch not detected", "if (p_amount_paise is not null and p_amount_paise <> v_r.amount_paise)", "if (false)"],
  ["refund: payment mismatch not detected", "or (p_payment_id is not null and p_payment_id <> v_r.razorpay_payment_id) then", "or false then"],
  ["refund: event bookkeeping flipped", "outcome      = 'refund_' || v_outcome,", "outcome      = 'refund_x',"],
  ["refund: retry cap removed", "if p_retryable and v_r.attempts < 8 then", "if p_retryable then"],
  ["refunds readable by every signed-in user", "for select to authenticated using (exists (select 1 from public.purchases p where p.id = purchase_id and p.user_id = (select auth.uid())));", "for select to authenticated using (true);"],
  ["claim_dispute_action granted to authenticated", "grant execute on function public.claim_dispute_action(uuid, text) to service_role;", "grant execute on function public.claim_dispute_action(uuid, text) to service_role, authenticated;"],
  ["plan_refund granted to authenticated", "grant execute on function public.plan_refund(uuid) to service_role;", "grant execute on function public.plan_refund(uuid) to service_role, authenticated;"],
  ["admin clear: MFA check removed", "if not (select private.is_admin_mfa()) then", "if false then"],
  ["admin clear: no audit row", "'transfer_review_cleared'", "'transfer_review_cleared_x'"],
  ["plan_transfer: refunded reclaim may create", "'adopt_only', coalesce(v_dispute = 'resolved_refunded', false)", "'adopt_only', false"],
  ["list_dispute_work: leased items listed (no priority order)", "order by case x.a when 'hold' then 0 when 'flag' then 0 when 'reverse' then 1 when 'release' then 2 else 3 end, d.created_at", "order by case x.a when 'hold' then 3 when 'flag' then 3 when 'reverse' then 1 when 'release' then 2 else 0 end, d.created_at"],
];
const JSM = [
  ["hold PATCH carries an end date", "lib/payments/disputes.js", "rzp.setTransferHold(c.razorpay_transfer_id, true, null)", "rzp.setTransferHold(c.razorpay_transfer_id, true, 2000000000)"],
  ["release ignores the database's hold state", "lib/payments/disputes.js", "rzp.setTransferHold(c.razorpay_transfer_id, !!c.on_hold, c.hold_until_epoch ?? null)", "rzp.setTransferHold(c.razorpay_transfer_id, false, null)"],
  ["release does not report the hold state", "lib/payments/disputes.js", "ok: true, onHold: !!c.on_hold, holdUntilEpoch: c.hold_until_epoch ?? null", "ok: true"],
  ["a failed PATCH is reported as success", "lib/payments/disputes.js", "if (!r.ok) return finishFail(db, purchaseId, \"hold\", r);", ""],
  ["reversal sized from OUR ledger instead of Razorpay's", "lib/payments/disputes.js", "const remaining = t.amountPaise - t.amountReversedPaise;", "const remaining = c.amount_paise - c.amount_reversed_paise;"],
  ["reversal not confirmed is treated as done", "lib/payments/disputes.js", "if (t.amountReversedPaise < t.amountPaise) {", "if (false) {"],
  ["reverse skips the look-before", "lib/payments/disputes.js", "const remaining = t.amountPaise - t.amountReversedPaise;\n    if (remaining > 0) {", "const remaining = t.amountPaise;\n    if (remaining > 0) {"],
  ["reverse does not apply the new state to the ledger", "lib/payments/disputes.js", "    await db.applyTransferEvent({\n      transferId: t.id, purchaseId, status: t.status,", "    if (false) await db.applyTransferEvent({\n      transferId: t.id, purchaseId, status: t.status,"],
  ["flag action calls Razorpay / is retryable", "lib/payments/disputes.js", "ok: false, retryable: false, error: \"dispute_opened_after_settlement\"", "ok: false, retryable: true, error: \"dispute_opened_after_settlement\""],
  ["refund creates without listing first", "lib/payments/disputes.js", "const listed = await rzp.listPaymentRefunds(plan.payment_id);", "const listed = { ok: true, refunds: [], unreadable: 0 };"],
  ["refund ignores an unreadable list", "lib/payments/disputes.js", "if (listed.unreadable > 0) return await fail(", "if (false) return await fail("],
  ["several refunds not detected", "lib/payments/disputes.js", "if (live.length > 1) return await fail(", "if (false) return await fail("],
  ["a failed earlier refund blocks a new one", "lib/payments/disputes.js", "const live = listed.refunds.filter((x) => x.status !== \"failed\");", "const live = listed.refunds;"],
  ["adopts a refund with a different amount", "lib/payments/disputes.js", "if (x.amountPaise !== plan.amount_paise) return await fail(", "if (false) return await fail("],
  ["refund response mismatch recorded as ours", "lib/payments/disputes.js", "if (x.amountPaise !== plan.amount_paise || (x.paymentId && x.paymentId !== plan.payment_id)) {", "if (false) {"],
  ["refund created without holding the claim", "lib/payments/disputes.js", "if (plan?.outcome !== \"claimed\") return { action: \"refund\"", "if (false) return { action: \"refund\""],
  ["refund notes lack the purchase id", "lib/payments/disputes.js", "notes: { purchase_id: purchaseId } });\n    if (!created.ok)", "notes: {} });\n    if (!created.ok)"],
  ["an exception after a claim leaves the lease", "lib/payments/disputes.js", "async function guarded(db, purchaseId, action, fn) {\n  try { return await fn(); }\n  catch {", "async function guarded(db, purchaseId, action, fn) {\n  try { return await fn(); }\n  catch (e) { throw e; } finally {} try {} catch {"],
  ["sync loop never goes on to the next step", "lib/payments/disputes.js", 'progressed = r.outcome === "done" || r.outcome === "created" || r.outcome === "adopted";', "progressed = false;"],
  ["dispute sweep ignores its time budget", "lib/payments/disputes.js", "if (nowMs() - started > budgetMs) { counts.timeBudgetHit = true; break; }", ""],
  ["a sweep item failure aborts the dispute sweep", "lib/payments/disputes.js", "} catch { counts.errors++; }", "} catch (e) { throw e; }"],
  ["transfers reconciled before disputes", "lib/payments/reconcile.js", "const disputes = await runDisputeSweep(", "const disputes0 = await runDisputeSweep("],
  ["sync handler skips the visibility check", "lib/payments/dispute-sync-handler.js", "if (!visible) return { status: 404, json: { error: \"not found\" } };", ""],
  ["sync handler accepts anonymous callers", "lib/payments/dispute-sync-handler.js", "if (!userId) return { status: 401, json: { error: \"login required\" } };", ""],
  ["sync handler skips UUID validation", "lib/payments/dispute-sync-handler.js", "!UUID_RE.test(purchaseId)", "false"],
  ["sync handler leaks sync errors", "lib/payments/dispute-sync-handler.js", "try { await sync(purchaseId); } catch { /* the sweep will finish it */ }", "await sync(purchaseId);"],
  ["reversal 4xx is retried forever", "lib/payments/razorpay-client.js", "async reverseTransfer(transferId, amountPaise) {\n      const r = await request(\"POST\", `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise });\n      return r.ok ? { ok: true } : r;", "async reverseTransfer(transferId, amountPaise) {\n      const r = await request(\"POST\", `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise });\n      return r.ok ? { ok: true } : { ...r, retryable: true };"],
  ["refund entity accepts non-positive amounts", "lib/payments/refund-events.js", "if (!Number.isInteger(e.amount) || e.amount <= 0) return null;", ""],
  ["refund entity accepts unknown statuses", "lib/payments/refund-events.js", 'if (!["pending", "processed", "failed"].includes(status)) return null;', ""],
  ["refund webhook db error answered 200", "lib/payments/webhook-handler.js", "        throw e;\n      }\n      return { status: 200, json: { ok: true, outcome: applied?.outcome ? `refund_", "        applied = null;\n      }\n      return { status: 200, json: { ok: true, outcome: applied?.outcome ? `refund_"],
  ["unreadable refund entity applied blindly", "lib/payments/webhook-handler.js", "      if (!refund) {", "      if (false) {"],
  ["db wrapper: finish sends retryable on success", "lib/payments/db.js", "p_retryable: ok ? null : !!retryable", "p_retryable: !!retryable"],
  ["db wrapper swallows rpc errors (dispute)", "lib/payments/db.js", "if (error) { const e = new Error(error.message || \"rpc_error\"); e.code = error.code; throw e; }", "if (error) return null;"],
  ["transfer creation ignores adopt_only", "lib/payments/transfers.js", "if (plan.adopt_only) {", "if (false) {"],
  ["sweep route stops running disputes", "app/api/payments/transfers/sweep/route.js", "return runReconciliation(", "return runTransferSweep_(" ],
  ["sync route trusts a client-supplied action", "app/api/payments/disputes/sync/route.js", "purchaseId: body?.purchaseId,", "purchaseId: body?.purchaseId, action: body?.action,"],
  ["sync route skips authentication", "app/api/payments/disputes/sync/route.js", "userId: userData?.user?.id ?? null,", "userId: \"anyone\","],
  ["sync route logs", "app/api/payments/disputes/sync/route.js", "export async function POST(request) {", "export async function POST(request) { console.log(request.headers);"],
  ["admin UI hook sends more than the purchase id", "components/AdminDisputesClient.jsx", "body: JSON.stringify({ purchaseId: data.purchase_id })", "body: JSON.stringify({ purchaseId: data.purchase_id, outcome })"],
];
const resetDb = (migText) => {
  sh(`dropdb --if-exists m52cmut; createdb -T m52ctpl m52cmut`);
  fs.writeFileSync("/tmp/_mut_mig_c.sql", migText);
  return sh(`psql -v ON_ERROR_STOP=1 -q -d m52cmut -f /tmp/_mut_mig_c.sql`);
};
const suites = {
  db: () => sh(`DATABASE_URL='${URL}' ${node} tests/phase5/m52c-db.test.mjs`, work),
  logic: () => sh(`${node} tests/phase5/m52c-logic.test.mjs`, work),
  guard: () => sh(`${node} tests/phase5/m52c-guardrails.test.mjs`, work),
  int: () => sh(`PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL='${URL}' ${node} tests/phase5/m52c-integration.test.mjs`, work),
};
const runUntilDead = (order) => {
  for (const k of order) {
    const r = suites[k](); const out = `${r.stdout}${r.stderr}`;
    if (r.status !== 0 || /^FAIL:/m.test(out)) return `${k}:${out.match(/^FAIL: (\S+)/m)?.[1] ?? "error"}`;
  }
  return null;
};
let killed = 0, total = 0; const survivors = [];
const report = (label, kind, by) => { total++; if (by) killed++; else survivors.push(label); console.log(`${by ? "killed  " : "SURVIVED"}  [${kind}] ${label}${by ? "  <- " + by : ""}`); };
// NOT mutated on purpose: the 6h backoff cap (least(..., '6 hours')) -- an EQUIVALENT mutant, unreachable because attempts stop at 8 (max 128 min).
// NOT mutated on purpose: the order of the kinds in syncDisputeForPurchase -- an EQUIVALENT mutant, because the database only
// hands out a claim for the action that is currently needed (refund is 'not_needed' while a reversal is).
const MIGSRC = orig(MIG);
for (const [label, from, to] of SQLM) {
  if (!MIGSRC.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  const mutated = MIGSRC.replace(from, to);
  fs.writeFileSync(path.join(work, MIG), mutated);
  const r = resetDb(mutated);
  if (r.status !== 0) { report(label, "sql", "migration no longer applies"); fs.writeFileSync(path.join(work, MIG), MIGSRC); continue; }
  report(label, "sql", runUntilDead(["db", "guard", "int"]));
  fs.writeFileSync(path.join(work, MIG), MIGSRC);
}
resetDb(MIGSRC);
for (const [label, file, from, to] of JSM) {
  const src = orig(file);
  if (!src.includes(from)) { console.log(`!! ${label}: pattern NOT FOUND`); survivors.push(`${label} (pattern missing)`); total++; continue; }
  fs.writeFileSync(path.join(work, file), src.replace(from, to));
  report(label, "js", runUntilDead(["logic", "guard", "int"]));
  fs.writeFileSync(path.join(work, file), src);
}
console.log(`\nmutants killed: ${killed}/${total}`); if (survivors.length) console.log("survivors:", survivors);
