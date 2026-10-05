// Stand-in for `npm:@supabase/supabase-js@2` (mapped in deno.json). It behaves
// like PostgREST's /rpc endpoint closely enough to catch CONTRACT bugs:
//
//  * arguments go through a JSON round-trip, so `undefined` values vanish
//    exactly as they do over the wire (this is how the camelCase bug hid);
//  * the argument NAMES must equal the function's real signature, and each
//    value must match its declared Postgres type -- otherwise the call fails
//    like PostgREST does (PGRST202 / 22P02) and a violation is recorded;
//  * signatures come from fixtures/rpc-payloads.json, which is generated from
//    the live database (gen-fixtures.mjs), never hand-written.

type Sig = { name: string; type: string };
type CostVector = { model: string; input_tokens: number; output_tokens: number; input_inr_per_mtok: number; output_inr_per_mtok: number; cost_inr: number };
type Fixtures = { payloads: Record<string, Record<string, unknown>>; signatures: Record<string, Sig[]>; cost_vectors: CostVector[] };

export const fixtures: Fixtures = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/rpc-payloads.json", import.meta.url)),
);

export type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
export type Responder = (wireArgs: Record<string, unknown>) => RpcResult;

export const control = {
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  violations: [] as string[],
  script: {} as Record<string, Responder>, // reset() installs the default stub context
  clientArgs: [] as { url: string; key: string }[],
  reset() {
    this.calls = [];
    this.violations = [];
    // default: every step is a non-demo (stub) step, as before Milestone 4.2
    this.script = { worker_get_step_context: () => ({ data: fixtures.payloads.ctx_stub, error: null }) };
    this.clientArgs = [];
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case "uuid": return typeof v === "string" && UUID.test(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "numeric": return typeof v === "number" && Number.isFinite(v);
    case "text": return typeof v === "string";
    case "jsonb": return v !== undefined; // any JSON value (null included) is valid jsonb
    default: return false; // unknown type in signature -> fail loudly
  }
}

export function createClient(url: string, key: string) {
  control.clientArgs.push({ url, key });
  return {
    rpc(fn: string, args?: Record<string, unknown>): Promise<RpcResult> {
      const wire = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>; // drops undefined
      control.calls.push({ fn, args: wire });

      const sig = fixtures.signatures[fn];
      if (!sig) {
        control.violations.push(`unknown function ${fn}`);
        return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } });
      }
      const expected = sig.map((s) => s.name).sort().join(",");
      const got = Object.keys(wire).sort().join(",");
      if (expected !== got) {
        control.violations.push(`${fn}: argument names [${got}] != signature [${expected}]`);
        return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}(${got}) in the schema cache` } });
      }
      for (const s of sig) {
        if (!typeOk(s.type, wire[s.name])) {
          control.violations.push(`${fn}: ${s.name} = ${JSON.stringify(wire[s.name])} is not a valid ${s.type}`);
          return Promise.resolve({ data: null, error: { code: "22P02", message: `invalid input for ${s.name}` } });
        }
      }
      const responder = control.script[fn];
      if (!responder) {
        control.violations.push(`unscripted rpc ${fn}`);
        return Promise.resolve({ data: null, error: { message: `unscripted rpc ${fn}` } });
      }
      return Promise.resolve(responder(wire));
    },
  };
}
