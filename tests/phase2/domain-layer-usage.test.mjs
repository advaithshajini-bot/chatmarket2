import { readFileSync } from "fs";
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

const browsePage = readFileSync("./app/browse/page.jsx", "utf8");
check("Browse page calls listProducts() from lib/domain", /listProducts\(/.test(browsePage) && /lib\/domain\/products/.test(browsePage));
check("Browse page no longer does a raw listings select(\"*\")", !/\.from\(["']listings["']\)\s*\n?\s*\.select\(["']\*["']\)/.test(browsePage));

const homePage = readFileSync("./app/page.jsx", "utf8");
check("Homepage calls listProducts() from lib/domain", /listProducts\(/.test(homePage) && /lib\/domain\/products/.test(homePage));

const detailPage = readFileSync("./app/listing/[id]/page.jsx", "utf8");
check("Product detail page calls getProduct() from lib/domain", /getProduct\(/.test(detailPage) && /lib\/domain\/products/.test(detailPage));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
