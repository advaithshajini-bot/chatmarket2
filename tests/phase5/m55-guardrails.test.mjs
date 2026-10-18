// A55-G -- static guardrails for Milestone 5.4 (instant UPI payouts, non-recourse). Reads source; no database, no network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateUpi, maskUpi, UPI_REGEX } from "../../lib/domain/upi.js";
import { describeStatus, describeAccount, STATUS_CODES } from "../../lib/domain/seller-payouts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
function stripComments(src, kind) {
  let out = "", i = 0, q = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) { out += c; if (c === "\\" && kind === "js") { out += n ?? ""; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === "'" || (kind === "js" && (c === '"' || c === "`"))) { q = c; out += c; i++; continue; }
    if (kind === "sql" && c === "-" && n === "-") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (kind === "js" && c === "/" && n === "/" && src[i - 1] !== ":") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}
const MIG = "supabase/migrations/20261018100000_add_vpa_payouts.sql";
const m = stripComments(read(MIG), "sql"), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

// ---------------------------------------------------------------- migration
check("G01 the 5.4 migration is the newest and additive: no drop table / drop column / delete / truncate of existing data", migs.at(-1) === path.basename(MIG) && !/\bdrop\s+(table|column|schema)\b|\btruncate\b|\bdelete\s+from\b/.test(lower));
check("G02 the new flag is seeded OFF and nothing in the migration turns any flag on", /insert into private\.feature_flags \(name, enabled\) values \('phase6_vpa_payouts', false\)/.test(m) && !/set\s+enabled\s*=\s*true|enabled\s*\)?\s*values\s*\([^)]*true/.test(lower));
check("G03 cutoff_at defaults to infinity (fail closed) and there is a per-payout cap", /cutoff_at\s+timestamptz not null default 'infinity'/.test(m) && /max_payout_paise\s+integer not null default 500000/.test(m));
check("G04 Route and UPI payouts are mutually exclusive at flag level", /create or replace function private\.is_route_transfers_enabled[\s\S]*?phase6_vpa_payouts[\s\S]*?is not true/.test(m) && /create function private\.is_vpa_payouts_enabled[\s\S]*?phase5_route_transfers[\s\S]*?is not true/.test(m));
check("G05 there is no hold, no hold_until and no 48-hour logic anywhere in the new payout path (only in the retained legacy Route branch of the seller status)", (() => {
  const body = m.slice(0, m.indexOf("create or replace function private.payment_attention_rows"));
  return !/hold_until|on_hold|48\s*hour|interval '48/.test(body);
})());
check("G06 one ledger row per purchase: unique(purchase_id)", /purchase_id\s+uuid not null unique references public\.purchases/.test(m));
check("G07 the payout key is the purchase id (idempotency) and a retry only appends -vN", /case when v_v\.key_version > 1 then p_purchase_id::text \|\| '-v' \|\| v_v\.key_version else p_purchase_id::text end/.test(m));
check("G08 a late 'failed'/'cancelled' can never undo a processed payout", /p_status in \('failed', 'cancelled'\) and v_v\.status = 'processed'[\s\S]{0,80}'stale'/.test(m));
check("G09 admin retry refuses a processed payout (only failed / cancelled / reversed)", /v_v\.status not in \('failed', 'cancelled', 'reversed'\)/.test(m));
check("G10 service_role-only RPCs are revoked from public/anon/authenticated and granted to service_role", ["plan_vpa_payout(uuid)", "record_vpa_fund_account(uuid, text, text, text)", "apply_vpa_payout_event(text, uuid, text, text, bigint, integer, text, text)", "record_vpa_payout_failure(uuid, text, boolean)", "list_vpa_payout_work(integer)"].every((f) => lower.includes(`revoke all on function public.${f}`) && lower.includes(`grant execute on function public.${f} to service_role`)));
check("G11 every function is SECURITY DEFINER with an empty search_path (mask_vpa is a pure immutable helper with an empty search_path)", (() => {
  const blocks = m.split(/\bcreate (?:or replace )?function /).slice(1);
  return blocks.length >= 14 && blocks.every((b) => /set search_path = ''/.test(b.split(/\$\$/)[0]) && (/security definer/.test(b.split(/\$\$/)[0]) || /^private\.mask_vpa/.test(b)));
})());
check("G12 the seller can only read their own UPI id and status; Razorpay ids are not granted", /revoke select on public\.seller_payout_accounts from authenticated;\s*grant select \(user_id, vpa_address, status, updated_at\)/.test(m) && !/grant select \([^)]*razorpay/.test(m));
check("G13 the seller's own UPI write is a function with the UPI format check, a rate limit and a masked audit row", /set_my_payout_vpa/.test(m) && /too_many_changes/.test(m) && /private\.mask_vpa\(v_vpa\)/.test(m));
check("G14 admin functions start with the admin + MFA check", ["admin_retry_vpa_payout", "admin_set_seller_payout_status", "admin_vpa_payouts_ledger"].every((f) => new RegExp(`function public\\.${f}[\\s\\S]*?begin\\s+if not \\(select private\\.is_admin_mfa\\(\\)\\)`).test(m)));
check("G15 the UPI id is stored lower-cased and the regex in the DB equals the one in the browser", UPI_REGEX.source === "^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$" && m.includes("'^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$'"));
check("G16 error code CM075 is new to this migration", /CM075/.test(m) && migs.filter((f) => f !== path.basename(MIG)).every((f) => !read("supabase/migrations/" + f).includes("CM075")));

