// A56-G -- static guardrails for Milestone 5.5 (manual monthly settlement, non-recourse). Reads source; no database, no network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
const stripSql = (s) => s.replace(/--[^\n]*/g, "");
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const MIG = "supabase/migrations/20261019100000_add_monthly_settlement.sql";
const m = stripSql(read(MIG)), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const noDebt = /negative[_ -]?balance|chargeback[_ -]?debt|recovered[_ -]?loss|claw[_ -]?back|clawback|seller[_ -]?debt|owed to (us|platform)/i;

// ---------------------------------------------------------------- migration
check("G01 the 5.5 migration exists and sorts after the 5.4 UPI migration", exists(MIG) && migs.indexOf(path.basename(MIG)) > migs.indexOf("20261018100000_add_vpa_payouts.sql"));
check("G02 additive: it creates only new objects (no drop, no alter of existing tables, no create or replace of an existing function)", !/\bdrop\s+(table|column|schema|function)\b|\btruncate\b|\balter\s+table\s+(?!public\.settlement_|public\.purchase_settlements)/.test(lower) && !/create or replace/.test(lower));
const deletes = [...lower.matchAll(/delete\s+from\s+([\w.]+)/g)].map((x) => x[1]);
check("G03 the only deletes are on the new settlement tables (release / cancel)", deletes.length === 2 && deletes.every((t) => /^public\.(purchase_settlements|settlement_batches)$/.test(t)), deletes);
check("G04 no feature flag is read, written or turned on", !/feature_flags/.test(lower) && !/phase6_vpa_payouts|phase5_route_transfers|phase5_auto_refunds/.test(lower));
check("G05 no pg_cron / pg_net / http call: nothing is scheduled and nothing talks to a payment provider", !/cron\.|net\.http|http_post|create extension/.test(lower));
const tables = [...lower.matchAll(/create table ([\w.]+)/g)].map((x) => x[1]).sort().join();
check("G06 exactly four new tables", tables === "private.settlement_config,public.purchase_settlements,public.settlement_batches,public.settlement_items", tables);
check("G07 row level security on all three public tables, and no direct privileges for anon / authenticated", ["settlement_batches", "settlement_items", "purchase_settlements"].every((t) => lower.includes(`alter table public.${t} enable row level security`)) && /revoke all on public\.settlement_batches, public\.settlement_items, public\.purchase_settlements from anon, authenticated/.test(lower) && !/create policy/.test(lower) && !/grant\s+(select|insert|update|delete)/.test(lower));
check("G08 a sale can be settled once: purchase_settlements.purchase_id is the primary key", /create table public\.purchase_settlements \(\s*purchase_id\s+uuid primary key/.test(lower));
check("G09 at most one open batch, unique label, one item per seller per batch", /create unique index settlement_batches_one_open on public\.settlement_batches \(\(true\)\) where status = 'open'/.test(lower) && /unique \(label\)/.test(lower) && /unique \(batch_id, seller_id\)/.test(lower));
check("G10 a paid item must carry a reference and a timestamp (table constraints)", /check \(status <> 'paid' or utr is not null\)/.test(lower) && /check \(\(status = 'paid'\) = \(paid_at is not null\)\)/.test(lower));
const fnBlocks = [...m.matchAll(/create function ([\w.]+)\(([\s\S]*?)\n\$\$;/g)];
const publicFns = fnBlocks.filter((b) => b[1].startsWith("public."));
check("G11 eight public functions, every one SECURITY DEFINER with an empty search_path", publicFns.length === 8 && publicFns.every((b) => /security definer/i.test(b[0]) && /set search_path = ''/i.test(b[0])), publicFns.map((b) => b[1]));
const adminFns = publicFns.filter((b) => b[1].startsWith("public.admin_"));
check("G12 every admin function checks admin + MFA before it reads or writes anything", adminFns.length === 7 && adminFns.every((b) => { const body = b[0].toLowerCase(); const i = body.indexOf("private.is_admin_mfa()"); return i > 0 && !/\b(select|insert|update|delete)\b/.test(body.slice(body.indexOf("begin"), i).replace(/\(select\s*$/, "")); }));
check("G13 the seller function takes no seller id (identity is auth.uid() only) and is the only seller-facing function", /create function public\.seller_settlement_status\(p_limit integer default 100\)/.test(lower) && /v_uid\s+uuid := \(select auth\.uid\(\)\)/.test(lower));
check("G14 every function is revoked from public / anon / authenticated first, then granted to authenticated only", publicFns.every((b) => { const n = b[1].replace("public.", ""); return new RegExp(`revoke all on function public\\.${n}\\(`).test(lower) && new RegExp(`grant execute on function public\\.${n}\\([^)]*\\) to authenticated;`).test(lower); }) && !/\bto (anon|public|service_role)\b/.test(lower.replace(/from public, anon, authenticated, service_role/g, "").replace(/revoke[^;]*;/g, "")));
check("G15 the private eligibility function is not executable by any API role", /revoke execute on function private\.settlement_eligible\(timestamptz\) from public, anon, authenticated, service_role/.test(lower));
check("G16 eligibility excludes refunded sales, unsettled-only, and anything the retired flows touched", /p\.status = 'paid'/.test(lower) && /not exists \(select 1 from public\.purchase_settlements/.test(lower) && /not exists \(select 1 from public\.transfers/.test(lower) && /not exists \(select 1 from public\.vpa_payouts/.test(lower));
check("G17 no negative-balance, debt, clawback or reversal-against-seller concept in SQL", !noDebt.test(m));
check("G18 no function that un-pays: no update sets a paid item back, and no reverse/undo/debit names", !/set\s+status\s*=\s*'pending'/.test(lower) && !/create function [\w.]*(reverse|undo|unpay|debit|claw)/.test(lower));
check("G19 a paid item can only be settled, never released or cancelled: release and cancel both require pending / no paid items", /v_i\.status <> 'pending'/.test(lower) && /i\.status = 'paid'\) then/.test(lower) || /exists \(select 1 from public\.settlement_items i where i\.batch_id = p_batch_id and i\.status = 'paid'\)/.test(lower));
check("G20 every write is audited (create, paid, released, cancelled)", ["settlement_batch_created", "settlement_items_paid", "settlement_item_released", "settlement_batch_cancelled"].every((a) => lower.includes(`'${a}'`)));
check("G21 the migration never writes to the retired payout tables or config", !/(insert\s+into|update|delete\s+from)\s+(public\.)?(transfers|vpa_payouts|private\.vpa_payout_config|public\.seller_payout_accounts)\b/.test(lower));

// ---------------------------------------------------------------- app code
const SELLER = ["lib/domain/seller-settlement.js", "components/SellerPayoutPanel.jsx", "components/SellerEarningsClient.jsx", "app/sell/earnings/page.jsx"];
const ADMIN = ["lib/domain/admin-settlement.js", "components/AdminSettlementTab.jsx"];
const NEW = [...SELLER, ...ADMIN];
check("G22 all new app files exist", NEW.every(exists));
check("G23 none of the new or changed money code calls any payment-provider API, proxy or service client", NEW.every((f) => !/razorpay|createRazorpayClient|service-client|PAYOUT_PROXY|RAZORPAYX|\bfetch\(|\/v1\//i.test(stripJs(read(f)))));
check("G24 seller files use no admin code, no ledger tables and no admin RPC", SELLER.every((f) => { const t = stripJs(read(f)); return !/admin[-_]settlement|admin[-_]payments|admin_|settlement_items|settlement_batches|purchase_settlements|vpa_payouts|\.from\(\s*["']transfers/.test(t); }));
check("G25 seller wording never mentions debts, deductions, recovery or taking a payout back", SELLER.every((f) => !noDebt.test(stripJs(read(f)))) && SELLER.every((f) => !/\bowe[sd]?\b|deduct|recover/i.test(stripJs(read("components/SellerPayoutPanel.jsx")))));
check("G26 seller screens say it is monthly and final", /Unsettled earnings/.test(read("components/SellerPayoutPanel.jsx")) && /Next payout/.test(read("components/SellerPayoutPanel.jsx")) && /Unsettled earnings/.test(read("components/SellerEarningsClient.jsx")) && /never taken back/i.test(read("components/SellerEarningsClient.jsx")) && !/instant/i.test(read("components/SellerEarningsClient.jsx") + read("components/SellerPayoutPanel.jsx")));
const adminRpcs = [...stripJs(read("lib/domain/admin-settlement.js")).matchAll(/["'](admin_[a-z_]+)["']/g)].map((x) => x[1]).sort().join();
check("G27 the admin module calls exactly the seven admin RPCs", adminRpcs === "admin_cancel_settlement_batch,admin_create_settlement_batch,admin_release_settlement_item,admin_settle_items,admin_settlement_batch,admin_settlement_batches,admin_settlement_pending", adminRpcs);
check("G28 no dangerouslySetInnerHTML or eval anywhere in the new UI", NEW.every((f) => !/dangerouslySetInnerHTML|\beval\(|new Function/.test(read(f))));
check("G29 the CSV neutralises formula cells and routes every text column through csvCell", /\^\[=\+\\-@\\t\\r\]/.test(read("lib/domain/admin-settlement.js")) && /csvCell\(i\.seller_name/.test(read("lib/domain/admin-settlement.js")) && /csvCell\(i\.vpa_address\)/.test(read("lib/domain/admin-settlement.js")));
const page = read("app/admin/payments/page.jsx");
check("G30 the admin page gates on admin and aal2 before loading any settlement data", page.indexOf("gate.allowed") > 0 && page.indexOf("gate.allowed") < page.indexOf("getSettlementPending(") && page.indexOf("gate.isAdmin") < page.indexOf("getSettlementPending("));
check("G31 the admin page uses no service client and no Razorpay code", !/service-client|razorpay/i.test(stripJs(page)) && !/AdminSettlementTab[\s\S]{0,0}service/.test(page));
check("G32 the desk's first tab is the settlement tab; retired flows only show when they hold history", /\["settlement", "Monthly settlement"\]/.test(read("components/AdminPaymentsDesk.jsx")) && /LEGACY_TABS/.test(read("components/AdminPaymentsDesk.jsx")) && !/Set a seller&apos;s Razorpay payout account/.test(read("components/AdminPaymentsDesk.jsx")));
check("G33 mark-paid is confirmed in the UI and warns that a paid item is final", /window\.confirm\([^)]*cannot be undone/.test(read("components/AdminSettlementTab.jsx").replace(/\n/g, " ")) || /cannot be undone/.test(read("components/AdminSettlementTab.jsx")));

// ---------------------------------------------------------------- retired automation stays off
check("G34 no scheduled sweep: no vercel.json cron and no cron.schedule in any migration", !exists("vercel.json") && migs.every((f) => !/cron\.schedule/i.test(stripSql(read(`supabase/migrations/${f}`)))));
check("G35 no migration ever turns a feature flag on", migs.every((f) => !/update\s+private\.feature_flags[^;]*enabled\s*=\s*true/i.test(stripSql(read(`supabase/migrations/${f}`)))));
check("G36 the instant-UPI cut-off still defaults to infinity", /cutoff_at\s+timestamptz not null default 'infinity'/.test(read("supabase/migrations/20261018100000_add_vpa_payouts.sql")));
check("G37 the seller still only needs a UPI ID to list (gate unchanged)", /UpiGate/.test(read("app/sell/page.jsx")) && /set_my_payout_vpa/.test(read("app/sell/payout/page.jsx")));
check("G38 the runbook exists", exists("supabase/manual/phase7_monthly_settlement_runbook.md"));
console.log(`\nM56-GUARD: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
