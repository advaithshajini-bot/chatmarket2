// Mutation check for Milestone 5.2: break the code on purpose; the suites MUST fail. Run as the postgres OS user:
//   node run-mutations-52.mjs <repoDir>
// Needs template DB m52tpl = stub + every migration EXCEPT the 5.2 one (see scratch/build-real.sh).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const work = "/tmp/m52mut"; fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const sh = (cmd, cwd) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
sh(`cp -r ${repo}/. ${work}/ 2>/dev/null; rm -f ${work}/node_modules; ln -s /home/claude/work/npm/node_modules ${work}/node_modules`);
const MIG = "supabase/migrations/20261013100000_add_route_transfers.sql";
const ORIG = {}; const orig = (f) => (ORIG[f] ??= fs.readFileSync(path.join(work, f), "utf8"));
const node = process.execPath;
const URL = "postgres://postgres@/m52mut?host=/var/run/postgresql";
const SQLM = [
  ["one transfer per purchase: UNIQUE removed", "purchase_id          uuid not null unique references", "purchase_id          uuid not null references"],
  ["state machine: rank guard removed", "elsif p_status <> 'failed' and v_rank_new < v_rank_old then", "elsif false then"],
  ["state machine: event-timestamp staleness guard removed", "elsif p_event_at is not null and v_t.last_event_at is not null and p_event_at < v_t.last_event_at then", "elsif false then"],
  ["state machine: terminal states can be left", "if v_t.status in ('failed', 'reversed') then", "if false then"],
  ["state machine: a late 'failed' can undo processed", "elsif p_status = 'failed' and v_t.status in ('processed', 'partially_reversed') then", "elsif false then"],
  ["settled can be un-settled", "case when v_t.settlement_status = 'settled' then 'settled' else", "case when false then 'settled' else"],
  ["released hold can be re-set after settlement", "case when v_t.settlement_status = 'settled' then false else coalesce(p_on_hold, v_t.on_hold) end", "coalesce(p_on_hold, v_t.on_hold)"],
  ["reversed amount can shrink", "v_rev    := greatest(v_t.amount_reversed_paise, coalesce(p_amount_reversed, 0));", "v_rev := coalesce(p_amount_reversed, 0);"],
  ["kill switch ignored by plan_transfer", "if not private.is_route_transfers_enabled() then\n    return jsonb_build_object('outcome', 'disabled');", "if false then\n    return jsonb_build_object('outcome', 'disabled');"],
  ["kill switch ignored by the sweep listing", "if private.is_route_transfers_enabled() then\n    select coalesce(jsonb_agg", "if true then\n    select coalesce(jsonb_agg"],
  ["plan_transfer granted to authenticated", "grant execute on function public.plan_transfer(uuid) to service_role;", "grant execute on function public.plan_transfer(uuid) to service_role, authenticated;"],
  ["apply_transfer_event granted to authenticated", "boolean, integer, bigint, integer, text, text) to service_role;", "boolean, integer, bigint, integer, text, text) to service_role, authenticated;"],
  ["plan_transfer left executable by PUBLIC", "revoke all on function public.plan_transfer(uuid) from public, anon, authenticated;", "revoke all on function public.plan_transfer(uuid) from anon, authenticated;"],
  ["seller share: platform fee not deducted", "v_p.razorpay_payment_id, v_amount - v_fee, v_fee,", "v_p.razorpay_payment_id, v_amount, v_fee,"],
  ["seller share: fee dropped from the computation", "v_fee    := round(coalesce(v_p.platform_fee, 0) * 100)::integer;", "v_fee    := 0;"],
  ["refunded purchases stay eligible", "if v_dispute = 'resolved_refunded' then", "if false then"],
  ["open dispute no longer holds indefinitely", "if v_dispute = 'open' then\n    v_on_hold := true; v_hold_end := null;", "if false then\n    v_on_hold := true; v_hold_end := null;"],
  ["hold window is 24h instead of 48h", "v_p.purchased_at + interval '48 hours'", "v_p.purchased_at + interval '24 hours'"],
  ["an elapsed hold window is still held", "elsif v_hold_end <= now() + interval '5 minutes' then", "elsif false then"],
  ["inactive payout account accepted", "if not found or v_acct.status <> 'active' then", "if not found then"],
  ["backoff ignored", "if v_t.next_attempt_at is not null and v_t.next_attempt_at > now() then", "if false then"],
  ["concurrent in-flight attempt not detected", "if v_t.next_attempt_at is null and v_t.last_attempt_at > now() - interval '2 minutes' then", "if false then"],
  ["reclaimed claim does not ask for lookup_first", "'lookup_first', true, 'attempts', v_t.attempts + 1", "'lookup_first', false, 'attempts', v_t.attempts + 1"],
  ["a second Razorpay transfer for one purchase is not flagged", "if found and v_t.razorpay_transfer_id is not null and v_t.razorpay_transfer_id <> p_transfer_id then", "if false then"],
  ["event amount mismatch not detected", "(p_amount_paise is not null and p_amount_paise <> v_t.amount_paise)", "false"],
  ["event recipient mismatch not detected", "or (p_recipient is not null and p_recipient <> v_t.razorpay_account_id)", "or false"],
  ["retry cap removed", "if p_retryable and v_t.attempts < 8 then", "if p_retryable then"],
  ["purchases mapping: released shown as held", "when p_status = 'processed' and not coalesce(p_on_hold, true) then 'released'", "when p_status = 'processed' and not coalesce(p_on_hold, true) then 'held'"],
  ["purchases mapping: reversed shown as pending", "when p_status in ('reversed', 'partially_reversed') then 'reversed'", "when p_status in ('reversed', 'partially_reversed') then 'pending'"],
  ["admin RPC: MFA/admin check removed", "if not (select private.is_admin_mfa()) then", "if false then"],
  ["admin RPC: audit log removed", "values ((select auth.uid()), 'payout_account_set', 'user', p_user_id,", "values ((select auth.uid()), 'payout_account_set_x', 'user', p_user_id,"],
  ["transfers visible to every signed-in user", "for select to authenticated using ((select auth.uid()) = seller_id);", "for select to authenticated using (true);"],
  ["payout accounts visible to every signed-in user", "for select to authenticated using ((select auth.uid()) = user_id);", "for select to authenticated using (true);"],
  ["webhook event bookkeeping flipped", "case when v_outcome in ('applied', 'stale') then 'processed' else 'needs_review' end", "case when v_outcome in ('applied', 'stale') then 'needs_review' else 'processed' end"],
  ["account id format unchecked", "check (razorpay_account_id ~ '^acc_[A-Za-z0-9]{6,40}$'),\n  razorpay_payment_id", "check (true),\n  razorpay_payment_id"],
];
const JSM = [
  ["no lookup before a re-attempt", "lib/payments/transfers.js", "if (plan.lookup_first) {", "if (false) {"],
  ["duplicates at Razorpay ignored", "lib/payments/transfers.js", "if (mine.length > 1)", "if (false)"],
  ["adopts a transfer with a different amount", "lib/payments/transfers.js", "if (t.amountPaise !== plan.amount_paise) return", "if (false) return"],
  ["records a mismatching create response as ours", "lib/payments/transfers.js", "if (t.amountPaise !== plan.amount_paise || (t.recipient && t.recipient !== plan.account_id)) {", "if (false) {"],
  ["creates without holding the claim", "lib/payments/transfers.js", 'if (plan?.outcome !== "claimed") return', "if (false) return"],
  ["adopts transfers to other accounts", "lib/payments/transfers.js", "t.recipient === plan.account_id && ", ""],
  ["purchase id not put in the notes", "lib/payments/transfers.js", "notes: { purchase_id: purchaseId }", "notes: {}"],
  ["poll stamps a far-future time", "lib/payments/transfers.js", "const applied = await db.applyTransferEvent(asEvent(r.transfer, purchaseId, at));", "const applied = await db.applyTransferEvent(asEvent(r.transfer, purchaseId, 99999999999));"],
  ["a sweep item failure aborts the sweep", "lib/payments/transfers.js", "    } catch {\n      counts.errors++;\n    }", "    } catch (e) {\n      throw e;\n    }"],
  ["sweep ignores its time budget", "lib/payments/transfers.js", "if (nowMs() - started > budgetMs)", "if (false)"],
  ["unreadable listing treated as empty", "lib/payments/transfers.js", "if (listed.unreadable > 0) return", "if (false) return"],
  ["429 not retried", "lib/payments/razorpay-client.js", "const retryable = res.status === 429 || res.status >= 500;", "const retryable = res.status >= 500;"],
  ["every 4xx retried", "lib/payments/razorpay-client.js", "const retryable = res.status === 429 || res.status >= 500;", "const retryable = true;"],
  ["malformed 200 not retryable", "lib/payments/razorpay-client.js", "const bad = (what) => ({ ok: false, retryable: true,", "const bad = (what) => ({ ok: false, retryable: false,"],
  ["timeout not retryable", "lib/payments/razorpay-client.js", "return { ok: false, retryable: true, status: 0, code: timedOut", "return { ok: false, retryable: false, status: 0, code: timedOut"],
  ["no client timeout", "lib/payments/razorpay-client.js", "const timer = setTimeout(() => ac.abort(), timeoutMs);", "const timer = setTimeout(() => {}, timeoutMs);"],
  ["transfer entity accepts non-positive amounts", "lib/payments/transfer-events.js", "if (!Number.isInteger(e.amount) || e.amount <= 0) return null;", ""],
  ["transfer entity accepts unknown statuses", "lib/payments/transfer-events.js", "if (!TRANSFER_STATUSES.includes(status)) return null;", ""],
  ["transfer webhook db error answered 200", "lib/payments/webhook-handler.js", "        throw e;\n      }\n      return { status: 200, json: { ok: true, outcome: applied", "        applied = null;\n      }\n      return { status: 200, json: { ok: true, outcome: applied"],
  ["unreadable transfer entity applied blindly", "lib/payments/webhook-handler.js", "if (!transfer) {", "if (false) {"],
  ["hook runs after any outcome", "lib/payments/webhook-handler.js", '(result?.outcome === "fulfilled" || result?.outcome === "already_fulfilled")', "true"],
  ["hook failure changes the webhook answer", "lib/payments/webhook-handler.js", "catch { /* never affects the webhook answer */ }", "catch (e) { throw e; }"],
  ["db wrapper drops the event timestamp", "lib/payments/db.js", "p_event_at: eventAt ?? null,", ""],
  ["db wrapper swallows rpc errors", "lib/payments/db.js", 'if (error) { const e = new Error(error.message || "rpc_error"); e.code = error.code; throw e; }', "if (error) return null;"],
  ["sweep auth bypassed", "lib/payments/sweep-handler.js", "if (!bearerMatches(authorization, secret))", "if (false)"],
  ["sweep accepts short secrets", "lib/payments/sweep-handler.js", "secret.length < 16) return false;", "secret.length < 0) return false;"],
  ["sweep compare not constant-time", "lib/payments/sweep-handler.js", "crypto.timingSafeEqual(given, want)", "given.equals(want)"],
  ["sweep unconfigured is open", "lib/payments/sweep-handler.js", "if (!secret || secret.length < 16) return { status: 500,", "if (false) return { status: 500,"],
  ["sweep route logs", "app/api/payments/transfers/sweep/route.js", "async function run(request) {", "async function run(request) { console.log(request.headers);"],
  ["webhook route stops wiring the hook", "app/api/razorpay/webhook/route.js", "const afterFulfil = rzp ?", "const afterFulfil = false ?"],
];
const resetDb = (migText) => {
  sh(`dropdb --if-exists m52mut; createdb -T m52tpl m52mut`);
  fs.writeFileSync("/tmp/_mut_mig.sql", migText);
  return sh(`psql -v ON_ERROR_STOP=1 -q -d m52mut -f /tmp/_mut_mig.sql`);
};
const suites = {
  db: () => sh(`DATABASE_URL='${URL}' ${node} tests/phase5/m52-db.test.mjs`, work),
  logic: () => sh(`${node} tests/phase5/m52-logic.test.mjs`, work),
  guard: () => sh(`${node} tests/phase5/m52-guardrails.test.mjs`, work),
  int: () => sh(`PHASE5_CONCURRENCY_TESTS=1 DATABASE_URL='${URL}' ${node} tests/phase5/m52-integration.test.mjs`, work),
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
