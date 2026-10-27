// A66 -- legal and help pages: merchant identity, refund SLA, consistency, no dead links, honest cookie panel. Static; no database, no network.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { BUSINESS as B } from "../../lib/business.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const PAGES = { terms: "app/terms/page.jsx", refund: "app/refund/page.jsx", privacy: "app/privacy/page.jsx", about: "app/about/page.jsx", help: "app/help/page.jsx" };
const src = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, read(p)]));
// text each page actually shows = its source with the shared constants substituted
const shown = (k) => src[k].replace(/\$\{B\.(\w+)\}/g, (_, f) => String(B[f])).replace(/\{B\.(\w+)\}/g, (_, f) => String(B[f]));

check("P01 the merchant identity is exactly as supplied", B.operator === "MURALEEDHARAN ADVAITH" && B.email === "chatmarket2@gmail.com" && B.address === "No. 29 Kodambakkam High Road, Nungambakkam, Chennai - 600034, Tamil Nadu, India");
check("P02 the supplied support SLA is 24-48 business hours, and there is no refund window or refund-credit constant left in the shared details", /24–48 business hours/.test(B.supportSla) && !("refundRequestDays" in B) && !("refundCreditDays" in B) && !("inAppReportHours" in B));
check("P03 the pages take identity from lib/business.js and never hard-code a different email or address", Object.values(src).every((s) => !/@gmail\.com/.test(s.replace(/\$\{B\.email\}/g, ""))) && Object.values(src).every((s) => !/Kodambakkam/.test(s)));
check("P04 TERMS: intermediary, payment gateway + split settlement to the Seller, licence, liability, all sales final, disputes, Chennai jurisdiction", /intermediary and technology enabler/.test(src.terms) && /split settlement/.test(src.terms) && /personal, non-exclusive/.test(src.terms) && /Limitation of liability/i.test(src.terms) && /All sales are final/.test(src.terms) && /report it at any time/.test(src.terms) && /courts at \$\{B\.city\}/.test(src.terms) && B.city.startsWith("Chennai"));
check("P05 REFUND: digital goods, instant access, ALL SALES FINAL with no refunds/returns/exchanges, reports allowed at any time without a refund, payment errors are not sales", /digital product/i.test(src.refund) && /All sales are final/.test(src.refund) && /does not provide refunds, returns or exchanges/.test(src.refund) && /report it at any time/.test(src.refund) && /does not entitle you to a refund/.test(src.refund) && /payment error, not a sale/.test(src.refund) && !/within \d+ days|business days|5–7/.test(src.refund));
check("P06 PRIVACY: data collected, no card/CVV stored, payment partner + Supabase named, deletion requests to the support email", /order ID, payment reference/i.test(src.privacy) && /never store card numbers, CVVs/.test(src.privacy) && /PCI-DSS/.test(src.privacy) && /payment gateway partner/.test(src.privacy) && /Supabase/.test(src.privacy) && /\$\{B\.email\}/.test(src.privacy) && /delete/i.test(src.privacy));
check("P07 PRIVACY is honest about the AI demo provider and about seller details going to Razorpay (not stored by us)", /Anthropic/.test(src.privacy) && /we keep only the resulting account identifier and status/i.test(src.privacy));
check("P08 ABOUT: mission, full price settled to the creator, no commission, all sales final, operated by the named proprietor in Chennai", /discovering, sharing and monetising AI prompts/.test(src.about) && /no commission/.test(src.about) && /all sales are final/.test(src.about) && /\$\{B\.operator\}, based in \$\{B\.city\}/.test(src.about));
check("P09 HELP: support SLA, support email, Grievance Officer under the IT Rules 2021, registered address", /\{B\.supportSla\}/.test(src.help) && /Support email/.test(src.help) && /Grievance Officer/.test(src.help) && /Intermediary Guidelines and Digital Media Ethics Code\) Rules, 2021/.test(src.help) && /Registered business address/.test(src.help) && /\{B\.operator\}/.test(src.help));
check("P10 every page builds from the shared layout or TopNav, with the site fonts and #14213D", ["terms", "refund", "privacy", "about"].every((k) => /LegalPage/.test(src[k])) && /Fraunces/.test(read("components/LegalPage.jsx")) && /IBM Plex Sans/.test(read("components/LegalPage.jsx")) && /#14213D/.test(read("components/LegalPage.jsx")) && /TopNav/.test(src.help));

// consistency: no page still describes the retired flows
const all = [...Object.keys(PAGES).map(shown), read("app/for-sellers/page.jsx"), read("app/how-it-works/page.jsx")].join("\n");
check("P11 no page still promises a payout hold, 'platform fee included', identity/bank payout setup, or a refund window", !/held for 48 hours/i.test(all) && !/platform fee is built into the price/i.test(all) && !/includes chatmarket's platform fee/i.test(all) && !/payout setup \(identity and bank/i.test(all) && !/can't be submitted/.test(all) && !/within 48 hours/.test(all) && !/within 7 days/.test(all) && !/can issue a refund|will be refunded|is refunded/i.test(all));
check("P12 the position is the same everywhere: reports at any time, all sales final, no refund", ["refund", "help", "terms"].every((k) => /at any time/.test(src[k]) && /final|do not lead to refunds|not entitle/.test(src[k])) && /at any time, or email chatmarket2@gmail\.com/.test(read("app/how-it-works/page.jsx")) && /All sales are final/.test(read("app/for-sellers/page.jsx")));
check("P12b NO page or panel names the payment gateway (the word Razorpay appears nowhere in the pages, footer or cookie panel)", [...Object.values(PAGES), "app/for-sellers/page.jsx", "app/how-it-works/page.jsx", "app/refund-policy/page.jsx", "components/SiteFooter.jsx", "components/CookiePreferencesModal.jsx", "components/LegalPage.jsx", "lib/business.js"].every((f) => !/razorpay/i.test(read(f))), [...Object.values(PAGES), "app/for-sellers/page.jsx", "app/how-it-works/page.jsx"].filter((f) => /razorpay/i.test(read(f))));
const pur = read("components/PurchaseHistoryClient.jsx");
check("P12c the Purchases page lets a buyer report an issue at any time (no 48-hour cut-off) and says a report does not lead to a refund", !/48/.test(pur) && !/windowClosed/.test(pur) && /Report an issue/.test(pur) && /does not lead to a refund/.test(pur));
const mig = read("supabase/migrations/20261027100000_disputes_report_any_time.sql"), migLow = mig.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").toLowerCase();
check("P12d the migration replaces only the dispute-insert policy: no time limit, still own purchase + paid + own buyer id; nothing else dropped", /drop policy "buyers can file a dispute on their own paid purchase" on public\.disputes/.test(migLow) && /create policy "buyers can file a dispute on their own paid purchase"/.test(migLow) && !/interval/.test(migLow) && /pu\.status = 'paid'/.test(migLow) && /auth\.uid\(\)\) = buyer_id/.test(migLow) && (migLow.match(/\bdrop\b/g) || []).length === 1 && !/(delete from|truncate|drop table|drop column|drop function)/.test(migLow));
check("P13 the pages make no claim of a commission or fee that contradicts 'no commission'", !/\b(18%|platform fee of)/i.test(all));

