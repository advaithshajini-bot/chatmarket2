// A64-L -- direct UPI instant unlock: checkout step order, seller report, admin tab, migration guardrails. No database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import * as D from "../../lib/domain/direct-upi.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const co = read("components/DirectUpiCheckout.jsx");
const code = co.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

check("L01 the first thing a buyer sees is a Buy now button (step starts at idle)", /useState\("idle"\)/.test(code) && /step === "idle" \? \(\s*<button onClick=\{\(\) => setStep\("qr_hidden"\)\}[\s\S]{0,300}Buy now/.test(code));
check("L02 the QR image is not even generated until Buy now was pressed", /if \(!uri \|\| step === "idle"\)/.test(code));
check("L03 after Buy now the QR is shown BLURRED with a 'Show QR code' button on top, and pressing it reveals it", /filter: revealed \? "none" : "blur\(10px\)"/.test(code) && /Show QR code/.test(code) && /setStep\("qr_shown"\)/.test(code) && /pointerEvents: revealed \? "auto" : "none"/.test(code));
check("L04 the seller's UPI ID text and the app buttons appear only once the QR is revealed", /revealed && \(\s*<button type="button" onClick=\{copyUpi\}/.test(code) && /revealed && \(\s*<>\s*<div className="grid grid-cols-2/.test(code));
check("L05 the UTR box exists only in the 'utr' step, reached by pressing 'I've made the payment'", /step === "utr" && \(\s*<form/.test(code) && /step === "qr_shown" && \(\s*<button onClick=\{\(\) => setStep\("utr"\)\}/.test(code) && (code.match(/id="utr"/g) || []).length === 1);
check("L06 submitting the UTR unlocks the buyer at once (no waiting state, no seller confirmation)", /submit_direct_payment_claim/.test(code) && /onUnlocked\?\.\(\)/.test(code) && !/Waiting for the seller|waiting/i.test(code.replace(/\/\*[\s\S]*?\*\//g, "")));
check("L07 the checkout tells the buyer the truth: instant unlock, seller can report, access removed if not verified", /unlocks as soon as you submit the UTR/.test(co) && /access is removed if the payment can&apos;t be verified/.test(co) && /Only submit a UTR for a payment you actually made/.test(co));
check("L08 the checkout never talks to Razorpay", !/razorpay/i.test(code));
check("L09 the price still comes only from the server lookup", /target\.amount_paise/.test(code) && !/listing\.price/.test(code));

// wording
check("L10 claim wording: unlocked, under review (access stays), access removed", D.describeClaim({ status: "confirmed" }).label === "Unlocked" && /access stays/.test(D.describeClaim({ status: "disputed" }).detail) && D.describeClaim({ status: "revoked" }).tone === "red");
check("L11 seller wording for every status", D.describeSellerClaim({ status: "confirmed" }).label === "Unlocked" && D.describeSellerClaim({ status: "confirmed", resolution: "upheld" }).label === "Verified by chatmarket" && D.describeSellerClaim({ status: "disputed" }).label === "Under review" && D.describeSellerClaim({ status: "revoked" }).tone === "red");
check("L12 every new database refusal has plain wording", ["invalid_reason", "too_many_reports", "claim_not_reportable", "report_window_passed", "claim_not_disputed", "invalid_decision", "payment_revoked", "admin_required"].every((c) => D.explainDirectError({ message: c }).length > 10 && !D.explainDirectError({ message: c }).includes("_")));
check("L13 a revoked buyer is told why they cannot buy again", /couldn't be verified/.test(D.describeTargetReason({ reason: "payment_revoked" })));
check("L14 the admin loader fails closed", (await D.getAdminDirectClaims({ rpc: async () => ({ data: null, error: { message: "x" } }) })).claims.length === 0);

// seller + admin screens
const panel = read("components/SellerClaimsPanel.jsx"), admin = read("components/AdminDirectPaymentsTab.jsx"), desk = read("components/AdminPaymentsDesk.jsx");
check("L20 the seller can report 'not received' only through the database function, with a reason of at least 10 characters", /raise_direct_payment_dispute/.test(panel) && /c\.can_report/.test(panel) && /at least 10 characters/.test(panel));
check("L21 the seller panel explains that buyers are unlocked instantly", /unlocks as soon as they submit the UTR/.test(panel));
check("L22 the admin tab lists reports and decides through the admin-only functions, with a note prompt", /admin_resolve_direct_dispute/.test(admin) && /getAdminDirectClaims/.test(admin) && /window\.prompt/.test(admin) && /Payment verified/.test(admin) && /remove access/.test(admin));
check("L23 the admin desk has a 'Direct payments' tab wired to it", /\["direct", "Direct payments"\]/.test(desk) && /<AdminDirectPaymentsTab supabase=\{supabase\}/.test(desk));

// migration
const MIG = "20261025100000_direct_upi_instant_unlock.sql";
const migs = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const m = read(`supabase/migrations/${MIG}`), low = m.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").toLowerCase();
check("L30 the migration sorts last, after the first direct-UPI migration", migs.includes(MIG) && migs.indexOf(MIG) === migs.indexOf("20261024100000_add_direct_upi_checkout.sql") + 1);
check("L31 additive: it drops only the status check and the UTR index it recreates; no table, column, function or data is dropped", [...low.matchAll(/\bdrop\s+(\w+)(?:\s+if exists)?\s+([\w.]+)/g)].map((x) => `${x[1]} ${x[2]}`).sort().join() === "constraint direct_payment_claims_status_check,index public.direct_claims_utr_idx" && !/\b(delete from|truncate|drop table|drop column|drop function)\b/.test(low));
check("L32 it does not touch the feature flag (still OFF unless you flip it)", !/feature_flags/.test(low));
check("L33 submit creates the purchase and the claim in ONE block, and the purchase is direct_upi with fee 0", /insert into public\.purchases[\s\S]{0,400}'direct_upi'[\s\S]{0,60}, 0\)[\s\S]{0,200}insert into public\.direct_payment_claims/.test(low));
check("L34 only admins with MFA can list or decide", (m.match(/private\.is_admin_mfa\(\)/g) || []).length >= 2);
check("L35 every new function is SECURITY DEFINER with an empty search_path and is not granted to anon", [...m.matchAll(/create (?:or replace )?function[\s\S]*?\n\$\$;/g)].every((f) => /security definer/i.test(f[0]) && /set search_path = ''/i.test(f[0])) && !/grant execute[^;]*to[^;]*anon/.test(low));
check("L36 revoking access never deletes the purchase: it sets it to refunded so history is kept", /update public\.purchases set status = 'refunded'/.test(low) && !/delete from public\.purchases/.test(low));

console.log(`\nA64-L: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
