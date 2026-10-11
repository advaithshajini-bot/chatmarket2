// Mutation testing: apply ONE deliberate defect, run the relevant suite, and require it to FAIL (the defect is "killed").
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const repo = process.argv[2];
const env = { ...process.env };
const run = (cmd, args, e = env) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8", env: e });
const MIG = "supabase/migrations/20260930100800_add_seller_admin_review.sql";
const sqlMuts = [
  ["admin RPC skips MFA check (review_listing_demo)", MIG, (s) => s.replace(/(create function public\.review_listing_demo[\s\S]*?begin\n  )if not private\.is_admin_mfa\(\) then raise exception using errcode = '42501', message = 'admin_required'; end if;/, "$1")],
  ["admin RPC uses is_admin instead of is_admin_mfa (queue)", MIG, (s) => s.replace(/(create function public\.admin_review_queue[\s\S]*?begin\n  )if not private\.is_admin_mfa\(\)/, "$1if not private.is_admin()")],
  ["stale-review check removed", MIG, (s) => s.replace("if p_expected_version is distinct from v_d.config_version then", "if false then")],
  ["reject no longer needs a note", MIG, (s) => s.replace(/if p_decision = 'reject' and \(v_note is null or char_length\(v_note\) < 10\) then\n    raise exception using errcode = 'CM057', message = 'review_note_required';\n  end if;\n  if v_note is not null and char_length\(v_note\) > 1000 then\n    raise exception using errcode = 'CM057', message = 'review_note_required';\n  end if;\n  select d\.\*/, "select d.*")],
  ["blueprint hash comparison removed", MIG, (s) => s.replace("or p_verified_sha256 <> v_s.sha256 then", "then")],
  ["self-review allowed (demo)", MIG, (s) => s.replace(/if v_seller is not distinct from auth\.uid\(\) then\n    raise exception using errcode = 'CM060', message = 'self_review_forbidden';\n  end if;\n  if v_d\.review_status/, "if v_d.review_status")],
  ["blueprint guard trigger disabled", MIG, (s) => s.replace("if v_changed and (", "if false and (")],
  ["guard ignores the role check (GUC alone suffices)", MIG, (s) => s.replace("\n                    or current_user in ('anon', 'authenticated', 'service_role', 'authenticator')) then", ") then")],
  ["content edit no longer withdraws approval", MIG, (s) => s.replace("    new.config_version := old.config_version + 1;\n    new.review_status := 'draft';\n    new.approved_at := null; new.approved_by := null;", "    new.config_version := old.config_version + 1;")],
  ["buyers may read ANY object in the listing folder (not just the current blueprint)", MIG, (s) => s.replace("and private.is_current_blueprint(p_name)\n", "\n")],
  ["seller may delete pending/live blueprint objects", MIG, (s) => s.replace("         and not private.is_current_blueprint(name)\n         and not private.is_pending_blueprint(name));", "         );")],
  ["submit_listing_blueprint skips ownership (CM051)", MIG, (s) => s.replace("select l.* into v_listing from public.listings l where l.id = p_listing_id and l.seller_id = auth.uid() for update;", "select l.* into v_listing from public.listings l where l.id = p_listing_id for update;")],
  ["submit_listing_blueprint accepts missing storage object", MIG, (s) => s.replace("if not found or (v_obj_size is not null and v_obj_size <> p_size_bytes) then", "if (v_obj_size is not null and v_obj_size <> p_size_bytes) then")],
  ["listing_demo_info ignores review_status gate (still gated by approved_at)", MIG, (s) => s.replace("or v_demo.approved_at is null or v_demo.review_status <> 'approved' then", "then")],
  ["approve demo does not require enabled", MIG, (s) => s.replace("if not v_d.is_enabled or v_d.sample_input is null then", "if false then")],
  ["step cap lost in save (assert removed) -- EQUIVALENT: the BEFORE INSERT trigger re-validates", MIG, (s) => s.replace("perform private.assert_demo_config(p_demo_config);                -- CM001 / CM002\n", "")],
  ["audit not written on approval", MIG, (s) => s.replace("perform private.write_review_audit(case when p_decision = 'approve' then 'demo_approved' else 'demo_rejected' end,", "perform 1; -- ")],
  ["audit table mutable", MIG, (s) => s.replace("create trigger review_audit_no_update before update or delete on public.review_audit\n  for each row execute function private.review_audit_immutable();", "")],
  ["anon can execute admin RPCs", MIG, (s) => s.replace("revoke execute on function public.admin_review_queue(integer)                                  from public, anon, service_role;", "")],
  ["GUC left on after approval", MIG, (s) => s.replace("perform set_config('chatmarket.blueprint_write', 'off', true);", "")],
];
const jsMuts = [
  ["server trusts a client-supplied hash on approve", "lib/admin/review-handlers.js", (s) => s.replace("verified = v.sha256;", "verified = body.verifiedSha256 ?? v.sha256;")],
  ["approve skips the mismatch check", "lib/admin/review-handlers.js", (s) => s.replace('if (v.status === "mismatch")', "if (false)")],
  ["approve skips the credentials check", "lib/admin/review-handlers.js", (s) => s.replace("if (v.blocking.length > 0)", "if (false)")],
  ["registration route skips the secret check", "lib/studio/route-handlers.js", (s) => s.replace("if (result.scan.blocking.length > 0) {", "if (false) {")],
  ["registration route accepts any path (no folder pinning)", "lib/studio/route-handlers.js", (s) => s.replace("parts[0] !== String(user.id).toLowerCase() || parts[1] !== listingId.toLowerCase()", "false")],
  ["registration route forwards the CLIENT hash", "lib/studio/route-handlers.js", (s) => s.replace("p_sha256: result.sha256", "p_sha256: body?.sha256 ?? result.sha256")],
  ["raw DB message leaks to the seller", "lib/studio/route-handlers.js", (s) => s.replace("json: { error: status === 500 ? fallback : STUDIO_ERROR_COPY[error.code] ?? fallback }", "json: { error: error.message }")],
  ["step cap removed from draft validation", "lib/studio/demo-draft.js", (s) => s.replace("else if (steps.length > MAX_STEPS)", "else if (false)")],
  ["reducer lets a third step in", "lib/studio/demo-draft.js", (s) => s.replace("draft.steps.length >= MAX_STEPS ? draft :", "false ? draft :")],
  ["scanner no longer flags private keys", "lib/blueprints/inspect.js", (s) => s.replace('["private_key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],', "")],
  ["scanner echoes the matched value", "lib/blueprints/inspect.js", (s) => s.replace("if (t) add(blocking, t, path);", "if (t) add(blocking, t, path + \"=\" + v);")],
  ["hash computed on decoded text instead of original bytes", "lib/blueprints/inspect.js", (s) => s.replace("sha256: await sha256Hex(bytes),", "sha256: await sha256Hex(new TextEncoder().encode(text)),")],
  ["upload flow uploads before the secret check", "lib/studio/upload-flow.js", (s) => s.replace("if (inspection.scan.blocking.length > 0) {", "if (false) {")],
  ["upload flow ignores a hash mismatch", "lib/studio/upload-flow.js", (s) => s.replace("if (reg.json?.sha256 !== inspection.sha256) {", "if (false) {")],
  ["desk lets a changed blueprint be approved", "lib/admin/review-state.js", (s) => s.replace('return !!v && v.status === "match" && Array.isArray(v.blocking) && v.blocking.length === 0;', "return !!v;")],
  ["desk allows reject with no note", "lib/admin/review-state.js", (s) => s.replace("noteLength(s) >= MIN_REJECT_NOTE", "true")],
  ["studio allows upload with credentials", "lib/studio/studio-state.js", (s) => s.replace("s.blueprint.inspection?.scan.blocking.length === 0", "true")],
  ["admin gate ignores MFA", "lib/domain/admin-reviews.js", (s) => s.replace('allowed: isAdmin && aal === "aal2"', "allowed: isAdmin")],
  ["studio read leaks other sellers' listings", "lib/domain/studio.js", (s) => s.replace("|| listing.seller_id !== userId", "")],
];
let killed = 0, survived = [];
const t0 = Date.now();
// ---- SQL mutations: rebuild a scratch DB with the mutated migration, run the DB suite
for (const [name, file, fn] of sqlMuts) {
  const orig = readFileSync(`${repo}/${file}`, "utf8"); const mutated = fn(orig);
  if (mutated === orig) { console.log(`INEFFECTIVE (pattern did not match): ${name}`); survived.push(name + " [pattern]"); continue; }
  writeFileSync(`${repo}/${file}`, mutated);
  try {
    const b = run("bash", ["tests/phase4/scratch/setup-scratch-db.sh", "m44mut", file], env);
    let dead;
    if (b.status !== 0) dead = true; // a mutation that doesn't even apply is trivially caught
    else dead = run("node", ["tests/phase4/m44-db.test.mjs"], { ...env, DATABASE_URL: "postgresql://pgs@/m44mut?host=/tmp&port=5544" }).status !== 0;
    console.log(`${dead ? "KILLED  " : "SURVIVED"}: ${name}`); dead ? killed++ : survived.push(name);
  } finally { writeFileSync(`${repo}/${file}`, orig); }
}
// ---- JS mutations: run the logic + guardrail + component suites
for (const [name, file, fn] of jsMuts) {
  const orig = readFileSync(`${repo}/${file}`, "utf8"); const mutated = fn(orig);
  if (mutated === orig) { console.log(`INEFFECTIVE (pattern did not match): ${name}`); survived.push(name + " [pattern]"); continue; }
  writeFileSync(`${repo}/${file}`, mutated);
  try {
    let dead = false;
    for (const t of ["m44-logic", "m44-guardrails", "m44-components"]) if (run("node", [`tests/phase4/${t}.test.mjs`]).status !== 0) { dead = true; break; }
    console.log(`${dead ? "KILLED  " : "SURVIVED"}: ${name}`); dead ? killed++ : survived.push(name);
  } finally { writeFileSync(`${repo}/${file}`, orig); }
}
console.log(`\nMUTATION SCORE: ${killed}/${sqlMuts.length + jsMuts.length} killed in ${Math.round((Date.now() - t0) / 1000)}s`);
if (survived.length) console.log("SURVIVORS:", survived);
process.exit(survived.length ? 1 : 0);