// ---------------------------------------------------------------- non-recourse: no seller debt anywhere
const noDebt = /negative[_ -]?balance|chargeback[_ -]?debt|recovered[_ -]?loss|claw[_ -]?back|clawback|seller[_ -]?debt|owed to (us|platform)/i;
const uiFiles = ["lib/domain/seller-payouts.js", "components/SellerPayoutPanel.jsx", "components/SellerEarningsClient.jsx", "app/sell/payout/page.jsx", "app/sell/earnings/page.jsx", "lib/domain/admin-payments.js", "components/AdminPaymentsDesk.jsx", "app/admin/payments/page.jsx"];
for (const f of uiFiles) {
  const t = stripComments(read(f), "js");
  check(`G20 ${f}: no negative-balance / chargeback-debt / recovered-loss / clawback concept (code and visible text)`, !noDebt.test(t));
}
// comments may say "never": code and SQL must not CREATE any such concept
check("G21 the migration has no negative-balance, debt, clawback or reversal-against-seller concept in SQL", !noDebt.test(m));
check("G22 the seller status function never subtracts reversals from instant payouts (paid sum = share - amount_reversed only for legacy transfers, which are 0 for UPI)", /filter \(where c\.code in \('paid', 'instant_paid'\)\)/.test(m));
check("G23 the payout libs never call a reverse / refund / hold API and never read disputes", (() => {
  const t = ["lib/payments/vpa-payouts.js", "lib/payments/payout-events.js"].map((f) => stripComments(read(f), "js")).join("\n");
  return !/reverseTransfer|createRefund|setTransferHold|dispute/i.test(t);
})());
check("G24 no dispute-driven code path touches vpa_payouts (disputes stay support tickets)", !/vpa_payouts/.test(stripComments(read("lib/payments/disputes.js"), "js")) && !/vpa_payouts/.test(stripComments(read("supabase/migrations/20261014100000_add_dispute_actions.sql"), "sql")));
check("G25 the one place that mentions a dispute in the seller's status function cannot change a UPI payout (UPI branches come first)", (() => { const s = lower.indexOf("when s.vstatus = 'processed'"); const d = lower.indexOf("when s.dstatus = 'open'"); return s > 0 && d > s; })());

