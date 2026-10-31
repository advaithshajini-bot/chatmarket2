// A69 -- listing rules (client + server), settlement CSV button, Pause/Resume toggle. Static; no database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const noComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join("\n");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const R = await import("../../lib/domain/listing-rules.js");
const Sx = await import("../../lib/domain/admin-settlement.js");
const a = (n) => "a".repeat(n);
const ok = { title: a(10), description: a(500), zipContents: a(250) };

const L = R.LISTING_RULES;
check("L01 the rules are 10-20 / 500-2000 / 250-500 characters, 4-10 screenshots, one 5-15s video, ₹50-₹999", L.titleMin === 10 && L.titleMax === 20 && L.descriptionMin === 500 && L.descriptionMax === 2000 && L.zipContentsMin === 250 && L.zipContentsMax === 500 && L.screenshotsMin === 4 && L.screenshotsMax === 10 && L.photoMaxSizeBytes === 10 * 1024 * 1024 && L.videoMaxSizeBytes === 25 * 1024 * 1024 && L.videoMinDurationSeconds === 5 && L.videoMaxDurationSeconds === 15 && L.videosRequired === 1 && L.priceMinRupees === 50 && L.priceMaxRupees === 999);
check("L02 text exactly on the minimums and on the maximums passes", R.validateListingText(ok).ok && R.validateListingText({ title: a(20), description: a(2000), zipContents: a(500) }).ok);
check("L03 a 9- and a 21-character title is rejected", R.validateListingText({ ...ok, title: a(9) }).errors.title !== undefined && R.validateListingText({ ...ok, title: a(21) }).errors.title !== undefined);
check("L04 a 499- and a 2001-character description is rejected", R.validateListingText({ ...ok, description: a(499) }).errors.description !== undefined && R.validateListingText({ ...ok, description: a(2001) }).errors.description !== undefined);
check("L05 a 249- and a 501-character zip note is rejected", R.validateListingText({ ...ok, zipContents: a(249) }).errors.zipContents !== undefined && R.validateListingText({ ...ok, zipContents: a(501) }).errors.zipContents !== undefined);
check("L06 whitespace is trimmed before counting", !R.validateListingText({ ...ok, title: "  " + a(8) + "  " }).ok && !R.validateListingText({ ...ok, description: a(490) + " ".repeat(30) }).ok);
check("L07 missing values are rejected, not crashed on", !R.validateListingText({}).ok && !R.validateListingText(undefined).ok);
check("L08 price: 49 and 1000 are rejected with explicit messages; 50 and 999 pass", R.validateListingPrice(49).error === "The minimum price is ₹50." && R.validateListingPrice(1000).error === "The maximum price is ₹999." && R.validateListingPrice(50).ok && R.validateListingPrice("999").ok);
check("L09 price: empty, text, null and undefined are rejected", [ "", "abc", null, undefined ].every((v) => !R.validateListingPrice(v).ok));
check("L10 workflow/agent rules: title 10-20, description 500-2000, price bounds", R.validateProductListing({ title: a(10), description: a(500), price: 50 }).ok && !R.validateProductListing({ title: a(9), description: a(500), price: 50 }).ok && !R.validateProductListing({ title: a(21), description: a(500), price: 50 }).ok && !R.validateProductListing({ title: a(10), description: a(100), price: 50 }).ok && !R.validateProductListing({ title: a(10), description: a(500), price: 5 }).ok);
check("L11 a database refusal is turned into a plain sentence", /10 to 20/.test(R.explainListingRuleError({ message: "title_out_of_range" })) && /₹50 and ₹999/.test(R.explainListingRuleError({ message: "price_out_of_range" })) && /4 to 10 screenshots/.test(R.explainListingRuleError({ message: "screenshots_count_invalid" })) && /between 5 and 15 seconds/.test(R.explainListingRuleError({ message: "video_duration_out_of_range" })) && !!R.explainListingRuleError({ message: "video_required" }) && R.explainListingRuleError({ message: "x" }) === null);
const good = { ...ok, price: 50, screenshotCount: 4, video: { duration: 8 } };
check("L12 screenshots: 3 and 11 rejected, 4 and 10 accepted", !R.validateScreenshotCount(3).ok && !R.validateScreenshotCount(11).ok && R.validateScreenshotCount(4).ok && R.validateScreenshotCount(10).ok);
check("L13 images: png/jpg/jpeg/webp up to 10MB; gif, pdf and 10MB+1 are rejected", R.validateImageFile({ name: "a.png", type: "image/png", size: 1000 }).ok && R.validateImageFile({ name: "a.webp", type: "image/webp", size: 10 * 1024 * 1024 }).ok && !R.validateImageFile({ name: "a.gif", type: "image/gif", size: 10 }).ok && !R.validateImageFile({ name: "a.pdf", type: "application/pdf", size: 10 }).ok && !R.validateImageFile({ name: "a.png", type: "image/png", size: 10 * 1024 * 1024 + 1 }).ok);
check("L14 video file: mp4/webm up to 25MB; 'Video must be under 25MB.' otherwise", R.validateVideoFile({ name: "a.mp4", type: "video/mp4", size: 25 * 1024 * 1024 }).ok && R.validateVideoFile({ name: "a.webm", type: "video/webm", size: 5 }).ok && R.validateVideoFile({ name: "a.mp4", type: "video/mp4", size: 25 * 1024 * 1024 + 1 }).error === "Video must be under 25MB." && !R.validateVideoFile({ name: "a.mov", type: "video/quicktime", size: 5 }).ok);
check("L15 video duration: 5 and 15 pass; 4.9 and 15.1 give 'Video duration must be between 5 and 15 seconds.'", R.validateVideoDuration(5).ok && R.validateVideoDuration(15).ok && R.validateVideoDuration(4.9).error === "Video duration must be between 5 and 15 seconds." && R.validateVideoDuration(15.1).error === "Video duration must be between 5 and 15 seconds." && !R.validateVideoDuration(NaN).ok);
check("L16 duration is shown as m:ss (8.4 -> 0:08, 65 -> 1:05)", R.formatDuration(8.4) === "0:08" && R.formatDuration(65) === "1:05");
check("L17 a playbook needs everything: complete passes; no video, 3 screenshots, short title each fail", R.validatePlaybookListing(good).ok && !R.validatePlaybookListing({ ...good, video: null }).ok && !R.validatePlaybookListing({ ...good, screenshotCount: 3 }).ok && !R.validatePlaybookListing({ ...good, title: a(9) }).ok && !R.validatePlaybookListing({ ...good, video: { duration: 20 } }).ok);

