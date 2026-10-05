-- Migration: add_demo_engine   (Phase 4 / Milestone 4.2, part 2 of 3)
-- Requires 20260930100400 (model_pricing). Does not touch the existing run paths.
--
-- BUSINESS MODEL (Advaith, 2026-10-03): chatmarket sells downloadable blueprints; buyers run
-- them on their own infrastructure with their own keys (BYOK). The execution worker exists
-- ONLY as a "try before you buy" demo on the listing page: platform-paid, tightly capped.
--
-- WHAT A DEMO IS
--   * a seller-authored, admin-approved "demo config" (1-2 prompt steps, allowlisted models,
--     NO tools) stored in public.listing_demos -- NOT in listings.configuration, which is
--     publicly readable for live listings.
--   * run by any signed-in user via public.start_demo_run(listing, {"text": "..."}),
--     with no purchase/entitlement, only while the listing is live.
--
-- CAPS (each enforced at more than one layer)
--   per run      cost <= private.demo_settings.per_run_cost_cap_inr (3; table CHECK forbids > 5)
--                frozen into runs.execution_config.limits.maxCostInr, so the EXISTING
--                checkpoint_step cost check enforces it; the worker also pre-flights it.
--   steps        <= 2          (assert_demo_config + runs trigger)
--   input        <= 2000 chars (create_demo_run)
--   per user     3 demo runs / rolling 24 h (settings; serialized by an advisory lock)
--   platform     Rs 500 / Asia/Kolkata calendar day (settings). Every demo run RESERVES its
--                full cap while queued/running/waiting and then counts its real cost, so the
--                budget cannot be overshot by in-flight runs. When exhausted, new demos are
--                refused until the next IST day: this is the automatic kill switch.
--                A second, manual kill switch is the phase4_demo flag: OFF refuses new demos AND
--                makes in-flight demo steps fail closed at their next worker_get_step_context.
--
-- PROMPT SECRECY: GET /api/runs/[id] does select("*") on runs, so anything in
-- runs.execution_config reaches the run's creator. The frozen run config therefore holds only
-- structure (model, token and time caps) and NEVER prompt text; the prompts are snapshotted
-- in private.demo_run_snapshots (owner-only) and handed to the worker via
-- public.worker_get_step_context (service_role only). A trigger rejects any demo run whose
-- frozen config contains 'system', 'prompt' or 'tool'.
--
-- ERROR CODES (raised, like start_run):
--   CM030 demo_disabled  CM031 demo_not_available  CM032 invalid_demo_input
--   CM033 demo_daily_limit  CM034 demo_budget_exhausted  28000 not_authenticated
--   plus the existing CM010 execution_disabled, CM011 product_not_found, CM012, CM014.

-- ---------------------------------------------------------------------------- flag + settings
insert into private.feature_flags (name, enabled) values ('phase4_demo', false) on conflict (name) do nothing;

create function private.is_demo_enabled()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((select f.enabled from private.feature_flags f where f.name = 'phase4_demo'), false) is true;
$$;

create table private.demo_settings (
  key   text primary key,
  value numeric not null,
  constraint demo_settings_bounds check (
       (key = 'per_run_cost_cap_inr'    and value > 0 and value <= 5)
    or (key = 'global_daily_budget_inr' and value >= 0 and value <= 10000)
    or (key = 'per_user_daily_runs'     and value >= 1 and value <= 20 and value = trunc(value))
  )
);
insert into private.demo_settings (key, value) values
  ('per_run_cost_cap_inr', 3), ('global_daily_budget_inr', 500), ('per_user_daily_runs', 3);
revoke all on private.demo_settings from public, anon, authenticated, service_role;

create function private.demo_setting(p_key text)
returns numeric language plpgsql stable security definer set search_path = ''
as $$
declare v numeric;
begin
  select s.value into v from private.demo_settings s where s.key = p_key;
  if not found then
    raise exception using errcode = 'CM036', message = 'demo_setting_missing:' || coalesce(p_key, '');
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------- runs.is_demo
alter table public.runs add column is_demo boolean not null default false;
alter table public.runs add constraint runs_demo_not_sandbox check (not (is_demo and is_sandbox));
create index runs_demo_created_idx      on public.runs (created_at)          where is_demo;
create index runs_demo_user_created_idx on public.runs (user_id, created_at) where is_demo;

