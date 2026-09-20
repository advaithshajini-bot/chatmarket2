// Prints the JS system ceilings as JSON so the DB test (test 41) can compare
// them with private.system_ceilings().
import { SYSTEM_CEILINGS } from "../../lib/execution/ceilings.js";
console.log(JSON.stringify(SYSTEM_CEILINGS));
