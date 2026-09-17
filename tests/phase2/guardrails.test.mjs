// Static source scans guarding the Phase 2 guardrails that a runtime test
// can't easily cover without a browser: "no execution," "admin nav link
// gated on isAdmin," and "config always validated server-side before
// insert." These are regression guards -- if a future edit accidentally
// removes the gating/validation call, this test catches it.

import { readFileSync } from "fs";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

const workflowAgentDetail = readFileSync("./components/WorkflowAgentDetail.jsx", "utf8");
check(
  "WorkflowAgentDetail has no execute/run action (no fetch call, no onClick run handler)",
  !/fetch\(.*(run|execute)/i.test(workflowAgentDetail) && !/onRun|onExecute|handleRun|handleExecute/.test(workflowAgentDetail)
);

const createRoute = readFileSync("./app/api/listings/create-workflow-agent/route.js", "utf8");
check(
  "create-workflow-agent route calls validateProductConfiguration before the insert",
  (() => {
    const validateIdx = createRoute.indexOf("validateProductConfiguration(");
    const insertIdx = createRoute.indexOf(".insert(");
    return validateIdx !== -1 && insertIdx !== -1 && validateIdx < insertIdx;
  })()
);
check(
  "create-workflow-agent route rejects on validation.success === false before inserting",
  /validation\.success/.test(createRoute) && createRoute.indexOf("!validation.success") < createRoute.indexOf(".insert(")
);
check(
  "create-workflow-agent route checks KYC approval before accepting a submission",
  /kyc\?\.status !== ["']approved["']/.test(createRoute)
);

const topNav = readFileSync("./components/TopNav.jsx", "utf8");
check(
  "TopNav gates the Admin link behind user?.isAdmin",
  /user\?\.isAdmin[\s\S]{0,80}href=["']\/admin["']/.test(topNav)
);

const mobileTabBar = readFileSync("./components/MobileTabBar.jsx", "utf8");
check(
  "MobileTabBar gates the Admin link behind user.isAdmin",
  /user\.isAdmin[\s\S]{0,120}href=["']\/admin["']/.test(mobileTabBar)
);

const useAuthUser = readFileSync("./lib/supabase/use-auth-user.js", "utf8");
check(
  "useAuthUser reads profiles.is_admin (not just user_metadata) for the isAdmin flag",
  /\.select\(["']is_admin["']\)/.test(useAuthUser) && /isAdmin:/.test(useAuthUser)
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