-- ---------------------------------------------------------------------------- demo config validation
-- Seller-authored shape (STRICT: unknown keys are rejected, which is what keeps tools out):
--   { "steps": [ { "id"?, "name"?, "model", "system", "maxOutputTokens", "timeoutSeconds"?, "retryLimit"? } ] }
create function private.assert_demo_config(p_cfg jsonb)
returns void language plpgsql stable security definer set search_path = ''
as $$
declare
  v_keys constant text[] := array['id','name','model','system','maxOutputTokens','timeoutSeconds','retryLimit'];
  v_steps jsonb; v_step jsonb; v_i integer; v_k text; v_n numeric;
begin
  if jsonb_typeof(p_cfg) is distinct from 'object' then
    raise exception using errcode = 'CM002', message = 'demo_config_invalid:config';
  end if;
  for v_k in select jsonb_object_keys(p_cfg) loop
    if v_k <> 'steps' then
      raise exception using errcode = 'CM002', message = 'demo_config_invalid:unknown_key:' || left(v_k, 40);
    end if;
  end loop;
  v_steps := p_cfg -> 'steps';
  if jsonb_typeof(v_steps) is distinct from 'array' or jsonb_array_length(v_steps) < 1 then
    raise exception using errcode = 'CM002', message = 'demo_config_invalid:steps';
  end if;
  if jsonb_array_length(v_steps) > 2 then
    raise exception using errcode = 'CM001', message = 'demo_config_exceeds_cap:steps';
  end if;

  for v_i in 0 .. jsonb_array_length(v_steps) - 1 loop
    v_step := v_steps -> v_i;
    if jsonb_typeof(v_step) is distinct from 'object' then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s]', v_i);
    end if;
    for v_k in select jsonb_object_keys(v_step) loop
      if not (v_k = any (v_keys)) then
        raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].unknown_key:%s', v_i, left(v_k, 40));
      end if;
    end loop;
    if v_step ? 'id'   and (jsonb_typeof(v_step -> 'id')   is distinct from 'string' or char_length(v_step ->> 'id')   > 64)  then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].id', v_i); end if;
    if v_step ? 'name' and (jsonb_typeof(v_step -> 'name') is distinct from 'string' or char_length(v_step ->> 'name') > 100) then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].name', v_i); end if;

    if jsonb_typeof(v_step -> 'model') is distinct from 'string' then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].model', v_i);
    end if;
    if not private.is_model_allowed(v_step ->> 'model') then
      raise exception using errcode = 'CM002', message = format('demo_config_model_not_allowed:steps[%s]', v_i);
    end if;

    if jsonb_typeof(v_step -> 'system') is distinct from 'string'
       or char_length(v_step ->> 'system') < 1 or char_length(v_step ->> 'system') > 3000 then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].system', v_i);
    end if;

    if jsonb_typeof(v_step -> 'maxOutputTokens') is distinct from 'number' then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].maxOutputTokens', v_i);
    end if;
    v_n := (v_step ->> 'maxOutputTokens')::numeric;
    if v_n <> trunc(v_n) or v_n < 1 or v_n > 1024 then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].maxOutputTokens', v_i);
    end if;

    if v_step ? 'timeoutSeconds' then
      if jsonb_typeof(v_step -> 'timeoutSeconds') is distinct from 'number' then
        raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].timeoutSeconds', v_i); end if;
      v_n := (v_step ->> 'timeoutSeconds')::numeric;
      if v_n <> trunc(v_n) or v_n < 1 or v_n > 30 then
        raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].timeoutSeconds', v_i); end if;
    end if;
    if v_step ? 'retryLimit' and (v_step -> 'retryLimit') is distinct from '0'::jsonb then
      raise exception using errcode = 'CM002', message = format('demo_config_invalid:steps[%s].retryLimit', v_i);
    end if;
  end loop;
