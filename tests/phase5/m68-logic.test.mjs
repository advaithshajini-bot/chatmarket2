// A68 -- manual bank payouts: form validation, CSV, bank-only payout page, API route, migration guardrails. Static; no database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const noComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, "")).join("\n");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const B = await import("../../lib/domain/bank-payout.js");
const S = await import("../../lib/domain/admin-settlement.js");

const good = { beneficiaryName: "Asha Rao", accountNumber: "0012345678901", confirmAccountNumber: "0012345678901", ifsc: "hdfc0001234", accountType: "current" };
const v = B.validateBankPayoutForm(good);
check("L01 a valid form passes and is normalised (IFSC upper-case, type kept, leading zeros kept)", v.ok && v.value.ifsc === "HDFC0001234" && v.value.accountType === "current" && v.value.accountNumber === "0012345678901", v);
check("L02 account number: 8 digits and 19 digits fail, 9 and 18 pass", !B.validateBankPayoutForm({ ...good, accountNumber: "12345678", confirmAccountNumber: "12345678" }).ok && !B.validateBankPayoutForm({ ...good, accountNumber: "1".repeat(19), confirmAccountNumber: "1".repeat(19) }).ok && B.validateBankPayoutForm({ ...good, accountNumber: "1".repeat(9), confirmAccountNumber: "1".repeat(9) }).ok && B.validateBankPayoutForm({ ...good, accountNumber: "1".repeat(18), confirmAccountNumber: "1".repeat(18) }).ok);
check("L03 letters in the account number fail", !B.validateBankPayoutForm({ ...good, accountNumber: "12345678901A", confirmAccountNumber: "12345678901A" }).ok);
check("L04 the two account numbers must match", B.validateBankPayoutForm({ ...good, confirmAccountNumber: "0012345678902" }).errors.confirmAccountNumber !== undefined && !B.validateBankPayoutForm({ ...good, confirmAccountNumber: "" }).ok);
check("L05 IFSC: 4 letters, a zero, 6 alphanumerics", ["HDFC0001234", "SBIN0ABC123"].every((c) => B.validateBankPayoutForm({ ...good, ifsc: c }).ok) && ["HDFC1001234", "HDF0001234", "HDFC000123", ""].every((c) => !B.validateBankPayoutForm({ ...good, ifsc: c }).ok));
check("L06 beneficiary name is required (2+ letters)", !B.validateBankPayoutForm({ ...good, beneficiaryName: "" }).ok && !B.validateBankPayoutForm({ ...good, beneficiaryName: "A" }).ok && !B.validateBankPayoutForm({ ...good, beneficiaryName: "1234" }).ok);
check("L07 unknown account type falls back to savings", B.validateBankPayoutForm({ ...good, accountType: "wallet" }).value.accountType === "savings");
check("L08 masking shows only ****1234", B.maskBankAccount("8901") === "****8901" && B.maskBankAccount("0012345678901") === "****8901" && B.maskBankAccount("") === "" && B.maskBankAccount(null) === "");
check("L09 the badge text is exactly 'Bank Account Configured for Payouts'", B.describeBankPayout({ configured: true }).label === "Bank Account Configured for Payouts" && B.describeBankPayout({ configured: false }).tone === "red");

// CSV
const batch = { label: "2026-10" };
const items = [
  { status: "pending", seller_name: "Seller", bank_beneficiary_name: "Asha Rao", bank_account_number: "0012345678901", bank_ifsc: "HDFC0001234", bank_account_type: "savings", amount_paise: 49200, purchase_count: 3, item_id: "i1" },
  { status: "pending", seller_name: "=cmd|x", bank_beneficiary_name: "=HYPERLINK(\"x\")", bank_account_number: "123456789012", bank_ifsc: "ICIC0004321", bank_account_type: "current", amount_paise: 5, purchase_count: 1, item_id: "i2" },
  { status: "paid", bank_beneficiary_name: "Paid Already", bank_account_number: "555566667777", bank_ifsc: "SBIN0001111", bank_account_type: "savings", amount_paise: 100, item_id: "i3" },
  { status: "pending", seller_name: "Old UPI", vpa_address: "a@okbank", amount_paise: 100, item_id: "i4" },
];
const csv = S.buildSettlementCsv(batch, items);
const lines = csv.trimEnd().split("\r\n");
check("L10 the CSV header is exactly Beneficiary Name, Account Number, IFSC Code, Account Type, Net Payout (INR) (+ Remarks)", lines[0] === "Beneficiary Name,Account Number,IFSC Code,Account Type,Net Payout (INR),Remarks", lines[0]);
check("L11 one row per pending item with a bank snapshot (paid and UPI-only rows are left out)", lines.length === 3, lines);
check("L12 row 1 is clean: name, quoted account number with its leading zeros, IFSC, Savings, 492.00", lines[1] === 'Asha Rao,"0012345678901",HDFC0001234,Savings,492.00,Chatmarket payout 2026-10', lines[1]);
check("L13 formula injection is neutralised in the name and the amount is exact paise", lines[2].startsWith('"\'=HYPERLINK') && lines[2].includes(",Current,0.05,"), lines[2]);
check("L14 no UPI column or value appears in the CSV", !/upi|vpa|okbank/i.test(csv));
check("L16 blocked reasons use the bank wording", S.BLOCKED_LABELS.no_bank_account && S.BLOCKED_LABELS.bank_in_cooldown && !S.BLOCKED_LABELS.no_upi_id && !S.BLOCKED_LABELS.upi_in_cooldown);

