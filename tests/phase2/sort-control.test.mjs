import { sortProducts } from "../../lib/sort-products.js";

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }

const products = [
  { id: "a", price: 500, rating: 4.2, reviewCount: 3, createdAt: "2026-01-01" },
  { id: "b", price: 100, rating: 4.9, reviewCount: 20, createdAt: "2026-03-01" },
  { id: "c", price: 900, rating: 3.5, reviewCount: 1, createdAt: "2026-02-01" },
];

check("popular sorts by reviewCount desc", sortProducts(products, "popular").map((p) => p.id).join("") === "bac");
check("newest sorts by createdAt desc", sortProducts(products, "newest").map((p) => p.id).join("") === "bca");
check("price_low sorts ascending", sortProducts(products, "price_low").map((p) => p.id).join("") === "bac");
check("price_high sorts descending", sortProducts(products, "price_high").map((p) => p.id).join("") === "cab");
check("rating sorts descending", sortProducts(products, "rating").map((p) => p.id).join("") === "bac");
check("relevance/unknown sort leaves order unchanged", sortProducts(products, "relevance").map((p) => p.id).join("") === "abc");
check("sortProducts does not mutate the original array", products.map((p) => p.id).join("") === "abc" && (sortProducts(products, "popular"), products.map((p) => p.id).join("") === "abc"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