end;
$$;

-- frozen, PROMPT-FREE run config built from a validated demo config
create function private.build_demo_run_config(p_cfg jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_steps jsonb;
  v_n     integer := jsonb_array_length(p_cfg -> 'steps');
  v_secs  integer;
begin
  select jsonb_agg(jsonb_build_object(
           'id',              coalesce(t.s ->> 'id', 'step-' || t.ord),
           'kind',            'demo_prompt',
           'model',           t.s ->> 'model',
           'maxOutputTokens', (t.s ->> 'maxOutputTokens')::integer,
           'timeoutSeconds',  coalesce((t.s ->> 'timeoutSeconds')::integer, 30),
           'retryLimit',      0) order by t.ord),
         sum(coalesce((t.s ->> 'timeoutSeconds')::integer, 30))
    into v_steps, v_secs
    from jsonb_array_elements(p_cfg -> 'steps') with ordinality as t(s, ord);
  return jsonb_build_object(
    'steps', v_steps,
    'limits', jsonb_build_object(
       'maxSteps',       v_n,
       'maxCostInr',     private.demo_setting('per_run_cost_cap_inr'),
       'timeoutSeconds', least(300, v_secs)));
end;
$$;

-- L2 for demo runs: the general ceilings still apply, plus the demo-specific ones
create function private.assert_demo_run_config(p_cfg jsonb)
returns void language plpgsql stable security definer set search_path = ''
as $$
declare
  v_cap   numeric := private.demo_setting('per_run_cost_cap_inr');
  v_steps jsonb; v_step jsonb; v_i integer; v_n numeric;
begin
  perform private.assert_execution_config_within_ceilings(p_cfg);
  v_steps := p_cfg -> 'steps';
  if jsonb_array_length(v_steps) > 2 then
    raise exception using errcode = 'CM001', message = 'demo_config_exceeds_cap:steps';
  end if;
  if (p_cfg -> 'limits' ->> 'maxCostInr')::numeric > v_cap then
    raise exception using errcode = 'CM001', message = 'demo_config_exceeds_cap:limits.maxCostInr';
  end if;
  for v_i in 0 .. jsonb_array_length(v_steps) - 1 loop
    v_step := v_steps -> v_i;
    if v_step ? 'tool' or v_step ? 'system' or v_step ? 'prompt' then
      raise exception using errcode = 'CM002', message = format('demo_run_config_invalid:steps[%s].forbidden_key', v_i);
    end if;
    if (v_step -> 'retryLimit') is distinct from '0'::jsonb then
      raise exception using errcode = 'CM002', message = format('demo_run_config_invalid:steps[%s].retryLimit', v_i);
    end if;
    if jsonb_typeof(v_step -> 'model') is distinct from 'string' or not private.is_model_allowed(v_step ->> 'model') then
      raise exception using errcode = 'CM002', message = format('demo_run_config_invalid:steps[%s].model', v_i);
    end if;
    if jsonb_typeof(v_step -> 'maxOutputTokens') is distinct from 'number' then
      raise exception using errcode = 'CM002', message = format('demo_run_config_invalid:steps[%s].maxOutputTokens', v_i);
    end if;
    v_n := (v_step ->> 'maxOutputTokens')::numeric;
    if v_n <> trunc(v_n) or v_n < 1 or v_n > 1024 then
      raise exception using errcode = 'CM002', message = format('demo_run_config_invalid:steps[%s].maxOutputTokens', v_i);
    end if;
  end loop;
end;
$$;

create function private.runs_enforce_demo_config()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.is_demo then
    perform private.assert_demo_run_config(new.execution_config);
  end if;
  return new;
end;
$$;
create trigger runs_enforce_demo_config
  before insert or update of is_demo, execution_config on public.runs
  for each row execute function private.runs_enforce_demo_config();

-- ---------------------------------------------------------------------------- listing_demos (seller-authored, private)
create table public.listing_demos (
  listing_id   uuid primary key references public.listings(id) on delete cascade,
  demo_config  jsonb not null,
  is_enabled   boolean not null default false,
  approved_at  timestamptz,
  approved_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.listing_demos enable row level security;

-- no public read: the demo prompts are the seller's IP
revoke all on public.listing_demos from public, anon, authenticated;
grant select on public.listing_demos to authenticated;
grant insert (listing_id, demo_config, is_enabled) on public.listing_demos to authenticated;
grant update (demo_config, is_enabled)             on public.listing_demos to authenticated;

create policy "Sellers can read their own demo"   on public.listing_demos for select to authenticated
  using (exists (select 1 from public.listings l where l.id = listing_demos.listing_id and l.seller_id = (select auth.uid())));
create policy "Sellers can create their own demo" on public.listing_demos for insert to authenticated
  with check (exists (select 1 from public.listings l where l.id = listing_demos.listing_id and l.seller_id = (select auth.uid())));
create policy "Sellers can edit their own demo"   on public.listing_demos for update to authenticated
  using      (exists (select 1 from public.listings l where l.id = listing_demos.listing_id and l.seller_id = (select auth.uid())))
  with check (exists (select 1 from public.listings l where l.id = listing_demos.listing_id and l.seller_id = (select auth.uid())));
create policy "Admins can read all demos"         on public.listing_demos for select to authenticated
  using ((select private.is_admin()));

-- validate on every write; any config change withdraws the approval
create function private.listing_demos_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_demo_config(new.demo_config);
  if tg_op = 'INSERT' then
    new.approved_at := null; new.approved_by := null;
  elsif new.demo_config is distinct from old.demo_config then
    new.approved_at := null; new.approved_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger listing_demos_before_write
  before insert or update on public.listing_demos
  for each row execute function private.listing_demos_before_write();

-- approval: admin + MFA only (the sellers' column grants cannot touch approved_*)
create function public.set_listing_demo_approval(p_listing_id uuid, p_approved boolean)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare v_demo public.listing_demos%rowtype;
begin
  if not private.is_admin_mfa() then
    raise exception using errcode = '42501', message = 'admin_required';
  end if;
  select d.* into v_demo from public.listing_demos d where d.listing_id = p_listing_id for update;
  if not found then
    raise exception using errcode = 'CM031', message = 'demo_not_available';
  end if;
  if coalesce(p_approved, false) then
    if not v_demo.is_enabled then
      raise exception using errcode = 'CM031', message = 'demo_not_available';
    end if;
    perform private.assert_demo_config(v_demo.demo_config);
    update public.listing_demos d set approved_at = now(), approved_by = auth.uid() where d.listing_id = p_listing_id;
  else
    update public.listing_demos d set approved_at = null, approved_by = null where d.listing_id = p_listing_id;
  end if;
end;
$$;
revoke execute on function public.set_listing_demo_approval(uuid, boolean) from public, anon;
grant  execute on function public.set_listing_demo_approval(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------- prompt snapshots (owner-only)
create table private.demo_run_snapshots (
  run_id      uuid primary key references public.runs(id) on delete cascade,
  demo_config jsonb not null,
  created_at  timestamptz not null default now()
);
revoke all on private.demo_run_snapshots from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------- create_demo_run
create function private.create_demo_run(p_user_id uuid, p_listing_id uuid, p_input jsonb)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_listing   public.listings%rowtype;
  v_demo      public.listing_demos%rowtype;
  v_text      text;
  v_cap       numeric;
  v_budget    numeric;
  v_user_max  numeric;
  v_day_start timestamptz;
  v_committed numeric;
  v_recent    integer;
  v_run_id    uuid;
  v_cfg       jsonb;
begin
  if p_user_id is null then
    raise exception using errcode = '28000', message = 'not_authenticated';
  end if;
  if not private.is_execution_enabled() then
    raise exception using errcode = 'CM010', message = 'execution_disabled';
  end if;
  if not private.is_demo_enabled() then
    raise exception using errcode = 'CM030', message = 'demo_disabled';
  end if;

  -- input: exactly {"text": "<1..2000 chars>"}
  if jsonb_typeof(p_input) is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_input)) <> 1
     or jsonb_typeof(p_input -> 'text') is distinct from 'string' then
    raise exception using errcode = 'CM032', message = 'invalid_demo_input';
  end if;
  v_text := p_input ->> 'text';
  if v_text ~ '^[[:space:]]*$' or char_length(v_text) > 2000 then      -- blank = only whitespace (incl. newlines)
    raise exception using errcode = 'CM032', message = 'invalid_demo_input';
  end if;

  select l.* into v_listing from public.listings l where l.id = p_listing_id;
  if not found then
    raise exception using errcode = 'CM011', message = 'product_not_found';
  end if;
  if v_listing.product_type not in ('workflow', 'agent') then
    raise exception using errcode = 'CM012', message = 'product_not_executable';
  end if;
  if v_listing.status <> 'live' then
    raise exception using errcode = 'CM014', message = 'product_not_live';
  end if;

  select d.* into v_demo from public.listing_demos d where d.listing_id = p_listing_id;
  if not found or not v_demo.is_enabled or v_demo.approved_at is null then
    raise exception using errcode = 'CM031', message = 'demo_not_available';
  end if;
  begin
    perform private.assert_demo_config(v_demo.demo_config);      -- e.g. a model deactivated since approval
  exception when sqlstate 'CM001' or sqlstate 'CM002' then
    raise exception using errcode = 'CM031', message = 'demo_not_available';
  end;

  -- serialize: platform budget first, then this user's quota (always in this order)
  perform pg_advisory_xact_lock(hashtextextended('chatmarket:demo_budget', 0));
  perform pg_advisory_xact_lock(hashtextextended('chatmarket:demo_quota:' || p_user_id::text, 0));

  v_cap      := private.demo_setting('per_run_cost_cap_inr');
  v_budget   := private.demo_setting('global_daily_budget_inr');
  v_user_max := private.demo_setting('per_user_daily_runs');

  select count(*) into v_recent from public.runs r
   where r.is_demo and r.user_id = p_user_id and r.created_at > now() - interval '24 hours';
  if v_recent >= v_user_max then
    raise exception using errcode = 'CM033', message = 'demo_daily_limit';
  end if;

  -- platform budget for the current IST calendar day: in-flight runs reserve their full cap
  v_day_start := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  select coalesce(sum(case when r.status in ('queued', 'running', 'waiting_for_approval')
                           then (r.execution_config -> 'limits' ->> 'maxCostInr')::numeric
                           else r.cost end), 0)
    into v_committed
    from public.runs r where r.is_demo and r.created_at >= v_day_start;
  if v_committed + v_cap > v_budget then
    raise exception using errcode = 'CM034', message = 'demo_budget_exhausted';
  end if;

  v_cfg := private.build_demo_run_config(v_demo.demo_config);
  insert into public.runs (user_id, product_id, product_version, is_demo, input, execution_config)
  values (p_user_id, p_listing_id, v_listing.version, true, jsonb_build_object('text', v_text), v_cfg)
  returning id into v_run_id;                                     -- L2 + demo L2 triggers fire here

  insert into private.demo_run_snapshots (run_id, demo_config) values (v_run_id, v_demo.demo_config);
  insert into public.run_steps (run_id, step_index, status) values (v_run_id, 0, 'pending');
  return v_run_id;
end;
$$;

create function public.start_demo_run(p_listing_id uuid, p_input jsonb default '{}'::jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'not_authenticated';
  end if;
  return private.create_demo_run(auth.uid(), p_listing_id, p_input);
end;
$$;
revoke execute on function public.start_demo_run(uuid, jsonb) from public, anon, service_role;
grant  execute on function public.start_demo_run(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------- worker step context
-- Everything the worker needs to execute ONE claimed step. Fenced like checkpoint: the step must be
-- the caller's currently running step at the retry_count it claimed with. Non-demo runs get
-- mode 'stub' (the worker keeps its stub behaviour for them); only demo runs reach the provider.
create function private.get_step_context(p_run_id uuid, p_step_id uuid, p_expected_retry_count integer)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_run    public.runs%rowtype;
  v_step   public.run_steps%rowtype;
  v_cfg    jsonb;
  v_model  text;
  v_system text;
  v_prev   text;
  v_in     numeric;
  v_out    numeric;
begin
  select r.* into v_run from public.runs r where r.id = p_run_id;
  if not found then return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_found'); end if;
  select s.* into v_step from public.run_steps s where s.id = p_step_id and s.run_id = p_run_id;
  if not found then return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_found'); end if;
  if v_run.status <> 'running'  then return jsonb_build_object('outcome', 'rejected', 'reason', 'run_not_running');  end if;
  if v_step.status <> 'running' then return jsonb_build_object('outcome', 'rejected', 'reason', 'step_not_running'); end if;
  if v_step.retry_count is distinct from p_expected_retry_count then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'fencing_mismatch');
  end if;

  if not v_run.is_demo then
    return jsonb_build_object('outcome', 'ok', 'mode', 'stub');
  end if;

  -- kill switch: switching phase4_demo OFF stops in-flight demo steps at their next context fetch
  if not private.is_demo_enabled() then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'demo_disabled');
  end if;

  v_cfg   := v_run.execution_config -> 'steps' -> v_step.step_index;
  v_model := v_cfg ->> 'model';
  select m.input_inr_per_mtok, m.output_inr_per_mtok into v_in, v_out
    from private.model_pricing m where m.model = v_model and m.is_active;
  if not found then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'model_not_allowed');
  end if;
  select sn.demo_config -> 'steps' -> v_step.step_index ->> 'system' into v_system
    from private.demo_run_snapshots sn where sn.run_id = p_run_id;
  if v_system is null then
    return jsonb_build_object('outcome', 'rejected', 'reason', 'snapshot_missing');
  end if;
  if v_step.step_index > 0 then
    select s.output ->> 'text' into v_prev from public.run_steps s
     where s.run_id = p_run_id and s.step_index = v_step.step_index - 1 and s.status = 'succeeded';
  end if;

  return jsonb_build_object(
    'outcome',            'ok',
    'mode',               'demo',
    'model',              v_model,
    'system',             v_system,
    'input_text',         v_run.input ->> 'text',
    'previous_output_text', v_prev,
    'max_output_tokens',  (v_cfg ->> 'maxOutputTokens')::integer,
    'timeout_seconds',    (v_cfg ->> 'timeoutSeconds')::integer,
    'budget_remaining_inr', greatest(0, (v_run.execution_config -> 'limits' ->> 'maxCostInr')::numeric - v_run.cost),
    'price', jsonb_build_object('input_inr_per_mtok', v_in, 'output_inr_per_mtok', v_out)
  );
end;
$$;

create function public.worker_get_step_context(p_run_id uuid, p_step_id uuid, p_expected_retry_count integer)
returns jsonb language sql stable security definer set search_path = ''
as $$ select private.get_step_context(p_run_id, p_step_id, p_expected_retry_count); $$;
revoke execute on function public.worker_get_step_context(uuid, uuid, integer) from public, anon, authenticated;
grant  execute on function public.worker_get_step_context(uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------- privileges (owner only)
revoke execute on function private.is_demo_enabled()                          from public, anon, authenticated, service_role;
revoke execute on function private.demo_setting(text)                         from public, anon, authenticated, service_role;
revoke execute on function private.assert_demo_config(jsonb)                  from public, anon, authenticated, service_role;
revoke execute on function private.build_demo_run_config(jsonb)               from public, anon, authenticated, service_role;
revoke execute on function private.assert_demo_run_config(jsonb)              from public, anon, authenticated, service_role;
revoke execute on function private.runs_enforce_demo_config()                 from public, anon, authenticated, service_role;
revoke execute on function private.listing_demos_before_write()               from public, anon, authenticated, service_role;
revoke execute on function private.create_demo_run(uuid, uuid, jsonb)         from public, anon, authenticated, service_role;
revoke execute on function private.get_step_context(uuid, uuid, integer)      from public, anon, authenticated, service_role;
