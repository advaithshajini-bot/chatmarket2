// A53b-L -- unit tests for the seller payout status wording and loader (no database, no network).
import { describeStatus, describeAccount, getSellerPayoutStatus, STATUS_CODES } from "../../lib/domain/seller-payouts.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const REL = "2026-10-20T10:00:00Z";
const L = Object.fromEntries(STATUS_CODES.map((c) => [c, describeStatus({ status: c, release_date: c === "held" ? REL : null })]));

check("L01 every status code has a non-empty label and detail", STATUS_CODES.every((c) => L[c].label && L[c].detail && ["green", "amber", "red", "grey"].includes(L[c].tone)));
check("L02 held shows the release date", /^Held until 20 Oct 2026$/.test(L.held.label), L.held.label);
check("L03 held without a date still reads sensibly", describeStatus({ status: "held" }).label === "Held");
check("L04 dispute wording", L.dispute.label === "On hold: dispute raised");
check("L05 paid / reversed wording", L.paid.label === "Paid" && L.reversed.label === "Refunded");
check("L06 needs_account tells the seller what to do", /Action needed.*payout account/i.test(L.needs_account.label));
check("L07 only needs_account, reversed and action_needed are red", STATUS_CODES.filter((c) => L[c].tone === "red").sort().join() === "action_needed,needs_account,reversed");
check("L08 wording never mentions internals", STATUS_CODES.every((c) => !/razorpay|route|transfer|webhook|error|fail|parked|review_reason|acc_|trf_|pay_|sweep|ledger/i.test(L[c].label + " " + L[c].detail)), STATUS_CODES.filter((c) => /razorpay|route|transfer|webhook|error|fail|parked|ledger/i.test(L[c].label + L[c].detail)));
check("L09 under_review is calm and gives no reason", /Being reviewed by our team/.test(L.under_review.label) && /don't need to do anything/.test(L.under_review.detail));
check("L10 unknown status degrades safely", describeStatus({ status: "weird" }).label === "Status unavailable" && describeStatus(null).label === "Status unavailable");
check("L11 account banner", describeAccount("active").needsAction === false && describeAccount("pending").needsAction === false && describeAccount("suspended").needsAction === true && describeAccount("none").needsAction === true && describeAccount(undefined).label === "No UPI ID saved");

const ok = { account_status: "active", summary: {}, items: [{ a: 1 }] };
const sb = (impl) => { const calls = []; return { calls, rpc: async (fn, a) => { calls.push([fn, a]); return impl(); } }; };
const s1 = sb(() => ({ data: ok, error: null }));
check("L20 loader calls seller_payout_status with a bounded limit and NO seller id", (await getSellerPayoutStatus(s1)).account_status === "active" && s1.calls[0][0] === "seller_payout_status" && JSON.stringify(s1.calls[0][1]) === '{"p_limit":100}');
for (const [label, impl] of [["error", () => ({ data: ok, error: { message: "SECRET internals" } })], ["null", () => ({ data: null, error: null })], ["malformed", () => ({ data: { items: "x" }, error: null })], ["throw", () => { throw new Error("SECRET"); }]]) {
  const r = await getSellerPayoutStatus(sb(impl));
  check(`L21 loader fails soft on ${label}, with no error text passed on`, r.error === true && r.items.length === 0 && r.account_status === "none" && !JSON.stringify(r).includes("SECRET"));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
