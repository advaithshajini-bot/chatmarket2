// A72 -- settings page (username) and delete-account flow (static; no DB, no network).
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const nc = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|--|\*|\/\*)/.test(l)).join("\n");
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log("PASS:", n); } else { fail++; console.log("FAIL:", n, x === undefined ? "" : `-- ${JSON.stringify(x)}`); } };
const U = await import("../../lib/domain/username.js");

check("U01 username 3-30 characters passes; 2, 31 and blanks fail", U.validateUsername("Asha").ok && U.validateUsername("abc").ok && !U.validateUsername("ab").ok && !U.validateUsername("a".repeat(31)).ok && U.validateUsername("a".repeat(30)).ok && !U.validateUsername("   ").ok && !U.validateUsername(null).ok);
check("U02 an email or odd characters are refused; spaces are collapsed and trimmed", !U.validateUsername("a@b.com").ok && !U.validateUsername("<script>").ok && U.validateUsername("  Asha   Rao ").value === "Asha Rao" && U.validateUsername("O'Neil-Rao_1.2").ok);
check("U03 refusal reasons are explained in plain words", /payout/i.test(U.explainDeleteRefusal("unsettled_earnings")) && /issue/i.test(U.explainDeleteRefusal("open_dispute")) && /Admin/.test(U.explainDeleteRefusal("admin_account")) && /couldn't/i.test(U.explainDeleteRefusal("x")));

const st = nc(read("app/settings/page.jsx"));
check("P01 settings page: username field, 'Save changes' button on the right below it, updates profiles.display_name for the signed-in user", /id="username"/.test(st) && /justify-end[\s\S]*Save changes/.test(st) && /from\("profiles"\)\.update\(\{ display_name: check\.value \}\)\.eq\("id", userId\)/.test(st) && /auth\.updateUser\(\{ data: \{ display_name/.test(st));
check("P02 save is disabled when invalid, unchanged or saving; errors are shown inline; logged-out visitors go to /login", /disabled=\{saving \|\| !check\.ok \|\| unchanged\}/.test(st) && /aria-invalid/.test(st) && /router\.replace\("\/login"\)/.test(st));
check("P03 'Delete account' is the LAST section of the settings page and opens the flow", st.lastIndexOf("Delete account") > st.indexOf("Save changes") && /<DeleteAccountFlow onClose/.test(st) && st.indexOf('aria-label="Delete account"') > st.indexOf('aria-label="Username"'));
const fl = nc(read("components/DeleteAccountFlow.jsx"));
check("F01 step 1: reasons list with exactly two buttons 'Keep account' and 'Next' (Next needs a reason)", /DELETE_REASONS\.map/.test(fl) && /Keep account/.test(fl) && />Next</.test(fl) && /disabled=\{!reason\}/.test(fl));
check("F02 step 2: warning + 'type DELETE'; the DELETE button appears only when the text is exactly DELETE (capitals)", /Delete account warning/.test(fl) && /typed === "DELETE" &&/.test(fl) && />\{busy \? "Deleting…" : "DELETE"\}</.test(fl));
check("F03 DELETE calls the API with the typed confirmation and the reason, shows server errors, then step 3", /fetch\("\/api\/account\/delete"/.test(fl) && /confirm: typed, reason/.test(fl) && /setStep\(3\)/.test(fl) && /role="alert"/.test(fl));
check("F04 step 3: 'Account deleted' with an OK button that signs out and goes to /login", /Account deleted/.test(fl) && />OK</.test(fl) && /router\.push\("\/login"\)/.test(fl) && /auth\.signOut\(\)/.test(fl));
check("F05 the modal cannot be dismissed by clicking outside once deleted or while deleting", /step !== 3 && !busy/.test(fl));
const rt = nc(read("app/api/account/delete/route.js"));
check("R01 API: login required, confirm must be exactly DELETE, uses the caller's session for the database function, service key only for locking the login", /status|401/.test(rt) && /body\?\.confirm !== "DELETE"/.test(rt) && /supabase\.rpc\("delete_my_account"\)/.test(rt) && /createServiceClient\(\)/.test(rt) && /ban_duration/.test(rt) && /deleted-\$\{uid\}@deleted\.invalid/.test(rt) && /409/.test(rt));
check("R02 API refuses before touching data when the service key is missing", rt.indexOf("createServiceClient()") < rt.indexOf('rpc("delete_my_account")'));
const mig = nc(read("supabase/migrations/20261101200000_delete_my_account.sql")).toLowerCase();
check("R03 migration: additive, SECURITY DEFINER with empty search_path, anonymises (no delete from auth.users / purchases / settlements), refuses on money or disputes", !/drop /.test(mig) && !/delete from (auth\.users|public\.purchases|public\.purchase_settlements|public\.settlement_items|public\.profiles)/.test(mig) && /set search_path = ''/.test(mig) && /unsettled_earnings/.test(mig) && /open_dispute/.test(mig) && /admin_account/.test(mig) && /grant execute on function public\.delete_my_account\(\) to authenticated/.test(mig));
check("R04 the account menu's Settings link goes to /settings; the nav greets with the chosen username first", /href="\/settings"/.test(read("components/AccountMenu.jsx")) && /safePublicName\(profile\?\.display_name\) \|\| safePublicName\(profile\?\.legal_name\)/.test(read("lib/supabase/use-auth-user.js")));
console.log(`A72: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
