// A60-L -- Milestone 5.7 (UPI-change cooldown): wording, helpers, loaders and static guardrails. No database, no network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeSettlement, describeUpiCooldown, formatUnlockAt, getSellerUpiCooldown, getSellerSettlementStatus, SETTLEMENT_CODES } from "../../lib/domain/seller-settlement.js";
import { BLOCKED_LABELS } from "../../lib/domain/admin-settlement.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS:", name); }
  else { fail++; console.log("FAIL:", name, extra === undefined ? "" : `-- ${JSON.stringify(extra)}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ---------------------------------------------------------------- wording
const at = "2026-10-25T10:00:00Z";            // 15:30 IST
check("L01 formatUnlockAt is pinned to India time", formatUnlockAt(at) === "25 Oct 2026, 3:30 pm IST", formatUnlockAt(at));
check("L02 formatUnlockAt: bad input gives an empty string, never throws", ["", null, undefined, "not a date", 5, {}].every((x) => formatUnlockAt(x) === ""));
const before = new Date("2026-10-24T10:00:00Z");
check("L03 the seller notice carries the exact wording asked for", describeUpiCooldown(at, before) === "UPI ID updated. Payouts to this ID will unlock after 25 Oct 2026, 3:30 pm IST.", describeUpiCooldown(at, before));
check("L04 no notice once the time has passed (boundary included) or when there is no cooldown", describeUpiCooldown(at, new Date(at)) === null && describeUpiCooldown(at, new Date("2026-10-26T00:00:00Z")) === null && describeUpiCooldown(null, before) === null && describeUpiCooldown(undefined, before) === null && describeUpiCooldown("junk", before) === null);
const d = describeSettlement({ status: "upi_cooldown" });
check("L05 the new per-sale status has its own label, an explanation and an amber tone", d.label === "Waiting: UPI ID changed" && /next payout/.test(d.detail) && d.tone === "amber", d);
check("L06 the new code is in SETTLEMENT_CODES and every code has a real label (none falls through to 'unavailable')", SETTLEMENT_CODES.includes("upi_cooldown") && SETTLEMENT_CODES.every((c) => describeSettlement({ status: c }).label !== "Status unavailable"));
check("L07 an unknown status still falls back safely", describeSettlement({ status: "weird" }).label === "Status unavailable");
check("L08 the admin desk has a label for the new blocked reason", BLOCKED_LABELS.upi_in_cooldown === "UPI ID changed recently: rolls over" && BLOCKED_LABELS.below_minimum && BLOCKED_LABELS.no_upi_id);

// ---------------------------------------------------------------- loaders
const sb = (res) => ({ rpc: async (fn, args) => { sb.calls.push([fn, args]); if (res instanceof Error) throw res; return res; } });
sb.calls = [];
const ok = await getSellerUpiCooldown(sb({ data: { upi_cooldown_hours: 72, upi_unlocks_at: at }, error: null }));
check("L10 getSellerUpiCooldown calls seller_upi_cooldown (no arguments) and passes the answer through", ok.upi_cooldown_hours === 72 && ok.upi_unlocks_at === at && sb.calls.at(-1)[0] === "seller_upi_cooldown", ok);
for (const [name, res] of [["an rpc error", { data: null, error: { message: "x" } }], ["no data", { data: null, error: null }], ["a thrown error", new Error("down")], ["junk fields", { data: { upi_cooldown_hours: "72", upi_unlocks_at: 5 }, error: null }]]) {
  const r = await getSellerUpiCooldown(sb(res));
  check(`L11 ${name}: falls back to 'no cooldown' (never blocks the page, never shows a wrong date)`, r.upi_cooldown_hours === 0 && r.upi_unlocks_at === null, r);
}
const st = await getSellerSettlementStatus(sb({ data: null, error: { message: "x" } }));
check("L12 the earnings loader's fallback carries the new keys", st.upi_unlocks_at === null && st.upi_cooldown_hours === 0 && st.error === true, st);

// ---------------------------------------------------------------- static guardrails
const MIG = "supabase/migrations/20261021100000_add_upi_cooldown.sql";
const strip = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const m = strip(read(MIG)), lower = m.toLowerCase();
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
check("G01 the migration sorts directly after the 5.6 minimum-payout migration", migs.indexOf("20261021100000_add_upi_cooldown.sql") === migs.indexOf("20261020100000_add_min_payout.sql") + 1);
check("G02 it is additive: no drop, delete or truncate, and no stand-alone UPDATE of existing rows", !/\b(drop\s+(table|column|function)|delete\s+from|truncate)\b/.test(lower) && !/^update\s/m.test(lower), lower.match(/\b(drop\s+\w+|delete\s+from|truncate)/g));
check("G03 it adds exactly the two columns, with a CHECK on the hours and a default of 72", /add column vpa_changed_at timestamptz/.test(lower) && /add column upi_cooldown_hours integer not null default 72 check \(upi_cooldown_hours >= 0 and upi_cooldown_hours <= 720\)/.test(lower));
check("G04 it grants nothing on the new column (authenticated cannot read it) and adds no policy or table", !/grant\s+select/.test(lower) && !/create policy|create table/.test(lower));
const fns = [...lower.matchAll(/create (?:or replace )?function public\.(\w+)/g)].map((x) => x[1]).sort();
check("G05 it defines exactly five functions: four replaced, one new", fns.join() === "admin_create_settlement_batch,admin_settlement_pending,seller_settlement_status,seller_upi_cooldown,set_my_payout_vpa", fns);
check("G06 every function is SECURITY DEFINER with an empty search_path", (lower.match(/security definer/g) ?? []).length === 5 && (lower.match(/set search_path = ''/g) ?? []).length === 5);
check("G07 the new function is revoked from public, anon and authenticated, then granted to authenticated only", /revoke all on function public\.seller_upi_cooldown\(\) from public, anon, authenticated;/.test(lower) && /grant execute on function public\.seller_upi_cooldown\(\) to authenticated;/.test(lower) && !/\bto (anon|service_role|public)\b/.test(lower));
check("G08 the admin functions still check admin + MFA first", (lower.match(/if not \(select private\.is_admin_mfa\(\)\)/g) ?? []).length === 2);
check("G09 the same cooldown test (and the same now()) is used in the preview, the freeze and the seller view", (lower.match(/vpa_changed_at \+ make_interval\(hours => v_cool\) > now\(\)/g) ?? []).length >= 5);
check("G10 the freeze filters BEFORE it groups (a cooldown seller never gets an item)", lower.indexOf("where not (v_cool > 0") > -1 && lower.indexOf("where not (v_cool > 0") < lower.indexOf("group by e.seller_id, acct.vpa_address"));
check("G11 the first save does not start the clock: the clock is set only when a previous ID existed", /case when v_old is not null then now\(\) else public\.seller_payout_accounts\.vpa_changed_at end/.test(lower));
check("G12 the audit row still holds only the masked ID", /jsonb_build_object\('vpa', private\.mask_vpa\(v_vpa\)\)/.test(lower));
check("G13 the 5.4 rate limit (5 changes / 24h) and the CM075 validation are kept", /too_many_changes/.test(lower) && /invalid_vpa/.test(lower) && />= 5/.test(lower));
check("G14 the 5.6 minimum and the 5.5 rules are kept in the replaced functions", /having sum\(e\.amount_paise\) >= v_min/.test(lower) && /'below_minimum'/.test(lower) && /nothing_to_settle/.test(lower) && /open_batch_exists/.test(lower));
check("G15 it never touches the retired payout tables or flags", !/vpa_payouts|feature_flags|vpa_payout_config|transfers/.test(lower));
check("G16 the error codes used are only the existing ones (no new code)", [...new Set([...lower.matchAll(/errcode = '(\w+)'/g)].map((x) => x[1].toLowerCase()))].sort().join() === "42501,cm074,cm075,cm076");

const page = read("app/sell/payout/page.jsx"), panel = read("components/SellerPayoutPanel.jsx"), tab = read("components/AdminSettlementTab.jsx");
check("G20 /sell/payout loads the cooldown through the RPC helper and uses what the save returned", /getSellerUpiCooldown\(supabase\)/.test(page) && /data\?\.upi_unlocks_at/.test(page) && !/vpa_changed_at/.test(page));
check("G21 the payout page and the earnings panel show the notice through describeUpiCooldown (one wording)", /describeUpiCooldown\(cooldown\.upi_unlocks_at\)/.test(page) && /describeUpiCooldown\(settlement\?\.upi_unlocks_at\)/.test(panel));
check("G22 no browser code reads vpa_changed_at or the config table directly", ![page, panel, tab, read("lib/domain/seller-settlement.js"), read("lib/domain/admin-settlement.js")].some((f) => /vpa_changed_at|settlement_config/.test(f)));
check("G23 the admin desk shows when the new ID matures next to the blocked reason", /b\.reason === "upi_in_cooldown" && b\.upi_unlocks_at/.test(tab) && /new ID matures/.test(tab));
check("G24 the seller wording never says 'frozen', 'locked out', 'penalty' or 'suspicious' (a legitimate change must not read as an accusation)", ![page, panel].some((f) => /frozen|locked out|penalt|suspicious|fraud/i.test(f.replace(/Admin|frozen batch/g, ""))));
check("G25 the cooldown never creates a negative amount or a clawback concept", !/negative|clawback|claw back|chargeback/i.test(m));

console.log(`\nA60-L: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