// links
const footer = read("components/SiteFooter.jsx");
const hrefs = new Set();
for (const f of ["components/SiteFooter.jsx", "components/CookiePreferencesModal.jsx", "app/for-sellers/page.jsx", "app/how-it-works/page.jsx", "app/signup/page.jsx", ...Object.values(PAGES)]) for (const m of read(f).matchAll(/(?:href|permanentRedirect)\(?[=(]?\s*[{"']*"?(\/[a-z-]*)"/g)) hrefs.add(m[1]);
const routeOk = (h) => h === "/" || exists(`app${h}/page.jsx`);
check("P14 every internal link in the footer, cookie panel, seller/how-it-works pages and the policy pages points at a real page", [...hrefs].every(routeOk), [...hrefs].filter((h) => !routeOk(h)));
check("P15 the footer links to About, Help (Contact us), Privacy, Terms and Refund, and shows the operator, address and email", ["/about", "/help", "/privacy", "/terms", "/refund"].every((h) => footer.includes(`href: "${h}"`)) && /Contact us/.test(footer) && /B\.operator/.test(footer) && /B\.address/.test(footer) && /B\.email/.test(footer));
check("P16 the old /refund-policy address permanently redirects to /refund and nothing links to it any more", /permanentRedirect\("\/refund"\)/.test(read("app/refund-policy/page.jsx")) && !["components", "app", "lib"].some((d) => { const w = (x) => fs.readdirSync(path.join(root, x), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? w(`${x}/${e.name}`) : [`${x}/${e.name}`]); return w(d).filter((f) => /\.(js|jsx)$/.test(f) && f !== "app/refund-policy/page.jsx").some((f) => /refund-policy/.test(read(f))); }));

// cookies
const ck = read("components/CookiePreferencesModal.jsx");
check("P17 the cookie panel describes only session/preference/payment cookies and says there are no advertising or cross-site tracking cookies", /Supabase authentication cookies/.test(ck) && /do not use advertising or cross-site tracking cookies/.test(ck) && !/Advertising cookies are used|Social media cookies let/.test(ck));
check("P18 the cookie panel no longer offers accept/reject switches for categories that do not exist", !/type="radio"/.test(ck) && !/localStorage/.test(ck));
check("P19 the privacy page's cookie statement matches the panel", /only the cookies needed to sign you in/.test(src.privacy) && /do not use advertising or cross-site tracking cookies/.test(src.privacy));

// ---- checkout hardening (Standard Checkout: minimum amount, secrets hygiene)
const co = read("app/api/razorpay/create-order/route.js"), gi = read(".gitignore"), vp = read("app/api/razorpay/verify-payment/route.js");
check("P20 create-order refuses an amount under 100 paise with a 400 before calling the gateway", /amountPaise < 100/.test(co) && co.indexOf("amountPaise < 100") < co.indexOf("api.razorpay.com/v1/orders"));
check("P21 .env files are git-ignored and .env.example holds names only, no values", /^\.env$/m.test(gi) && !/=\s*\S*[A-Za-z0-9]{20,}/.test(read(".env.example")));
check("P22 no file contains a live-looking Razorpay secret and the secret is only read server-side (never NEXT_PUBLIC)", !/NEXT_PUBLIC_RAZORPAY_KEY_SECRET/.test(["app", "components", "lib"].flatMap((d) => { const w = (x) => fs.readdirSync(path.join(root, x), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? w(`${x}/${e.name}`) : [`${x}/${e.name}`]); return w(d).filter((f) => /\.(js|jsx)$/.test(f)).map(read); }).join("")) && /createHmac\("sha256", process\.env\.RAZORPAY_KEY_SECRET\)/.test(vp) && /timingSafeEqual/.test(vp) && /status: 400/.test(vp));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
