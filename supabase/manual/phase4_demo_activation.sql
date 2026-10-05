-- MANUAL, NOT A MIGRATION. Phase 4 / Milestone 4.2 activation reference (the "try before you buy" demo).
-- Nothing in the repository turns phase4_demo on. Run by hand, in order. Tested only against a scratch
-- Postgres; nothing here has been run on your Supabase project.

-- 0. PRECONDITIONS ---------------------------------------------------------------------------------
--   * migrations 20260930100400, 100500, 100600 applied and ledger-verified
--   * `node tests/phase4/run-all.mjs` green on a scratch DB; the Phase 3 gate still green
--   * VERIFY the USD prices below against Anthropic's own pricing page (I could not open it):
select model, tier, input_usd_per_mtok, output_usd_per_mtok, fx_inr_per_usd, safety_margin,
       input_inr_per_mtok, output_inr_per_mtok, is_active, is_demo_default, priced_on
  from private.model_pricing order by model;
--   * if a price or the FX rate is wrong, fix it here (one row, no migration):
-- update private.model_pricing set input_usd_per_mtok = 1, output_usd_per_mtok = 5, fx_inr_per_usd = 86, priced_on = current_date
--  where model = 'claude-haiku-4-5-20251001';

-- 1. SECRETS (terminal, NOT SQL). The provider key lives only in function secrets:
--      supabase secrets set ANTHROPIC_API_KEY=<new key>  --project-ref <ref>
--    Use a DEDICATED key for the demo, with a monthly spend limit set in the Anthropic console well
--    above your daily budget but far below anything painful. The DB caps (Rs3/run, Rs500/day) are the
--    first line of defence; the console limit is the second.
--    Then redeploy the worker (it now reads ANTHROPIC_API_KEY and calls worker_get_step_context):
--      supabase functions deploy execution-worker --no-verify-jwt --project-ref <ref>
--    Check before activating: with phase3_execution OFF the logs must still show
--      "claim outcome: rejected execution_disabled"  (the new build is live and still fails closed).

-- 2. CAPS (all editable without a migration; the table CHECKs forbid going past the hard limits)
select * from private.demo_settings order by key;
-- update private.demo_settings set value = 3   where key = 'per_run_cost_cap_inr';      -- hard max 5
-- update private.demo_settings set value = 500 where key = 'global_daily_budget_inr';   -- Asia/Kolkata day, hard max 10000
-- update private.demo_settings set value = 3   where key = 'per_user_daily_runs';       -- rolling 24 h, hard max 20

-- 3. A SELLER'S DEMO (sellers do this through RLS; shown here as the owner would)
-- insert into public.listing_demos (listing_id, demo_config, is_enabled) values ('<listing uuid>',
--   '{"steps":[{"id":"s1","model":"claude-haiku-4-5-20251001","system":"<the seller''s prompt>","maxOutputTokens":400,"timeoutSeconds":20}]}', true);
--    approval needs an ADMIN with MFA (aal2), through the API, not SQL:
--      select public.set_listing_demo_approval('<listing uuid>', true);
--    ANY later change to demo_config withdraws the approval automatically.

-- 4. ACTIVATE (phase3_execution must ALSO be on: demos run through the same claim path)
update private.feature_flags set enabled = true, updated_at = now() where name = 'phase3_execution';
update private.feature_flags set enabled = true, updated_at = now() where name = 'phase4_demo';
select name, enabled from private.feature_flags order by name;
--    NOTE: with phase3_execution on and phase4_approvals off, any run of a listing whose steps declare
--    tool.permission fails closed ('approvals_disabled') -- see supabase/manual/phase4_approvals_activation.sql step 1.

-- 5. KILL SWITCHES (any one is enough; the first two take effect on the very next call)
update private.feature_flags set enabled = false, updated_at = now() where name = 'phase4_demo';
--      -> new demos refused (CM030) AND in-flight demo steps fail closed at their next context fetch
update private.demo_settings set value = 0 where key = 'global_daily_budget_inr';
--      -> new demos refused (CM034); in-flight runs finish within their Rs3 cap
-- Automatic: when today's committed spend + one more run's cap would exceed the budget, CM034 is returned
-- until the next Asia/Kolkata day. Rotating/revoking ANTHROPIC_API_KEY stops spend even if the DB were wrong.

-- 6. WATCH IT
select date_trunc('day', created_at at time zone 'Asia/Kolkata') as ist_day,
       count(*) as runs, sum(cost) as spent_inr,
       sum(case when status = 'failed' then 1 else 0 end) as failed
  from public.runs where is_demo and created_at > now() - interval '7 days' group by 1 order by 1 desc;
select error, count(*) from public.runs where is_demo and status = 'failed' and created_at > now() - interval '24 hours' group by 1 order by 2 desc;
--   provider_http_401 / provider_unconfigured -> key problem;  provider_http_429/529 -> provider overloaded;
--   preflight_budget_exceeded -> a seller's prompt+input is too big for the cap (shorten it or use Haiku)
select u.email, count(*) from public.runs r join auth.users u on u.id = r.user_id
 where r.is_demo and r.created_at > now() - interval '24 hours' group by 1 order by 2 desc limit 20;   -- heaviest users

-- 7. WHEN HAIKU 4.5 (OR ANY SEEDED MODEL) IS DEPRECATED
-- insert into private.model_pricing (model, tier, input_usd_per_mtok, output_usd_per_mtok, fx_inr_per_usd, is_active, is_demo_default)
--   values ('<replacement-id>', 'economy', <usd_in>, <usd_out>, 86, true, false);
-- update private.model_pricing set is_demo_default = false, is_active = false where model = 'claude-haiku-4-5-20251001';
-- update private.model_pricing set is_demo_default = true where model = '<replacement-id>';
--   Demos whose config still names the old model become 'not available' (CM031) until the seller edits and an
--   admin re-approves: fail closed, never a runtime surprise.
