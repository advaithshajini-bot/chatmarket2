// A76 -- Library cards, Payout Completed + unrestricted bank export, rate limiting of login / PAN / bank details (static + unit; no DB, no network).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const lc = read("components/LibraryClient.jsx"), ld = read("components/LibraryDetailClient.jsx");

// ---- Library
check("B01 library cards show the listing's video / screenshot preview and a 'files ready' line", /ListingVideoCard/.test(lc) && /preview_video_url/.test(lc) && /screenshots\?\.\[0\]/.test(lc) && /files ready to download/.test(lc));
check("B02 the library detail page uses the listing presentation (video player, screenshot gallery, description, what's in the zip)", /<ListingVideoCard[^>]*controls/.test(ld) && /<ScreenshotGallery/.test(ld) && /listing\.description/.test(ld) && /What&apos;s in the zip/.test(ld) && /listing\.zip_contents/.test(ld));
check("B03 the raw prompt/thread is no longer rendered on the library page", !/displayThread|listing\.thread|listing\.preview\b|MessageSquare|Showing \$\{/.test(ld));
check("B04 the zip download is kept (signed URL for the buyer) and blueprint purchases still get their download card", /createSignedUrl\(listing\.output_zip_path/.test(ld) && /Download files \(\.zip\)/.test(ld) && /<BlueprintDownloadCard/.test(ld));

// ---- Admin payments
const tab = read("components/AdminSettlementTab.jsx"), dom = read("lib/domain/admin-settlement.js");
check("A01 each payable seller row has 'Payout Completed' next to Pause/Resume + Download Details; it opens the UTR + date dialog", /openPreviewPayDialog\(p\)/.test(tab) && /Payout Completed/.test(tab) && /kind: "preview"/.test(tab));
check("A02 confirming from a summary row calls the one-seller completion function with the cut-off, then refreshes the desk", /completeSellerPayout\(supabase, payFor\.seller_id, iso, ref, payDate\)/.test(tab) && /"admin_complete_seller_payout"/.test(dom) && /earnings page now shows it as Paid/.test(tab));
check("A03 Download Details is on EVERY seller row, including the 'not included' rows (below minimum / rolled over / cooling down)", /downloadPreviewSeller\(b\)/.test(tab) && !/min_payout|below_minimum|blocked_reason/.test(tab.slice(tab.indexOf("const downloadPreviewSeller"), tab.indexOf("const downloadBatchSeller"))));
const mig = read("supabase/migrations/20261105100000_payout_completed_and_rate_limits.sql").toLowerCase();
check("A04 migration: completion function is admin + MFA first, SECURITY DEFINER, empty search_path, writes the batch as completed and the line as paid, audited", /private\.is_admin_mfa\(\)/.test(mig) && /'completed', now\(\)/.test(mig) && /'paid', v_ref, v_paid/.test(mig) && /seller_payout_completed/.test(mig) && /revoke all on function public\.admin_complete_seller_payout/.test(mig));

// ---- Rate limiting: helpers
let RL; try { RL = await import("../../lib/security/rate-limit.js"); } catch (e) { RL = null; console.log("(helper import failed:", e.message, ")"); }
const src = read("lib/security/rate-limit.js");
check("L01 policies: login 8 per account + 20 per IP per 15 min; PAN / identity 5 per hour; bank 5 per hour", /login_ip:[^\n]*limit: 20, windowSeconds: 900/.test(src) && /login_account:[^\n]*limit: 8,\s+windowSeconds: 900/.test(src) && /identity:[^\n]*limit: 5,\s+windowSeconds: 3600/.test(src) && /bank:[^\n]*limit: 5,\s+windowSeconds: 3600/.test(src));
if (RL) {
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
  check("L02 clientIp: first x-forwarded-for entry, else x-real-ip, else 'unknown'", RL.clientIp(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })) === "203.0.113.9" && RL.clientIp(h({ "x-real-ip": "198.51.100.2" })) === "198.51.100.2" && RL.clientIp(h({})) === "unknown");
  check("L03 keys are hashed (SHA-256, case-insensitive, no raw email or IP is sent to the database)", RL.hashKey("A@B.com") === RL.hashKey(" a@b.com ") && /^[0-9a-f]{64}$/.test(RL.hashKey("a@b.com")) && !RL.hashKey("a@b.com").includes("a@b"));
  const mk = (data, error = null) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push([fn, args]); return { data, error }; } }; };
  const s1 = mk({ allowed: false, retry_after_seconds: 120 });
  const r1 = await RL.checkLimit(s1, RL.POLICIES.login_account, "x@y.com");
  check("L04 checkLimit passes bucket / hashed key / limit / window and returns the retry time when refused", r1.allowed === false && r1.retryAfterSeconds === 120 && s1.calls[0][0] === "rate_limit_hit" && s1.calls[0][1].p_bucket === "login_account" && s1.calls[0][1].p_limit === 8 && s1.calls[0][1].p_window_seconds === 900 && s1.calls[0][1].p_key === RL.hashKey("x@y.com"), s1.calls);
  const dead = (await RL.checkLimit(null, RL.POLICIES.bank, "u")).degraded && (await RL.checkLimit(mk(null, { message: "x" }), RL.POLICIES.bank, "u")).allowed && (await RL.checkLimit({ rpc: async () => { throw new Error("boom"); } }, RL.POLICIES.bank, "u")).allowed;
  check("L05 a limiter outage (no service key, RPC error, exception) never locks users out: the request is allowed and flagged degraded", !!dead);
  check("L06 waitText reads naturally (seconds, minutes, hours)", RL.waitText(30) === "30 seconds" && RL.waitText(1) === "1 second" && RL.waitText(600) === "10 minutes" && RL.waitText(7200) === "2 hours");
  const resp = RL.rateLimitedResponse(840, "sign-in attempts");
  const body = await resp.json();
  check("L07 the 429 carries Retry-After, no-store and a message that doesn't reveal which limit was hit", resp.status === 429 && resp.headers.get("Retry-After") === "840" && resp.headers.get("Cache-Control") === "no-store" && /Too many sign-in attempts\. Please try again in 14 minutes\./.test(body.error) && body.code === "rate_limited" && !/ip|account/i.test(body.error));
}

