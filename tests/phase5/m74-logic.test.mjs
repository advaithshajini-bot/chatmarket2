// A74 -- privacy PAN disclosure, single-seller export + Payout Made UI, Coming Soon gating, seller copy, home curation (static; no DB, no network).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const nc = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join("\n");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const S = await import("../../lib/domain/admin-settlement.js");
const T = await import("../../lib/product-types.js");
const P = await import("../../lib/domain/products.js");

// ---- single-seller CSV
const csv = S.buildSellerPayoutCsv({ label: "2026-10", sellerName: "Asha Rao", beneficiaryName: "Asha Rao", accountNumber: "0012345678901", ifsc: "HDFC0001234", accountType: "savings", amountPaise: 49200 });
const lines = csv.split("\r\n");
check("C01 header is exactly Beneficiary Name, Account Number, IFSC Code, Account Type, Net Payout (INR), Remarks", lines[0] === "Beneficiary Name,Account Number,IFSC Code,Account Type,Net Payout (INR),Remarks");
check("C02 one data row: account number quoted with its leading zeros, IFSC, Savings, 492.00, remarks 'Chatmarket payout <label> - <Seller Name>'", lines[1] === 'Asha Rao,"0012345678901",HDFC0001234,Savings,492.00,Chatmarket payout 2026-10 - Asha Rao' && lines.length === 3 && lines[2] === "");
check("C03 current accounts say Current; amounts never go through floating point (1 paise, 100.07)", /,Current,/.test(S.buildSellerPayoutCsv({ label: "x", sellerName: "A", accountNumber: "123456789", ifsc: "A", accountType: "current", amountPaise: 10007 })) && /,100\.07,/.test(S.buildSellerPayoutCsv({ label: "x", sellerName: "A", accountNumber: "1", ifsc: "A", accountType: "savings", amountPaise: 10007 })));
check("C04 a seller name that starts with = + - @ is neutralised (spreadsheet formula injection) and commas/quotes are escaped", /,'=SUM\(1\) x$|'=SUM/.test(S.buildSellerPayoutCsv({ label: "L", sellerName: "=SUM(1)", beneficiaryName: "=SUM(1)", accountNumber: "1", ifsc: "A", accountType: "savings", amountPaise: 100 })) && /"Doe, ""J"""/.test(S.buildSellerPayoutCsv({ label: "L", sellerName: "x", beneficiaryName: 'Doe, "J"', accountNumber: "1", ifsc: "A", accountType: "savings", amountPaise: 100 })));
check("C05 the file name is chatmarket-payout-<label>-<seller>.csv in safe characters", S.sellerCsvFilename("2026-10", "Asha Rao") === "chatmarket-payout-2026-10-asha-rao.csv" && S.sellerCsvFilename("../x", "A/B C") === "chatmarket-payout-x-a-b-c.csv");
check("C06 the full-batch CSV (previous behaviour) is unchanged: same header, quoted account numbers", /^Beneficiary Name,Account Number,IFSC Code,Account Type,Net Payout \(INR\),Remarks/.test(S.buildSettlementCsv({ label: "L" }, [{ status: "pending", bank_account_number: "0099", bank_ifsc: "A", bank_beneficiary_name: "B", amount_paise: 100 }])) && /"0099"/.test(S.buildSettlementCsv({ label: "L" }, [{ status: "pending", bank_account_number: "0099", bank_ifsc: "A", bank_beneficiary_name: "B", amount_paise: 100 }])));

