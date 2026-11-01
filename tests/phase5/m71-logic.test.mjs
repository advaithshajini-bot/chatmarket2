// A71 -- sticky sidebar, legal names (no emails), swipe gallery, Amazon-style account menu, profile provisioning (static; no DB).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const nc = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join("\n");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const N = await import("../../lib/domain/public-name.js");

check("W01 an email becomes its first part, never the address", N.safePublicName("john.doe@example.com") === "john doe" && !/@/.test(N.publicSellerName("a@b.com")));
check("W02 real names pass through; blanks, '@x.com', null fall to 'Verified Creator'", N.safePublicName("Asha Rao") === "Asha Rao" && N.publicSellerName("", null, "@x.com") === "Verified Creator" && N.DEFAULT_CREATOR_NAME === "Verified Creator");
check("W03 candidates are tried in order", N.publicSellerName("Legal Name", "Display") === "Legal Name" && N.publicSellerName(null, "Display") === "Display");
check("W04 first name for the greeting", N.firstName("Asha Rao") === "Asha" && N.firstName("john.doe@x.com") === "john" && N.firstName("") === null);

const lp = nc(read("app/listing/[id]/page.jsx"));
check("S01 the right column is sticky on desktop and holds both the checkout box and the seller card", /<div className="lg:sticky lg:top-\d+[^"]*space-y-4">\s*<ListingCheckout listing=\{listing\} \/>\s*<SellerCard/.test(lp));
check("S02 no ancestor of the sidebar clips with overflow-hidden (it would break position: sticky)", !/<main[^>]*overflow/.test(lp) && !/grid grid-cols-1 lg:grid-cols-3[^>]*overflow/.test(lp));
check("S03 the seller name is resolved from the public profile (legal name), falls back to a sanitized stored name, and feeds header, checkout and seller card", /const resolvedSellerLegalName = publicSellerName\(sellerProfile\?\.display_name, product\.sellerName\)/.test(lp) && /seller_name: resolvedSellerLegalName/.test(lp) && /fallbackName=\{resolvedSellerLegalName\}/.test(lp) && /\{resolvedSellerLegalName\}<\/span>/.test(lp));
const co = nc(read("components/ListingCheckout.jsx"));
check("S04 checkout 'Sold & Fulfilled by' and the settlement note use the sanitized name", /const sellerName = publicSellerName\(listing\.seller_name\)/.test(co));
const prod = nc(read("lib/domain/products.js"));
check("S05 every product read exposes a sanitized sellerName (Home, Browse, listing)", /sellerName: publicSellerName\(seller_name\)/.test(prod));
check("S06 new listings store a sanitized seller name (sell wizard and workflow/agent API)", /publicSellerName\(userData\.user\.user_metadata/.test(read("app/sell/page.jsx")) && /publicSellerName\(user\.user_metadata/.test(read("app/api/listings/create-workflow-agent/route.js")));
check("S07 library and purchases show sanitized seller names", /publicSellerName\(listing\.seller_name\)/.test(read("components/LibraryClient.jsx")) && /publicSellerName\(listing\.seller_name\)/.test(read("components/LibraryDetailClient.jsx")) && /publicSellerName\(p\.listings\?\.seller_name\)/.test(read("app/purchases/page.jsx")));
const sc = nc(read("components/SellerCard.jsx"));
check("S08 the seller card never prints an email (no email field, name from the profile or the resolved fallback)", !/(profile|user|seller)\??\.email/.test(sc) && /profile\?\.display_name \|\| fallbackName/.test(sc));

const g = nc(read("components/ScreenshotGallery.jsx"));
check("G01 swipe: touch start/move/end handlers with a 45px threshold, left = next, right = previous (wrapping)", /onTouchStart/.test(g) && /onTouchMove/.test(g) && /onTouchEnd/.test(g) && /SWIPE_PX = 45/.test(g) && /startX - endX > SWIPE_PX\) setActive\(\(a\) => \(a \+ 1\) % n\)/.test(g) && /endX - startX > SWIPE_PX\) setActive\(\(a\) => \(a - 1 \+ n\) % n\)/.test(g));
check("G02 a tap still opens the lightbox (but not after a swipe); dots, thumbnails and 'X of Y' remain; fade transition", /if \(!touch\.current\.moved\) setOpen\(true\)/.test(g) && /Show screenshot \$\{i \+ 1\}/.test(g) && /\{active \+ 1\} of \{n\}\s*</.test(g) && !/swipe or tap/i.test(g) && /shotFade/.test(g));
check("G03 the lightbox can be swiped too", /role="dialog".*onTouchStart=\{onTouchStart\}/.test(g));

