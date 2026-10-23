// A56-L -- unit tests for monthly settlement helpers (no database, no network).
import {
  csvCell, buildSettlementCsv, csvFilename, paiseToRupeesString, CSV_HEADER, defaultSettlementPeriod, startOfIstMonthIso, istDateToIso,
  isValidReference, explainSettlementError, BLOCKED_LABELS, getSettlementPending, settleItems, createSettlementBatch, releaseSettlementItem, cancelSettlementBatch,
} from "../../lib/domain/admin-settlement.js";
import { describeSettlement, describeSettlementAccount, formatPayoutDate, getSellerSettlementStatus, SETTLEMENT_CODES } from "../../lib/domain/seller-settlement.js";

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}

// ---- money
check("L01 paise -> rupees string, integer math", paiseToRupeesString(49200) === "492.00" && paiseToRupeesString(5) === "0.05" && paiseToRupeesString(100) === "1.00" && paiseToRupeesString(123456789) === "1234567.89");
check("L02 invalid paise -> empty", paiseToRupeesString(1.5) === "" && paiseToRupeesString(-1) === "" && paiseToRupeesString(null) === "");

// ---- CSV
check("L03 plain cell untouched", csvCell("Seller One") === "Seller One");
check("L04 comma / quote / newline are quoted and escaped", csvCell('A, "B"') === '"A, ""B"""' && csvCell("a\nb") === '"a\nb"');
for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
  check(`L05 formula injection neutralised: ${JSON.stringify(evil).slice(0, 18)}`, csvCell(evil).replace(/^"/, "").startsWith("'"));
}
const batch = { label: "2026-10" };
const items = [
  { item_id: "i1", seller_name: "=cmd|' /C calc'!A0", vpa_address: "a@okbank", amount_paise: 49200, purchase_count: 2, status: "pending", utr: null },
  { item_id: "i2", seller_name: "Bob, Jr.", vpa_address: "b@ybl", amount_paise: 5, purchase_count: 1, status: "paid", utr: "REF1" },
  { item_id: "i3", seller_name: null, vpa_address: "c@paytm", amount_paise: 100, purchase_count: 1, status: "pending", utr: null },
];
const csv = buildSettlementCsv(batch, items);
const lines = csv.trimEnd().split("\r\n");
check("L06 header + pending rows only by default, CRLF line endings", lines[0] === CSV_HEADER.join(",") && lines.length === 3 && csv.endsWith("\r\n"), lines);
check("L07 a seller name that is a formula is neutralised in the file", lines[1].startsWith("\"'=cmd") || lines[1].startsWith("'=cmd"), lines[1]);
check("L08 amount is in rupees with two decimals; note carries the batch label; missing name -> Seller", lines[1].includes(",492.00,") && lines[1].includes("Chatmarket payout 2026-10") && lines[2].startsWith("Seller,c@paytm,1.00,"), lines);
check("L09 onlyPending:false includes paid rows with their reference", buildSettlementCsv(batch, items, { onlyPending: false }).includes("REF1") && buildSettlementCsv(batch, items, { onlyPending: false }).trimEnd().split("\r\n").length === 4);
check("L10 empty / junk input gives just a header", buildSettlementCsv(batch, null) === CSV_HEADER.join(",") + "\r\n");
check("L11 filename is a safe slug", csvFilename({ label: "2026-10" }) === "chatmarket-settlement-2026-10.csv" && csvFilename({ label: "../../etc/passwd" }) === "chatmarket-settlement-etc-passwd.csv" && csvFilename(null) === "chatmarket-settlement-batch.csv");

// ---- IST period
const dp = defaultSettlementPeriod(new Date("2026-11-01T02:00:00Z")); // 07:30 IST on 1 Nov
check("L12 on 1 Nov IST the default run is October, cut-off 1 Nov", dp.label === "2026-10" && dp.cutoffDate === "2026-11-01" && dp.todayDate === "2026-11-01", dp);
const dp2 = defaultSettlementPeriod(new Date("2026-10-31T20:00:00Z")); // 01:30 IST on 1 Nov
check("L13 the IST day, not the UTC day, decides the month", dp2.cutoffDate === "2026-11-01" && dp2.label === "2026-10", dp2);
check("L14 January rolls back to December of the previous year", defaultSettlementPeriod(new Date("2027-01-05T10:00:00Z")).label === "2026-12");
check("L15 startOfIstMonthIso is midnight IST (18:30 UTC the day before)", startOfIstMonthIso(new Date("2026-11-15T10:00:00Z")) === "2026-10-31T18:30:00.000Z");
check("L16 istDateToIso", istDateToIso("2026-11-01") === "2026-10-31T18:30:00.000Z" && istDateToIso("nope") === null && istDateToIso("2026-13-45") === null && istDateToIso(null) === null);

// ---- reference
check("L17 reference validator mirrors the database rule", isValidReference("UTR 4012 8899") && isValidReference("BULK-OCT/26_1") && !isValidReference("") && !isValidReference("  ") && !isValidReference("a;b") && !isValidReference("-x") && !isValidReference("a".repeat(81)) && isValidReference("a".repeat(80)));

// ---- errors
check("L18 database errors become plain sentences, never raw text", /already open/.test(explainSettlementError({ message: "open_batch_exists" })) && /final/.test(explainSettlementError({ message: "batch_not_open" })) && /MFA/.test(explainSettlementError({ code: "42501", message: "admin_required" })) && explainSettlementError({ message: "SECRET internals" }, "fallback") === "fallback");

// ---- wrappers
const sb = (impl) => { const calls = []; return { calls, rpc: async (fn, a) => { calls.push([fn, a]); return impl(fn, a); } }; };
const ok = sb(() => ({ data: { settled_count: 1 }, error: null }));
await settleItems(ok, "b1", "REF", ["i1"]); await settleItems(ok, "b1", "REF");
check("L19 settleItems maps args (null = all pending)", ok.calls[0][0] === "admin_settle_items" && ok.calls[0][1].p_item_ids[0] === "i1" && ok.calls[1][1].p_item_ids === null);
await createSettlementBatch(ok, { label: "L", periodEndIso: "2026-10-31T18:30:00.000Z" }); await releaseSettlementItem(ok, "i", "why"); await cancelSettlementBatch(ok, "b");
check("L20 create / release / cancel map args", ok.calls[2][1].p_label === "L" && ok.calls[3][1].p_reason === "why" && ok.calls[4][1].p_batch_id === "b");
const bad = await settleItems(sb(() => ({ data: null, error: { message: "SECRET internals", code: "CM076" } })), "b", "R");
check("L21 action errors carry no internal text", bad.error && !/SECRET/.test(bad.error));
const thrown = await settleItems({ rpc: async () => { throw new Error("SECRET"); } }, "b", "R");
check("L22 a thrown error fails soft", thrown.error === "Could not record the payment.");
const p0 = await getSettlementPending(sb(() => ({ data: null, error: { message: "x" } })));
check("L23 the pending loader fails soft with an empty shape", p0.error === true && p0.payable.length === 0 && p0.totals.payable_paise === 0);
const pc = sb(() => ({ data: { payable: [] }, error: null })); await getSettlementPending(pc, "2026-10-31T18:30:00.000Z");
check("L24 pending loader passes the cut-off and a bounded limit", pc.calls[0][1].p_period_end === "2026-10-31T18:30:00.000Z" && pc.calls[0][1].p_limit === 500);

// ---- seller wording
const D = Object.fromEntries(SETTLEMENT_CODES.map((c) => [c, describeSettlement({ status: c })]));
check("L25 every code has label, detail, tone", SETTLEMENT_CODES.every((c) => D[c].label && D[c].detail && ["green", "amber", "red", "grey"].includes(D[c].tone)));
check("L26 wording", D.settled.label === "Paid" && D.in_batch.label === "Being paid" && D.unsettled.label === "Unsettled" && /add your UPI ID/i.test(D.needs_upi.label) && D.refunded.label === "Refunded");
check("L27 only needs_upi is red", SETTLEMENT_CODES.filter((c) => D[c].tone === "red").join() === "needs_upi");
check("L28 no internals or debt language", SETTLEMENT_CODES.every((c) => !/razorpay|route|transfer|webhook|error|batch|admin|debt|owe|deduct|recover|negative|clawback|taken back from you/i.test(D[c].label + " " + D[c].detail)));
check("L29 unknown status degrades safely", describeSettlement({ status: "weird" }).label === "Status unavailable" && describeSettlement(null).label === "Status unavailable");
check("L30 account banner", describeSettlementAccount("active").needsAction === false && describeSettlementAccount("suspended").needsAction === true && describeSettlementAccount("none").needsAction === true);
check("L31 payout date is pinned to the calendar date", formatPayoutDate("2026-11-01") === "1 Nov 2026" && formatPayoutDate("2026-11-01T00:00:00Z") === "1 Nov 2026" && formatPayoutDate(null) === "" && formatPayoutDate("garbage") === "");
const okS = { account_status: "active", summary: {}, items: [], payouts: [] };
const s1 = sb(() => ({ data: okS, error: null }));
check("L32 seller loader calls seller_settlement_status with a bounded limit and NO seller id", (await getSellerSettlementStatus(s1)).account_status === "active" && s1.calls[0][0] === "seller_settlement_status" && JSON.stringify(s1.calls[0][1]) === '{"p_limit":100}');
for (const [label, impl] of [["error", () => ({ data: okS, error: { message: "SECRET internals" } })], ["null", () => ({ data: null, error: null })], ["malformed", () => ({ data: { items: "x" }, error: null })], ["no payouts array", () => ({ data: { items: [] }, error: null })]]) {
  const r = await getSellerSettlementStatus(sb(impl));
  check(`L33 seller loader fails soft on ${label}`, r.error === true && r.items.length === 0 && r.payouts.length === 0 && r.summary.unsettled_paise === 0 && !JSON.stringify(r).includes("SECRET"));
}
check("L34 below_minimum has an admin label; the empty loaders carry min_payout_paise 0", /roll/i.test(BLOCKED_LABELS.below_minimum) && (await getSellerSettlementStatus(sb(() => ({ data: null, error: null })))).min_payout_paise === 0 && (await getSettlementPending(sb(() => ({ data: null, error: null })))).min_payout_paise === 0);
console.log(`\nM56-LOGIC: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
