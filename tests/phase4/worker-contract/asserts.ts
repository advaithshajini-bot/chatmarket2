// Tiny local assertion helpers so the suite has ZERO remote imports
// (no jsr.io / deno.land fetch -> works offline and behind firewalls).
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return v === undefined ? "undefined" : JSON.stringify(v);
}
export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
export function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = stable(actual), e = stable(expected);
  if (a !== e) throw new Error(`${msg ?? "not equal"}\n  actual:   ${a}\n  expected: ${e}`);
}
export function assertStringIncludes(actual: string, needle: string) {
  if (!actual.includes(needle)) throw new Error(`expected "${actual}" to include "${needle}"`);
}