const am = nc(read("components/AccountMenu.jsx"));
check("A01 two lines: 'Hello, <first name>' / 'Hello, sign in' above 'Accounts & Lists' with a chevron", /Hello, \$\{firstName\(user\.name\)/.test(am) && /Hello, sign in/.test(am) && /Accounts &amp; Lists/.test(am) && /ChevronDown/.test(am));
check("A02 opens on hover (150ms leave delay), on keyboard focus, on tap; closes on Escape / outside", /LEAVE_DELAY_MS = 150/.test(am) && /onMouseEnter=\{show\}/.test(am) && /onFocus=\{show\}/.test(am) && /onClick=\{\(\) => setOpen/.test(am) && /Escape/.test(am));
check("A03 links: Public Profile, My Library, My Products & Listings, Creator Dashboard, Settings", /\/sellers\/\$\{user\.id\}/.test(am) && /href="\/library"/.test(am) && /href="\/sell\/earnings"/.test(am) && /href="\/sell"/.test(am) && /href="\/settings"/.test(am));
check("A04 logged out: Sign In button + 'New customer? Start here' -> /signup; logged in: Sign Out calls supabase.auth.signOut()", /href="\/login"[^>]*>Sign In/.test(am) && /New customer\?/.test(am) && /href="\/signup"/.test(am) && /auth\.signOut\(\)/.test(am) && />Sign Out</.test(am));
const tn = nc(read("components/TopNav.jsx"));
check("A05 TopNav uses AccountMenu instead of the plain name + Log out", /<AccountMenu user=\{user\}/.test(tn) && !/Log out/.test(tn) && !/\{user\.name\}/.test(tn));
const au = nc(read("lib/supabase/use-auth-user.js"));
check("A06 the signed-in name is the legal / display name, never the raw email", /select\("is_admin, display_name, legal_name"\)/.test(au) && /safePublicName\(profile\?\.display_name\) \|\| safePublicName\(profile\?\.legal_name\)/.test(au) && !/name: data\.user\.user_metadata\?\.display_name \|\| data\.user\.email/.test(au) && /id: data\.user\.id/.test(au));

const land = nc(read("components/LandingClient.jsx"));
check("H01 the home page nav shows the 'Hello, sign in' / 'Accounts & Lists' menu, not separate Log in / Sign up / Log out", /<AccountMenu user=\{user\}/.test(land) && !/>Log in</.test(land) && !/>Sign up</.test(land) && !/>Log out</.test(land));
check("Z01 the listing page shows a 'What's in the zip' box fed by the zip_contents note (only when present)", /What's in the zip/.test(lp) && /listing\.zip_contents\?\.trim\(\) &&/.test(lp) && /\{listing\.zip_contents\}/.test(lp));
check("S09 the sidebar column is the only sticky element (the checkout box is not sticky itself), and it scrolls internally if taller than the screen", !/sticky/.test(co) && /lg:sticky lg:top-28 lg:max-h-\[calc\(100vh-8rem\)\] lg:overflow-y-auto/.test(lp));
const mig = nc(read("supabase/migrations/20261101100000_profile_and_seller_name_updates.sql")).toLowerCase();
check("M01 migration: legal_name column, trigger on auth.users re-pointed to a SECURITY DEFINER function with empty search_path, backfill, RPC replaced; nothing dropped but the trigger", /add column if not exists legal_name/.test(mig) && /create trigger on_auth_user_created\s+after insert on auth\.users/.test(mig) && /execute function public\.handle_new_user_profile\(\)/.test(mig) && /set search_path = ''/.test(mig) && /on conflict \(id\) do nothing/.test(mig) && /not exists \(select 1 from public\.profiles/.test(mig) && !/drop (table|column|function)/.test(mig) && /bank_beneficiary_name/.test(mig) && /'verified creator'/.test(mig));
console.log(`A71: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