// ---------------------------------------------------------------- libs / routes
const razor = stripComments(read("lib/payments/razorpay-client.js"), "js");
check("G30 the payout request sends X-Payout-Idempotency, mode UPI and the RazorpayX account number from config (never hard-coded)", /X-Payout-Idempotency/.test(razor) && /mode: "UPI"/.test(razor) && /account_number: accountNumber/.test(razor) && !/RAZORPAYX_ACCOUNT_NUMBER/.test(razor.replace(/description: "RAZORPAYX_ACCOUNT_NUMBER missing"/g, "")));
check("G31 the account number is read from the env var NAME only, in the two routes", ["app/api/razorpay/webhook/route.js", "app/api/payments/transfers/sweep/route.js"].every((f) => /process\.env\.RAZORPAYX_ACCOUNT_NUMBER/.test(read(f))));
check("G32 no secret value appears in the new files", !/rzp_(test|live)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}/.test(["lib/payments/vpa-payouts.js", "lib/payments/payout-events.js", "lib/domain/upi.js", "app/sell/payout/page.jsx"].map(read).join("")));
check("G33 the webhook route runs the payout hook after the transfer hook, and each is a no-op while its flag is off (decided in the database)", /payoutPurchase\(\{ db, rzp, purchaseId \}\)/.test(read("app/api/razorpay/webhook/route.js")) && /payoutPurchase/.test(read("app/api/razorpay/webhook/route.js")));
check("G34 the webhook handler routes payout.* events through apply_vpa_payout_event and never logs the payload", /isPayout/.test(read("lib/payments/webhook-handler.js")) && /applyVpaPayoutEvent/.test(read("lib/payments/webhook-handler.js")) && !/console\./.test(read("lib/payments/webhook-handler.js")));
check("G35 the reconciliation pass runs the payout sweep", /runPayoutSweep/.test(read("lib/payments/reconcile.js")));
check("G36 the payout orchestration claims in the database BEFORE calling Razorpay", (() => { const t = stripComments(read("lib/payments/vpa-payouts.js"), "js"); return t.indexOf("db.planVpaPayout") > 0 && t.indexOf("db.planVpaPayout") < t.indexOf("rzp.createVpaPayout") && t.indexOf("rzp.listPayoutsByReference") < t.indexOf("rzp.createVpaPayout"); })());
check("G37 the plan function is never called from browser code", !/planVpaPayout|plan_vpa_payout|apply_vpa_payout_event/.test(["app/sell/payout/page.jsx", "app/sell/page.jsx", "components/SellerPayoutPanel.jsx", "components/AdminPaymentsDesk.jsx", "lib/domain/admin-payments.js", "lib/domain/seller-payouts.js"].map((f) => stripComments(read(f), "js")).join("")));

