// A75 -- homepage FAQ, login terms agreement + password toggle, privacy tax wording, clean footer (static; no DB, no network).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const land = read("components/LandingClient.jsx"), login = read("app/login/page.jsx"), foot = read("components/SiteFooter.jsx"), priv = read("app/privacy/page.jsx");

check("F01 the home page has a 'Frequently Asked Questions' section with the five specified questions", /Frequently Asked Questions/.test(land) && ["How does purchasing and delivery work\\?", "What is the refund policy\\?", "How do creators get paid\\?", "Do I need to provide PAN and tax details to sell\\?", "Can I use purchased playbooks for commercial client work\\?"].every((q) => new RegExp(q).test(land)));
check("F02 the answers match the live operating model (instant unlock in Library, all sales final, 18% fee + IMPS/NEFT around the 1st, PAN with 194-O / 52, non-exclusive commercial licence)", /unlock instantly in your Library/.test(land) && /all sales are final/.test(land) && /18% platform fee/.test(land) && /IMPS\/NEFT\) on or around the 1st of every month/.test(land) && /Section 194-O TDS and Section 52 GST TCS/.test(land) && /non-exclusive commercial license/.test(land));
check("F03 the accordion is accessible: buttons with aria-expanded / aria-controls, regions labelled by their question, animated open/close", /aria-expanded=\{open\}/.test(land) && /aria-controls=\{`faq-panel-\$\{i\}`\}/.test(land) && /role="region"/.test(land) && /aria-labelledby/.test(land) && /grid-template-rows .25s/.test(land));
check("F04 the old checkout/payment-chip section is gone (no 'Pay however you already do', no gateway name, no payment chips)", !/Pay however you already do/.test(land) && !/Razorpay/.test(land) && !/lpay-chip"/.test(land.replace(/\.lpay-chip[^\n]*/g, "")));
check("F05 the FAQ uses the site palette and fonts (Fraunces question text, #14213D)", /\.lfaq-q\{[^}]*Fraunces[^}]*#14213D/.test(land));

check("L01 login has a required Terms of Service + Privacy Policy checkbox with both links opening in a new tab", /type="checkbox"/.test(login) && /href="\/terms" target="_blank"/.test(login) && /href="\/privacy" target="_blank"/.test(login) && /Terms of Service/.test(login) && /Privacy Policy/.test(login));
check("L02 Log in is disabled until agreed, the submit handler refuses (inline message) without it, and so does Google sign-in", /disabled=\{loading \|\| !agreedToTerms\}/.test(login) && (login.match(/if \(!agreedToTerms\) \{\s*setError\(TERMS_ERROR\)/g) || []).length === 2);
check("L03 the password eye toggle is positioned inside the input wrapper, independent of the error state", /className="relative"/.test(login) && /absolute right-3 top-1/.test(login) && /Eye size=\{16\}/.test(login) && /EyeOff size=\{16\}/.test(login));
check("L04 the toggle shows whenever the password has text (never tied to `error`) and the password is not cleared after a failed attempt", /password\.length > 0 && \(/.test(login) && !/error\s*&&[^\n]*(Eye|setShowPassword)/.test(login) && !/setPassword\(""\)/.test(login));
check("L05 the toggle is a real button (type=button) with a label that changes (Show / Hide password)", /type="button"\s+onClick=\{\(\) => setShowPassword/.test(login) && /"Hide password" : "Show password"/.test(login));

check("T01 privacy section 3 uses the specified copy: TDS under Section 194-O of the Income-tax Act, TCS under Section 52 of the CGST Act 2017, last four digits", /Tax Deducted at Source \(TDS\) under Section 194-O of the Income-tax Act/.test(priv) && /Tax Collected at Source \(TCS\) under Section 52 of the Central Goods and Services Tax Act, 2017/.test(priv) && /showing only the last four digits/.test(priv));
check("T02 no page mentions Section 206AB any more", !/206AB/.test(read("app/privacy/page.jsx")) && !/206AB/.test(land));

check("R01 the footer shows no operator name, street address or email", !/MURALEEDHARAN|Kodambakkam|@gmail|B\.operator|B\.address|B\.email|lib\/business/.test(foot));
check("R02 the footer keeps the copyright line and the navigation, legal and cookie links", /© 2026 chatmarket\. All rights reserved\./.test(foot) && ["/about", "/help", "/privacy", "/terms", "/refund"].every((h) => foot.includes(`href: "${h}"`)) && /Manage cookies/.test(foot));
check("R03 the operator details still live in lib/business.js and are rendered on /help", /MURALEEDHARAN ADVAITH/.test(read("lib/business.js")) && /B\.(email|address|operator)/.test(read("app/help/page.jsx")));
console.log(`A75: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
