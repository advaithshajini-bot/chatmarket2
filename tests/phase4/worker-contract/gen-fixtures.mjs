// Generates fixtures/rpc-payloads.json from the REAL database functions.
//
//   DATABASE_URL=... node tests/phase4/worker-contract/gen-fixtures.mjs
//
// Everything runs inside a transaction that is rolled back. It calls the same
// public.worker_* wrappers the Edge Function calls (as the owner connection),
// records (a) the exact JSON each returns per scenario and (b) each wrapper's
// argument list, so the Deno contract tests validate the worker against what
// the database really produces -- not against hand-written JSON that can drift.
// The M40-F checks in m40-dispatch-sweep.test.mjs re-run generate() and fail if
// the live shapes/signatures ever differ from the committed file.

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const UID = "00000000-0000-0000-0000-0000000fff41";
const cfg = (steps, retryLimit = 1) => ({
  steps: Array.from({ length: steps }, () => ({ retryLimit, timeoutSeconds: 30 })),
  limits: { maxSteps: steps, maxCostInr: 10, timeoutSeconds: 60 },
});

/** Must be called inside an open transaction; changes are never committed here. */
export async function generate(client) {
  const q = (s, p) => client.query(s, p);
  const one = async (s, p) => (await q(s, p)).rows[0].v;
  await q(`insert into auth.users (id, email) values ($1,'m40-fx@example.invalid') on conflict (id) do nothing`, [UID]);
  const { rows: [l] } = await q(
    `insert into public.listings (title, model, category, price, seller_name, seller_id, status)
     values ('M40 fixture','n/a','n/a',0,'fixture',$1,'pending_review') returning id`, [UID]);

  async function newRun(steps, retryLimit = 1) {
    const { rows: [r] } = await q(
      `insert into public.runs (user_id, product_id, product_version, execution_config, status)
       values ($1,$2,1,$3::jsonb,'queued') returning id`, [UID, l.id, JSON.stringify(cfg(steps, retryLimit))]);
    await q(`insert into public.run_steps (run_id, step_index, status) values ($1,0,'pending')`, [r.id]);
    return r.id;
  }
  const claim = (runId) => one(`select public.worker_claim_next_step($1) as v`, [runId]);
  const checkpoint = (runId, c, out, cost) => one(
    `select public.worker_checkpoint_step($1,$2,$3,$4::jsonb,$5) as v`, [runId, c.step_id, c.retry_count, JSON.stringify(out), cost]);
  const retry = (runId, c, err) => one(
    `select public.worker_retry_or_fail_step($1,$2,$3,$4) as v`, [runId, c.step_id, c.retry_count, err]);

  const payloads = {};
  await q(`update private.feature_flags set enabled = false where name = 'phase3_execution'`);
  payloads.claim_rejected_execution_disabled = await claim(await newRun(1));

  await q(`update private.feature_flags set enabled = true where name = 'phase3_execution'`);
  { const r = await newRun(1); payloads.claim_claimed = await claim(r);
    payloads.claim_rejected_step_already_running = await claim(r); }
  { const r = await newRun(1); const c = await claim(r);
    await checkpoint(r, c, { stub: true }, 0);
    payloads.claim_rejected_run_not_claimable = await claim(r); }
  { const r = await newRun(1); const c = await claim(r);
    payloads.checkpoint_succeeded = await checkpoint(r, c, { stub: true }, 0); }
  // Milestone 4.1: a gated step parks instead of being claimed. Needs migration 20260930100200+
  // (phase4_approvals flag); on an older DB this scenario is skipped, not faked.
  if ((await q(`select 1 from private.feature_flags where name = 'phase4_approvals'`)).rowCount) {
    await q(`update private.feature_flags set enabled = true where name = 'phase4_approvals'`);
    const cfgG = { steps: [{ retryLimit: 1, timeoutSeconds: 30, tool: { toolId: "00000000-0000-4000-8000-0000000000aa", permission: "SEND" } }],
                   limits: { maxSteps: 1, maxCostInr: 10, timeoutSeconds: 60 }, permissions: [{ permission: "SEND", requiresApproval: true }] };
    const { rows: [rg] } = await q(
      `insert into public.runs (user_id, product_id, product_version, execution_config, status)
       values ($1,$2,1,$3::jsonb,'queued') returning id`, [UID, l.id, JSON.stringify(cfgG)]);
    await q(`insert into public.run_steps (run_id, step_index, status) values ($1,0,'pending')`, [rg.id]);
    payloads.claim_waiting_for_approval = await claim(rg.id);
    await q(`update private.feature_flags set enabled = false where name = 'phase4_approvals'`);
  }
  { const r = await newRun(2); const c = await claim(r);
    payloads.checkpoint_checkpointed = await checkpoint(r, c, { stub: true }, 0); }
  { const r = await newRun(1); const c = await claim(r);
    payloads.checkpoint_failed_cost_limit = await checkpoint(r, c, { stub: true }, 9999); }
  { const r = await newRun(1); const c = await claim(r);
    payloads.checkpoint_rejected_fencing = await checkpoint(r, { ...c, retry_count: c.retry_count + 5 }, { stub: true }, 0); }
  { const r = await newRun(1, 1); const c = await claim(r);
    payloads.retry_retried = await retry(r, c, "provider_timeout"); }
  { const r = await newRun(1, 0); const c = await claim(r);
    payloads.retry_failed = await retry(r, c, "provider_timeout"); }

  // Milestone 4.2: step context for stub and demo runs + cost vectors. Skipped (not faked) on a DB without 4.2.
  if ((await q(`select to_regprocedure('public.worker_get_step_context(uuid,uuid,integer)') is not null as ok`)).rows[0].ok) {
    const ctxOf = (runId, c, retry) => one(`select public.worker_get_step_context($1,$2,$3) as v`, [runId, c.step_id, retry ?? c.retry_count]);
    { const r = await newRun(1); const c = await claim(r);
      payloads.ctx_stub = await ctxOf(r, c);
      payloads.ctx_rejected_fencing = await ctxOf(r, c, c.retry_count + 5); }
    await q(`update private.feature_flags set enabled = true where name = 'phase4_demo'`);
    const { rows: [dl] } = await q(
      `insert into public.listings (title, model, category, price, seller_name, seller_id, status, product_type)
       values ('M42 fixture','n/a','n/a',0,'fixture',$1,'live','workflow') returning id`, [UID]);
    const demoCfg = { steps: [{ id: "s1", model: "claude-haiku-4-5-20251001", system: "Fixture system prompt.", maxOutputTokens: 256, timeoutSeconds: 20 }] };
    await q(`insert into public.listing_demos (listing_id, demo_config, is_enabled) values ($1,$2::jsonb,true)`, [dl.id, JSON.stringify(demoCfg)]);
    await q(`update public.listing_demos set approved_at = now() where listing_id = $1`, [dl.id]);
    const demoRun = (await q(`select private.create_demo_run($1,$2,$3::jsonb) as v`, [UID, dl.id, JSON.stringify({ text: "Fixture input text" })])).rows[0].v;
    const dc = await claim(demoRun);
    payloads.ctx_demo = await ctxOf(demoRun, dc);
    await q(`update private.feature_flags set enabled = false where name = 'phase4_demo'`);
  }
  const costVectors = [];
  if ((await q(`select to_regproc('private.model_cost_inr') is not null as ok`)).rows[0].ok) {
    for (const m of ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]) {
      const { rows: [pr] } = await q(`select input_inr_per_mtok::float8 as i, output_inr_per_mtok::float8 as o from private.model_pricing where model = $1`, [m]);
      for (const [i, o] of [[0, 0], [1, 0], [0, 1], [1000, 500], [7, 3], [123456, 789], [200000, 1024], [999999, 999999]]) {
        const cost = Number((await q(`select private.model_cost_inr($1,$2,$3) as v`, [m, i, o])).rows[0].v);
        costVectors.push({ model: m, input_tokens: i, output_tokens: o, input_inr_per_mtok: pr.i, output_inr_per_mtok: pr.o, cost_inr: cost });
      }
    }
  }

  const sigs = (await q(
    `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('worker_claim_next_step','worker_checkpoint_step','worker_retry_or_fail_step','worker_get_step_context')
      order by 1`)).rows;
  const signatures = {};
  for (const { name, args } of sigs) {
    signatures[name] = args.split(",").map(s => s.trim()).map(s => { const [n, ...t] = s.split(" "); return { name: n, type: t.join(" ") }; });
  }
  return { payloads, signatures, cost_vectors: costVectors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  let out;
  try { out = await generate(client); } finally { await client.query("ROLLBACK"); await client.end(); }
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "rpc-payloads.json");
  fs.writeFileSync(file, JSON.stringify({ _note: "Generated from the live DB by gen-fixtures.mjs. Do not hand-edit.", ...out }, null, 2) + "\n");
  console.log("wrote", file);
  for (const [k, v] of Object.entries(out.payloads)) console.log(k.padEnd(40), JSON.stringify(v));
  console.log(JSON.stringify(out.signatures));
}