// Page / form / API
const page = noComments(read("app/sell/payout/page.jsx")), form = noComments(read("components/BankPayoutForm.jsx")), api = noComments(read("app/api/sell/payout-bank/route.js"));
check("L20 /sell/payout renders the bank form for everyone and has no UPI form", /<BankPayoutForm/.test(page) && !/set_my_payout_vpa|validateUpi|maskUpi|id="upi"|RouteOnboardingForm|route_enabled|getMyDirectSellerStatus|UPI/.test(page));
check("L21 the form has the five fields: beneficiary, account, confirm, IFSC (+lookup), account type", ["beneficiaryName", "accountNumber", "confirmAccountNumber", "ifsc", "accountType"].every((f) => form.includes(f)) && /\/api\/ifsc\//.test(form) && /Savings/.test(form) && /Current/.test(form));
check("L22 the form posts to /api/sell/payout-bank and never to the UPI RPC", /\/api\/sell\/payout-bank/.test(form) && !/set_my_payout_vpa/.test(form));
check("L23 after saving it shows the masked account, the IFSC and the green badge", /maskBankAccount\(saved\.last4\)/.test(form) && /saved\.ifsc/.test(form) && /describeBankPayout/.test(form) && /#2F6F62/.test(form));
check("L24 the API route calls set_my_bank_payout with the caller's own session (no service key) and requires login", /rpc\("set_my_bank_payout"/.test(api) && !/service/i.test(api) && /401/.test(api));
check("L25 the API route never returns the full account number", !/accountNumber:\s*form\.value\.accountNumber/.test(api) && /last4/.test(api));
const sell = noComments(read("app/sell/page.jsx"));
check("L26 the sell page gate uses the saved bank account (BankGate) when direct UPI is off", /getMyBankPayout/.test(sell) && /BankGate/.test(sell) && /directStatus\.flag_on \? !hasUpi : !hasBank/.test(sell));
check("L27 the listing API maps bank_account_required", /bank_account_required/.test(read("app/api/listings/create-workflow-agent/route.js")));
const priv = read("app/privacy/page.jsx");
check("L28 privacy no longer says bank details are not stored", !/we keep only the resulting account identifier/i.test(priv) && /last four digits/i.test(priv));

// Migration guardrails
const m = read("supabase/migrations/20261029100000_manual_bank_payouts.sql"), low = noComments(m).toLowerCase();
check("L30 bank_account_number has the 9-18 digit check", /bank_account_number is null or bank_account_number ~ '\^\[0-9\]\{9,18\}\$'/.test(m));
check("L31 the full number is revoked from anon/authenticated and granted to service_role only", /revoke select \(bank_account_number, bank_changed_at\) on public\.seller_payout_accounts from anon, authenticated/.test(m) && /grant select \(bank_account_number, bank_changed_at\) on public\.seller_payout_accounts to service_role/.test(m) && !/grant select \([^)]*bank_account_number[^)]*\) on public\.seller_payout_accounts to authenticated/.test(m));
check("L32 set_my_bank_payout: SECURITY DEFINER, empty search_path, requires auth.uid(), granted to authenticated only", /create or replace function public\.set_my_bank_payout\(p_account_number text, p_ifsc text, p_beneficiary text, p_account_type text default 'savings'\)/.test(m) && /set search_path = ''/.test(m) && /login_required/.test(m) && /grant execute on function public\.set_my_bank_payout\(text, text, text, text\) to authenticated/.test(m));
check("L33 nothing is dropped except the one widened constraint; no feature flag is touched; direct-UPI objects are not removed", !/\bdrop\s+(table|column|function|trigger|index|policy)\b/.test(low) && (low.match(/drop constraint/g) || []).length === 1 && !/update private\.feature_flags|insert into private\.feature_flags/.test(low));
check("L34 the admin functions all require admin + MFA", (m.match(/private\.is_admin_mfa\(\)/g) || []).length >= 3);
check("L35 the settlement snapshot freezes number, IFSC, beneficiary and type", /insert into public\.settlement_items \(batch_id, seller_id, bank_account_number, bank_ifsc, bank_beneficiary_name, bank_account_type/.test(m));

console.log(`\nA68: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
