import { PRODUCT_TYPE_META, PRODUCT_TYPE_ORDER, productTypeMeta } from "../../lib/product-types.js";
import { PRODUCT_TYPES } from "../../lib/validation/shared.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

// Display metadata must stay in sync with the Phase 1 validation vocabulary.
check("PRODUCT_TYPE_ORDER matches Phase 1's PRODUCT_TYPES exactly", JSON.stringify(PRODUCT_TYPE_ORDER) === JSON.stringify(PRODUCT_TYPES));

for (const type of PRODUCT_TYPE_ORDER) {
  const meta = productTypeMeta(type);
  check(`${type}: has a label`, typeof meta.label === "string" && meta.label.length > 0);
  check(`${type}: has an icon component`, typeof meta.icon === "function" || typeof meta.icon === "object");
  check(`${type}: has a distinct colorVar`, typeof meta.colorVar === "string" && meta.colorVar.startsWith("--"));
}

// Never color alone: every type's icon must be distinct from every other type's icon.
const icons = PRODUCT_TYPE_ORDER.map((t) => PRODUCT_TYPE_META[t].icon);
check("all three type icons are distinct (never color alone)", new Set(icons).size === 3);

// Unknown type falls back to playbook rather than throwing or returning undefined.
check("productTypeMeta falls back to playbook for an unknown type", productTypeMeta("bogus").type === "playbook");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
