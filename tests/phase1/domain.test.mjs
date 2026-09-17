import { toProduct, listProducts, getProduct, PRODUCT_TYPES } from "../../lib/domain/products.js";
import { getMyEntitlement, hasActiveEntitlement } from "../../lib/domain/entitlements.js";
import { getRun, listMyRuns } from "../../lib/domain/runs.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

// toProduct is pure -- no supabase call, easy to test directly.
const row = {
  id: "p1", title: "T", description: "D", category: "C", price: 100, status: "live",
  seller_id: "s1", seller_name: "Seller", product_type: "workflow", version: 2,
  configuration: { goal: "x" }, created_at: "2026-01-01", thread: null, preview: null,
  screenshots: null, output_zip_path: null, zip_contents: null, messages: null,
  completion: null, model: null, rating: 4.5, reviews: 3,
};
const p = toProduct(row);
check("toProduct maps product_type -> type", p.type === "workflow");
check("toProduct sets isWorkflow true, isPlaybook/isAgent false", p.isWorkflow && !p.isPlaybook && !p.isAgent);
check("toProduct preserves configuration", p.configuration.goal === "x");
check("toProduct keeps legacy fields in a namespaced bucket, not top-level", p.legacyPlaybookFields && p.thread === undefined);
check("toProduct(null) returns null (no throw)", toProduct(null) === null);
check("PRODUCT_TYPES exported and correct", JSON.stringify(PRODUCT_TYPES) === JSON.stringify(["playbook","workflow","agent"]));

// Build a minimal mock Supabase client to verify:
// (a) every domain read function only calls .select/.eq/.order/.limit/.maybeSingle -- never .insert/.update/.delete/.upsert
// (b) auth.getUser() gating works (no user -> empty/[] result, no query attempted)
function makeMockClient({ user = null, rows = [] } = {}) {
  const calledMethods = [];
  const builder = {
    select: (...a) => { calledMethods.push(["select", a]); return builder; },
    eq: (...a) => { calledMethods.push(["eq", a]); return builder; },
    order: (...a) => { calledMethods.push(["order", a]); return builder; },
    limit: (...a) => { calledMethods.push(["limit", a]); return builder; },
    maybeSingle: async () => { calledMethods.push(["maybeSingle", []]); return { data: rows[0] ?? null, error: null }; },
    insert: (...a) => { calledMethods.push(["insert", a]); return builder; },
    update: (...a) => { calledMethods.push(["update", a]); return builder; },
    delete: (...a) => { calledMethods.push(["delete", a]); return builder; },
    then: (resolve) => resolve({ data: rows, error: null }), // await query resolves to {data, error}
  };
  return {
    from: (table) => { calledMethods.push(["from", [table]]); return builder; },
    auth: { getUser: async () => ({ data: { user } }) },
    _calledMethods: calledMethods,
  };
}

// getProduct: should only ever call select/eq/maybeSingle -- never a mutating method.
const client1 = makeMockClient({ rows: [row] });
const gp = await getProduct(client1, "p1");
check("getProduct returns a mapped product", gp.id === "p1" && gp.type === "workflow");
check("getProduct never calls insert/update/delete", !client1._calledMethods.some(([m]) => ["insert","update","delete"].includes(m)));

// listProducts: default status filter is 'live', never mutates.
const client2 = makeMockClient({ rows: [row] });
await listProducts(client2, { type: "workflow" });
check("listProducts filters by status=live by default", client2._calledMethods.some(([m,a]) => m === "eq" && a[0] === "status" && a[1] === "live"));
check("listProducts filters by product_type when given", client2._calledMethods.some(([m,a]) => m === "eq" && a[0] === "product_type" && a[1] === "workflow"));
check("listProducts never calls insert/update/delete", !client2._calledMethods.some(([m]) => ["insert","update","delete"].includes(m)));

// entitlements.js: no user -> short-circuits to null/[] WITHOUT ever calling .from() (no wasted/leaky query)
const client3 = makeMockClient({ user: null });
const ent = await getMyEntitlement(client3, "p1");
check("getMyEntitlement returns null when unauthenticated", ent === null);
check("getMyEntitlement never touches the database when unauthenticated", !client3._calledMethods.some(([m]) => m === "from"));

const hasEnt = await hasActiveEntitlement(makeMockClient({ user: null }), "p1");
check("hasActiveEntitlement returns false (not throw) when unauthenticated", hasEnt === false);

// runs.js: same unauthenticated short-circuit pattern
const client4 = makeMockClient({ user: null });
const myRuns = await listMyRuns(client4);
check("listMyRuns returns [] when unauthenticated, no query", Array.isArray(myRuns) && myRuns.length === 0 && !client4._calledMethods.some(([m]) => m === "from"));

// getRun: read-only, no mutation methods ever called
const client5 = makeMockClient({ rows: [{ id: "r1", status: "queued" }] });
await getRun(client5, "r1");
check("getRun never calls insert/update/delete", !client5._calledMethods.some(([m]) => ["insert","update","delete"].includes(m)));

// Confirm NO domain file exports any create/insert/write-sounding function for the
// six tables that have no INSERT policy yet -- this is a static source scan, not
// a runtime call, to catch a write path being added accidentally.
import { readFileSync, readdirSync } from "fs";
const noWritePathFiles = ["entitlements.js", "runs.js", "usageEvents.js", "approvals.js", "payouts.js"];
let leaked = [];
for (const f of noWritePathFiles) {
  const src = readFileSync(`./lib/domain/${f}`, "utf8");
  if (/\.(insert|update|upsert|delete)\s*\(/.test(src)) leaked.push(f);
}
check("no .insert/.update/.upsert/.delete call exists anywhere in the six no-write-policy domain files", leaked.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