// ---- Rate limiting: routes + pages
const login = read("app/api/auth/login/route.js");
check("N01 /api/auth/login checks the IP limit, then the account limit, BEFORE the password is tried; success clears only the account counter", login.indexOf("POLICIES.login_ip") < login.indexOf("POLICIES.login_account") && login.indexOf("POLICIES.login_account") < login.indexOf("signInWithPassword") && /resetLimit\(service, POLICIES\.login_account/.test(login) && !/resetLimit\(service, POLICIES\.login_ip/.test(login));
check("N02 wrong credentials get the provider's generic message with 401; nothing else about the account is revealed", /status: ?status|json\(\{ error: status === 429/.test(login) && !/user not found|no account/i.test(login));
const lp = read("app/login/page.jsx");
check("N03 the login page signs in through the route (no direct browser password sign-in left) and keeps the MFA step", /fetch\("\/api\/auth\/login"/.test(lp) && !/signInWithPassword/.test(lp) && /mfa\.getAuthenticatorAssuranceLevel/.test(lp));
const idr = read("app/api/sell/identity/route.js"), bank = read("app/api/sell/payout-bank/route.js");
check("N04 /api/sell/identity: logged-in only, EVERY submission counted (before validation), 5 per hour, DB CM082 also mapped to 429", idr.indexOf("POLICIES.identity") < idr.indexOf("validateIdentity(") && /getUser\(\)/.test(idr) && /CM082/.test(idr) && /rateLimitedResponse/.test(idr));
check("N05 /api/sell/payout-bank counts every submission before validating (5 per hour) and maps CM082 to 429", bank.indexOf("POLICIES.bank") < bank.indexOf("validateBankPayoutForm(body)") && /CM082/.test(bank));
const prof = read("app/sell/profile/page.jsx");
check("N06 the PAN / identity form posts to /api/sell/identity (no direct browser RPC) and shows the limit message", /fetch\("\/api\/sell\/identity"/.test(prof) && !/rpc\("set_seller_identity_details"/.test(prof) && /out\?\.error/.test(prof));
check("N07 migration: limiter table in the private schema (RLS on), functions service_role only, 22023 on bad input, new code CM082, triggers only count the row owner", /create table if not exists private\.rate_limit_events/.test(mig) && /enable row level security/.test(mig) && /to service_role/.test(mig) && /from public, anon, authenticated/.test(mig) && /errcode = 'cm082'/.test(mig) && /v_uid is distinct from new\.user_id/.test(mig) && !/drop table|alter table public\./.test(mig.split("\n").filter((l) => !l.startsWith("--")).join("\n")));
check("N08 the service-role client is only imported by server route handlers (never a client component)", !/service-client/.test(read("app/sell/profile/page.jsx")) && !/service-client/.test(lp) && /server-only|SERVER-ONLY/i.test(read("lib/payments/service-client.js")));
console.log(`A76: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