const sell = noComments(read("app/sell/page.jsx"));
check("L20 the sell page uses the shared rules, shows 'n / max' counters (green in range) and gates Continue on them", /validateListingText\(form\)/.test(sell) && /MinCount value=\{form\.description\} min=\{LISTING_RULES\.descriptionMin\} max=\{LISTING_RULES\.descriptionMax\}/.test(sell) && /MinCount value=\{form\.zipContents\} min=\{LISTING_RULES\.zipContentsMin\} max=\{LISTING_RULES\.zipContentsMax\}/.test(sell) && /MinCount value=\{form\.title\}/.test(sell) && /\{count\} \/ \{max\}/.test(sell) && /const canContinue = text\.ok/.test(sell));
check("L21 failing fields are highlighted (red border + aria-invalid)", (sell.match(/aria-invalid=\{bad\(/g) || []).length === 3 && /#B33A2E/.test(sell));
check("L22 the price step disables submit outside ₹50-₹999 and shows the message", /disabled=\{!priceCheck\.ok \|\| submitting\}/.test(sell) && /priceCheck\.error/.test(sell));
check("L23 the final submit re-checks all rules (incl. media) before inserting, stores the video, and maps the database refusal (CM081)", /validatePlaybookListing\(\{ \.\.\.form, screenshotCount/.test(sell) && /preview_video_url/.test(sell) && /preview_video_duration/.test(sell) && /insertError\.code === "CM081"/.test(sell));
check("L23b Continue on the upload step needs 4-10 screenshots and a 5-15s video", /ScreenshotUploader/.test(sell) && /VideoUploader/.test(sell) && /LISTING_RULES\.screenshotsMin/.test(sell) && /LISTING_RULES\.videoMinDurationSeconds/.test(sell));
const api = noComments(read("app/api/listings/create-workflow-agent/route.js"));
check("L24 the workflow/agent API route enforces the rules server-side and maps CM081", /validateProductListing\(\{ title, description, price \}\)/.test(api) && /CM081/.test(api) && !/title\.trim\(\)\.length < 3/.test(api));
const wf = noComments(read("components/WorkflowAgentListingForm.jsx"));
check("L25 the workflow/agent form shows counters, price bounds and disables submit until valid", /validateProductListing/.test(wf) && /disabled=\{submitting \|\| !rules\.ok\}/.test(wf) && /\/ \{LISTING_RULES\.descriptionMin\} characters/.test(wf));
const mig = noComments(read("supabase/migrations/20261031100000_media_and_listing_updates.sql")).toLowerCase();
check("L26 the media migration is additive and enforces every limit: 10-20 / 500-2000 / 250-500, 4-10 screenshots, video required, 5-15s, price 50-999, SECURITY DEFINER with empty search_path", !/drop\s+(table|column|function|trigger)/.test(mig) && /new\.seller_id is distinct from \(select auth\.uid\(\)\)/.test(mig) && /set search_path = ''/.test(mig) && /not between 10 and 20/.test(mig) && /not between 500 and 2000/.test(mig) && /not between 250 and 500/.test(mig) && /not between 4 and 10/.test(mig) && /video_required/.test(mig) && /< 5\.0/.test(mig) && /> 15\.0/.test(mig) && /< 50 or new\.price > 999/.test(mig) && /'listing-media'/.test(mig) && /26214400/.test(mig));

// settlement CSV
const batch = { label: "2026-10" };
const items = [
  { status: "pending", bank_beneficiary_name: "Asha Rao", bank_account_number: "0012345678901", bank_ifsc: "HDFC0001234", bank_account_type: "savings", amount_paise: 49200, utr: null },
  { status: "paid", bank_beneficiary_name: "Ravi K", bank_account_number: "123456789012", bank_ifsc: "ICIC0004321", bank_account_type: "current", amount_paise: 100, utr: "UTR99" },
  { status: "pending", seller_name: "No bank", vpa_address: "a@b", amount_paise: 100 },
];
const lines = Sx.buildSettlementCsv(batch, items, { onlyPending: false }).trimEnd().split("\r\n");
check("L30 the CSV has the 6 columns in order", lines[0].split(",").join("|") === "Beneficiary Name|Account Number|IFSC Code|Account Type|Net Payout (INR)|Remarks", lines[0]);
check("L31 account number is quoted text with its leading zeros; amount exact", lines[1] === 'Asha Rao,"0012345678901",HDFC0001234,Savings,492.00,Chatmarket payout 2026-10', lines[1]);
check("L32 Remarks follows 'Chatmarket payout [Batch Label] - Ref [UTR]' once a reference exists", lines[2].endsWith("Chatmarket payout 2026-10 - Ref UTR99") && lines[2].includes(",Current,1.00,"), lines[2]);
check("L33 items without a bank snapshot are skipped", lines.length === 3);
const tab = noComments(read("components/AdminSettlementTab.jsx"));
check("L34 the desk has a 'Download Settlement CSV' button wired to the CSV builder", /Download Settlement CSV/.test(tab) && /buildSettlementCsv\(batch, items/.test(tab) && /onClick=\{exportCsv\}/.test(tab));
check("L35 Pause is shown for an active account and Resume for a suspended one, calling toggleSeller(id, 'suspended' | 'active')", /accountStatus === "suspended"/.test(tab) && /toggleSeller\(sellerId, "active"\)[\s\S]{0,200}Resume/.test(tab) && /toggleSeller\(sellerId, "suspended"\)[\s\S]{0,200}Pause/.test(tab));
check("L36 the toggle is available in the preview, the blocked list and the batch items, and the batch is reloaded after a change", (tab.match(/<PayoutToggle /g) || []).length === 3 && /await loadDetail\(detail\.batch\.batch_id\)/.test(tab));

console.log(`\nA69: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