// ---------------------------------------------------------------- the seller's page
const page = read("app/sell/payout/page.jsx"), pageC = stripComments(page, "js");
check("G40 /sell/payout has exactly one input (the UPI id) and no document / bank / IFSC / PAN / business inputs", (pageC.match(/<input\b/g) || []).length === 1 && !/IFSC|ifsc|\bPAN\b|aadhaar|passport|bank account|<select|type="file"|DatePicker|GST|business/i.test(pageC));
check("G41 it saves only through set_my_payout_vpa (no direct table write)", /rpc\("set_my_payout_vpa"/.test(pageC) && !/\.(insert|update|upsert|delete)\(/.test(pageC));
check("G42 it validates with the shared validator as you type", /validateUpi\(input\)/.test(pageC) && /onChange=/.test(pageC));
check("G43 it shows the 'All sales are final' notice", /All sales are final/.test(page));
check("G44 the old KYC wizard, OTP routes and storage uploads are gone from the payout page and routes", !exists("app/api/kyc/send-otp/route.js") && !exists("app/api/kyc/verify-otp/route.js") && !/seller-kyc-documents|send-otp|verify-otp|storage\.from/.test(pageC));
const sell = stripComments(read("app/sell/page.jsx"), "js"), route = stripComments(read("app/api/listings/create-workflow-agent/route.js"), "js");
check("G45 the listing gate is 'has a saved UPI ID' in the page and in the server route, not seller_kyc", /seller_payout_accounts/.test(sell) && /if \(!hasUpi\)/.test(sell) && !/seller_kyc|kycStatus/.test(sell) && /seller_payout_accounts/.test(route) && /vpa_address/.test(route) && !/seller_kyc/.test(route));
check("G46 the earnings page and panel carry the 'All sales are final' wording and the Refunded red card is gone", /All sales are final/.test(read("components/SellerEarningsClient.jsx")) && /All sales are final/.test(read("components/SellerPayoutPanel.jsx")) && !/label="Refunded"/.test(read("components/SellerEarningsClient.jsx")));

// ---------------------------------------------------------------- wording / validator
for (const [raw, ok] of [["asha@okhdfcbank", true], ["Asha.K@OkHDFCBank", true], ["  a_b-c.d@ybl ", true], ["9876543210@paytm", true], ["ab@x", false], ["a@b", false], ["asha", false], ["asha@@ybl", false], ["a sha@ybl", false], ["", false], [null, false], ["asha@1ybl", false], ["-asha@ybl", false]]) {
  check(`G50 validateUpi(${JSON.stringify(raw)}) -> ${ok}`, validateUpi(raw).ok === ok);
}
check("G51 an empty field shows no error (no red text before typing)", validateUpi("").error === null && validateUpi("   ").error === null);
check("G52 a wrong id gets plain-English guidance", /@/.test(validateUpi("nobank").error) && /valid UPI ID/.test(validateUpi("a@b").error));
check("G53 maskUpi hides all but two characters", maskUpi("asha.k@okhdfcbank") === "as***@okhdfcbank" && maskUpi("nonsense") === "");
check("G54 the instant-payout wording", describeStatus({ status: "instant_paid" }).label === "Instant payout: Paid" && describeStatus({ status: "instant_in_progress" }).label === "Instant payout: In progress" && /UPI ID/.test(describeStatus({ status: "action_needed" }).label));
check("G55 every status code has a real label", STATUS_CODES.every((c) => describeStatus({ status: c }).label !== "Status unavailable"));
check("G56 no status wording mentions refunds taken back, debts or deductions", STATUS_CODES.every((c) => { const d = describeStatus({ status: c, release_date: "2026-10-20" }); return !/debt|deduct|owe|recover|negative|clawback|taken back from you/i.test(d.label + d.detail); }));
check("G57 account wording is about the UPI ID", /UPI ID/.test(describeAccount("active").label) && /UPI ID/.test(describeAccount("none").label));
check("G58 the legacy 48-hour wording appears only on the legacy 'held' status", STATUS_CODES.filter((c) => /48/.test(describeStatus({ status: c }).detail + describeStatus({ status: c }).label)).join() === "held");

check("G60 action_needed is red and tells the seller to check the UPI ID", describeStatus({ status: "action_needed" }).tone === "red" && /UPI ID/.test(describeStatus({ status: "action_needed" }).detail));
check("G61 the Save button is disabled unless the UPI id is valid", /disabled=\{!v\.ok \|\| saving/.test(pageC));
check("G62 the server route refuses listing without a UPI id (403)", /if \(!payoutAccount\?\.vpa_address\) \{[\s\S]{0,200}status: 403/.test(route));
{
  const lib = stripComments(read("lib/domain/admin-payments.js"), "js"), desk = stripComments(read("components/AdminPaymentsDesk.jsx"), "js");
  check("G63 only failed / cancelled / reversed payouts can be retried from the desk (never processed)", /RETRYABLE_PAYOUT_STATUSES = \["failed", "cancelled", "reversed"\]/.test(lib) && /RETRYABLE_PAYOUT_STATUSES\.includes\(t\.status\)/.test(desk) && /\["payout_failed", "payout_parked", "payout_returned"\]\.includes\(i\.kind\)/.test(desk));
}

console.log(`\nA55-G: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
