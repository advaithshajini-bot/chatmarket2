// A53-L -- unit tests for the admin payments desk helpers (no database, no network).
// Run:  node tests/phase5/m53-logic.test.mjs
import { formatPaise, formatAge, getAttention, getLedger, getDisputes, getBalances, getTimeline, getAttentionCount,
  clearTransferReview, setSellerPayoutAccount, ATTENTION_LABELS, BUCKET_LABELS, LEDGER_FILTERS, DISPUTE_FILTERS } from "../../lib/domain/admin-payments.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const sb = (impl) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push([fn, args]); return impl(fn, args); } }; };

check("L01 formatPaise basics", formatPaise(0) === "₹0.00" && formatPaise(5) === "₹0.05" && formatPaise(41000) === "₹410.00" && formatPaise(123456789) === "₹1,234,567.89");
check("L02 formatPaise groups thousands", formatPaise(100000) === "₹1,000.00" && formatPaise(99999999) === "₹999,999.99");
check("L03 formatPaise negative", formatPaise(-150) === "-₹1.50");
check("L04 formatPaise rejects non-integers", formatPaise(1.5) === "—" && formatPaise(null) === "—" && formatPaise("5") === "—" && formatPaise(NaN) === "—");
check("L05 formatAge", formatAge(30) === "1m" && formatAge(600) === "10m" && formatAge(7200) === "2h" && formatAge(172800) === "2d" && formatAge(-1) === "—" && formatAge(undefined) === "—");

check("L10 label tables cover every kind the SQL emits", ["parked_transfer", "transfer_failed", "transfer_stuck", "refund_failed", "refund_stuck", "dispute_hold_pending", "webhook_needs_review", "webhook_failed"].every((k) => ATTENTION_LABELS[k]));
check("L11 bucket labels cover every bucket", ["held", "releasing", "settled", "reversed", "failed", "parked", "creating"].every((k) => BUCKET_LABELS[k]));
check("L12 filters", LEDGER_FILTERS[0] === "all" && DISPUTE_FILTERS.includes("open"));

{
  const s = sb(() => ({ data: { total: 1, items: [{ a: 1 }] }, error: null }));
  const a = await getAttention(s);
  check("L20 getAttention calls the right RPC with a bounded limit", s.calls[0][0] === "admin_payment_attention" && s.calls[0][1].p_limit === 200 && a.total === 1);
  await getLedger(s, "all", 0);
  check("L21 ledger 'all' maps to a null bucket", s.calls[1][0] === "admin_transfers_ledger" && s.calls[1][1].p_bucket === null && s.calls[1][1].p_limit === 100);
  await getLedger(s, "held", 100);
  check("L22 ledger passes a bucket and offset", s.calls[2][1].p_bucket === "held" && s.calls[2][1].p_offset === 100);
  await getDisputes(s, "all", 0); await getDisputes(s, "open", 0);
  check("L23 disputes 'all' -> null status", s.calls[3][1].p_status === null && s.calls[4][1].p_status === "open");
  await getBalances(s); await getTimeline(s, "abc");
  check("L24 balances and timeline RPC names", s.calls[5][0] === "admin_seller_balances" && s.calls[6][0] === "admin_purchase_timeline" && s.calls[6][1].p_purchase_id === "abc");
}
{
  const bad = sb(() => ({ data: null, error: { message: "admin_required" } }));
  const th = sb(() => { throw new Error("net"); });
  const both = sb(() => ({ data: { total: 9, items: [{ x: 1 }] }, error: { message: "boom" } }));
  check("L29 an error wins even when data is present", (await getAttention(both)).error === true && (await getAttention(both)).items.length === 0);
  for (const [label, s] of [["error", bad], ["throw", th]]) {
    check(`L30 loaders fail soft on ${label}`, (await getAttention(s)).items.length === 0 && (await getAttention(s)).error === true && (await getLedger(s)).error === true &&
      (await getBalances(s)).error === true && (await getDisputes(s)).error === true && (await getTimeline(s, "x")).found === false);
    check(`L31 count is null on ${label} (badge not drawn)`, (await getAttentionCount(s)) === null);
  }
  check("L32 count returns the integer", (await getAttentionCount(sb(() => ({ data: 7, error: null })))) === 7 && (await getAttentionCount(sb(() => ({ data: 0, error: null })))) === 0);
  check("L33 a non-integer count is treated as unknown", (await getAttentionCount(sb(() => ({ data: "7", error: null })))) === null);
}
{
  const ok = sb(() => ({ data: null, error: null }));
  check("L40 clearTransferReview calls the existing admin RPC", (await clearTransferReview(ok, "p1")).ok === true && ok.calls[0][0] === "admin_clear_transfer_review" && ok.calls[0][1].p_purchase_id === "p1");
  check("L41 clearTransferReview surfaces the error", (await clearTransferReview(sb(() => ({ error: { message: "nothing_to_clear" } })), "p1")).error === "nothing_to_clear");
  const r = await setSellerPayoutAccount(ok, "u1", "acc_X", "active");
  check("L42 setSellerPayoutAccount maps args", r.ok && ok.calls[1][0] === "admin_set_seller_payout_account" && ok.calls[1][1].p_user_id === "u1" && ok.calls[1][1].p_account_id === "acc_X" && ok.calls[1][1].p_status === "active");
  check("L43 setSellerPayoutAccount surfaces the error", (await setSellerPayoutAccount(sb(() => ({ error: { message: "x" } })), "u", "a", "s")).error === "x");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