// ---- admin tab UI
const tab = nc(read("components/AdminSettlementTab.jsx"));
check("D01 'Download Details' sits next to Pause/Resume in the preview table AND in the batch lines", (tab.match(/Download Details/g) || []).length >= 2 && /<PayoutToggle sellerId=\{p\.seller_id\}[\s\S]{0,400}Download Details/.test(tab) && /<PayoutToggle sellerId=\{i\.seller_id\}[\s\S]{0,700}Download Details/.test(tab));
check("D02 the preview download fetches the full details through the audited admin function; the batch line uses its locked snapshot", /getSellerBankDetails\(supabase, p\.seller_id\)/.test(tab) && /buildSellerPayoutCsv/.test(tab) && /i\.bank_account_number/.test(tab));
check("D03 'Payout Made' button on each pending line opens a dialog with a required UTR and a payment date (default today, not in the future)", /Payout Made/.test(tab) && /role="dialog"/.test(tab) && /isValidReference\(payRef\)/.test(tab) && /type="date" value=\{payDate\} max=\{period\.todayDate\}/.test(tab) && /useState\(period\.todayDate\)/.test(tab));
check("D04 confirming calls the single-item function, reloads the batch and tells the admin the seller now sees Paid", /settleSingleItem\(supabase, payFor\.item_id, ref, payDate\)/.test(tab) && /await refresh\(\); await loadDetail\(batch\.batch_id\)/.test(tab) && /earnings page now shows it as Paid/.test(tab));
check("D05 the domain helpers call admin_settle_single_item / admin_seller_bank_details", /"admin_settle_single_item", \{ p_item_id: itemId, p_reference: reference, p_payment_date/.test(read("lib/domain/admin-settlement.js")) && /"admin_seller_bank_details"/.test(read("lib/domain/admin-settlement.js")));
const mig = nc(read("supabase/migrations/20261103100000_individual_settlement.sql")).toLowerCase();
check("D06 migration: additive, both functions admin + MFA only, SECURITY DEFINER with empty search_path, no table or column changes", !/drop |alter table|create table/.test(mig) && (mig.match(/private\.is_admin_mfa\(\)/g) || []).length === 2 && (mig.match(/set search_path = ''/g) || []).length === 2 && /revoke all on function public\.admin_settle_single_item/.test(mig));

// ---- Coming soon
check("W01 Workflow and Agent are Coming Soon; Playbook is not; the notice is the specified sentence", T.isComingSoon("workflow") && T.isComingSoon("agent") && !T.isComingSoon("playbook") && T.COMING_SOON_NOTICE === "Workflows and Autonomous Agents are launching soon. You can currently create and publish Playbooks.");
const sell = nc(read("app/sell/page.jsx"));
check("W02 the sell flow starts straight in the Playbook wizard, shows the Coming Soon banner, and never renders the Workflow/Agent form while they are coming soon", /useState\("playbook"\)/.test(sell) && /COMING_SOON_NOTICE/.test(sell) && /!isComingSoon\(productType\)/.test(sell) && !/<ProductTypePicker/.test(sell));
const pick = nc(read("components/ProductTypePicker.jsx"));
check("W03 the type picker marks them 'Coming soon' and disables selection", /isComingSoon\(type\)/.test(pick) && /disabled=\{soon\}/.test(pick) && /Coming soon/.test(pick) && /if \(!soon\) onSelect\(type\)/.test(pick));
const api = nc(read("app/api/listings/create-workflow-agent/route.js"));
check("W04 the API refuses workflow/agent submissions with 403 coming_soon, before any validation or insert", /isComingSoon\(productType\)/.test(api) && /status: 403/.test(api) && api.indexOf("isComingSoon(productType)") < api.indexOf('.from("listings")'));
const tabs = nc(read("components/ProductTypeTabs.jsx"));
check("W05 Browse: Workflow / Agent tabs show 'Coming soon' and are disabled; ?type=workflow falls back to All", /disabled=\{soon\}/.test(tabs) && /Coming soon/.test(tabs) && /!isComingSoon\(typeFromUrl\)/.test(read("components/BrowseClient.jsx")));
check("W06 Home: Workflow / Agent cards say 'Coming soon' instead of linking to a browse page", /isComingSoon\(type\) \?/.test(read("components/LandingClient.jsx")) && /Coming soon/.test(read("components/LandingClient.jsx")));

// ---- seller copy
const land = nc(read("components/LandingClient.jsx"));
check("H01 seller steps: Upload your Playbook (4-10 screenshots, 5-15s video) / Save your bank details (Sell -> Payout) / Get paid monthly (18%, IMPS/NEFT around the 1st, all sales final)", /Upload your Playbook/.test(land) && /4–10 output screenshots, and a 5–15 second demo video/.test(land) && /Save your bank details/.test(land) && /under Sell → Payout/.test(land) && /Get paid monthly/.test(land) && /18% platform fee/.test(land) && /IMPS\/NEFT around the 1st of every month/.test(land) && /All sales are final/.test(land));
check("H02 the old seller copy (identity check step, 48-hour hold, held payment) is gone", !/Verify your identity/.test(land) && !/48 hours/.test(land) && !/Pick a product type/.test(land));

// ---- curation: a recording stand-in for the Supabase query builder
function fake(rowsByTable) {
  const calls = [];
  const qb = (table) => {
    const state = { table, orders: [], filters: [], limit: null, ins: null };
    const api = {
      select() { return api; }, eq(c, v) { state.filters.push([c, v]); return api; }, in(c, v) { state.ins = [c, v]; return api; },
      order(c, o) { state.orders.push([c, o]); return api; }, limit(n) { state.limit = n; calls.push(state); return Promise.resolve({ data: rowsByTable[table] ?? [], error: null }); },
      then(res) { calls.push(state); return Promise.resolve({ data: rowsByTable[table] ?? [], error: null }).then(res); },
    };
    return api;
  };
  return { calls, from: qb, rpc: (fn, args) => { calls.push({ rpc: fn, args }); return Promise.resolve({ data: rowsByTable.__rpc ?? [], error: null }); } };
}
const row = (id) => ({ id, title: "T", price: 100, product_type: "playbook", status: "live", created_at: "2026-10-01", seller_id: "s", seller_name: "n", screenshots: [] });
let sb = fake({ listings: [] });
await P.listProductsCurated(sb, "featured", { limit: 6 });
const f = sb.calls[0];
check("K01 FEATURED: live only, order reviews DESC, rating DESC, created_at DESC, limit 6", f.table === "listings" && JSON.stringify(f.filters) === '[["status","live"]]' && JSON.stringify(f.orders.map((o) => [o[0], o[1].ascending])) === '[["reviews",false],["rating",false],["created_at",false]]' && f.limit === 6, f);
sb = fake({ listings: [] });
await P.listProductsCurated(sb, "new", { limit: 6 });
check("K02 NEW: live only, order created_at DESC only", JSON.stringify(sb.calls[0].filters) === '[["status","live"]]' && JSON.stringify(sb.calls[0].orders.map((o) => [o[0], o[1].ascending])) === '[["created_at",false]]', sb.calls[0]);
sb = fake({ listings: [row("c"), row("a"), row("b")], __rpc: [{ listing_id: "a" }, { listing_id: "b" }, { listing_id: "c" }] });
const pop = await P.listProductsCurated(sb, "popular", { limit: 6 });
check("K03 POPULAR: ranked by the paid-purchase function (most_popular_listings), then the listings are returned in exactly that order and only live ones are fetched", sb.calls[0].rpc === "most_popular_listings" && sb.calls[0].args.p_limit === 6 && JSON.stringify(pop.map((p) => p.id)) === '["a","b","c"]' && JSON.stringify(sb.calls[1].filters) === '[["status","live"]]' && sb.calls[1].ins[0] === "id", pop.map((p) => p.id));
sb = fake({ listings: [], __rpc: [] });
check("K04 POPULAR with no purchases yet returns an empty list without a second query", (await P.listProductsCurated(sb, "popular")).length === 0 && sb.calls.length === 1);
check("K05 an unknown curation is rejected", await P.listProductsCurated(sb, "bogus").then(() => false, () => true));
const home = nc(read("app/page.jsx"));
check("K06 the home page runs three different queries (featured / popular / new), no longer the same list re-sorted in memory", /listProductsCurated\(supabase, "featured"/.test(home) && /listProductsCurated\(supabase, "popular"/.test(home) && /listProductsCurated\(supabase, "new"/.test(home) && !/\.sort\(/.test(home) && !/listProducts\(/.test(home));
console.log(`A74: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
