-- Migration: add_system_ceilings_and_config_assertion
--
-- Chatmarket 2.0 Phase 3.1 (architecture v9 §1 / v10: Correction A).
--
-- POLICY: REJECT, NEVER CLAMP. A configuration that exceeds any system
-- ceiling is rejected; no code path replaces a product-declared value with
-- a system value. A value equal to a ceiling is valid. A more restrictive
-- product value is valid and effective exactly as declared.
--
-- This migration adds two pure functions (no tables, no data):
--   * private.system_ceilings()  -- the ceiling constants (D-3 choice: SQL
--     constants, mirrored by lib/execution/ceilings.js; parity is tested).
--     Not stored in any table, so no product/seller/admin write path can
--     change a ceiling; changing one requires a reviewed migration plus the
--     mirrored JS change.
--   * private.assert_execution_config_within_ceilings(jsonb) -- the L2
--     assertion, also reused by the L3 runtime checks. Raises with a
--     machine-readable message prefix:
--         SQLSTATE CM001  config_exceeds_system_ceiling:<field>
--         SQLSTATE CM002  config_invalid_for_execution:<field>
--     CM002 covers missing / wrongly-typed frozen fields: fail closed rather
--     than guess. (The frozen configuration is the post-Zod parse, so every
--     field checked here is always present in a valid one.)
--
-- Both functions are SECURITY INVOKER with an empty search_path: they read
-- no tables and grant no privilege. They are reached only from SECURITY
-- DEFINER functions (owner context). EXECUTE is not available to any client
-- role, nor to service_role.

create function private.system_ceilings()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'maxRetriesPerStep',         1,
    'maxStepTimeoutSeconds',     90,
    'maxStepsPerRun',            10,
    'maxCostInrPerRun',          50,
    'maxRunActiveSeconds',       300,
    'maxStepOutputBytes',        51200,   -- 50 KiB
    'maxRunOutputBytes',         204800,  -- 200 KiB
    'maxRunsPerUserPerDay',      20,
    'staleStepThresholdSeconds', 120      -- must stay > 90 and < 150 (v8 §4)
  );
$$;

create function private.assert_execution_config_within_ceilings(p_cfg jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  c          jsonb := private.system_ceilings();
  v_steps    jsonb;
  v_limits   jsonb;
  v_step     jsonb;
  v_n        integer;
  v_i        integer;
  v_max      numeric;
  v_num      numeric;
begin
  if p_cfg is null or jsonb_typeof(p_cfg) is distinct from 'object' then
    raise exception using errcode = 'CM002',
      message = 'config_invalid_for_execution:execution_config';
  end if;

  v_steps := p_cfg -> 'steps';
  if jsonb_typeof(v_steps) is distinct from 'array' then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:steps';
  end if;
  v_n := jsonb_array_length(v_steps);
  if v_n < 1 then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:steps';
  end if;

  v_limits := p_cfg -> 'limits';
  if jsonb_typeof(v_limits) is distinct from 'object' then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits';
  end if;

  -- limits.maxSteps ---------------------------------------------------------
  if jsonb_typeof(v_limits -> 'maxSteps') is distinct from 'number' then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.maxSteps';
  end if;
  v_max := (v_limits ->> 'maxSteps')::numeric;
  if v_max <> trunc(v_max) or v_max < 1 then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.maxSteps';
  end if;
  if v_max > (c ->> 'maxStepsPerRun')::numeric then
    raise exception using errcode = 'CM001',
      message = 'config_exceeds_system_ceiling:limits.maxSteps',
      detail  = format('value=%s ceiling=%s', v_max, c ->> 'maxStepsPerRun');
  end if;
  if v_n > (c ->> 'maxStepsPerRun')::numeric then
    raise exception using errcode = 'CM001',
      message = 'config_exceeds_system_ceiling:steps.length',
      detail  = format('value=%s ceiling=%s', v_n, c ->> 'maxStepsPerRun');
  end if;
  -- A plan longer than its own declared limit is inconsistent. It is
  -- rejected, never truncated (truncating a deterministic plan would
  -- silently skip its later steps).
  if v_n > v_max then
    raise exception using errcode = 'CM001',
      message = 'config_exceeds_system_ceiling:steps.length>limits.maxSteps',
      detail  = format('steps=%s maxSteps=%s', v_n, v_max);
  end if;

  -- limits.maxCostInr -------------------------------------------------------
  if jsonb_typeof(v_limits -> 'maxCostInr') is distinct from 'number' then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.maxCostInr';
  end if;
  v_num := (v_limits ->> 'maxCostInr')::numeric;
  if v_num <= 0 then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.maxCostInr';
  end if;
  if v_num > (c ->> 'maxCostInrPerRun')::numeric then
    raise exception using errcode = 'CM001',
      message = 'config_exceeds_system_ceiling:limits.maxCostInr',
      detail  = format('value=%s ceiling=%s', v_num, c ->> 'maxCostInrPerRun');
  end if;

  -- limits.timeoutSeconds (active-processing budget) ------------------------
  if jsonb_typeof(v_limits -> 'timeoutSeconds') is distinct from 'number' then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.timeoutSeconds';
  end if;
  v_num := (v_limits ->> 'timeoutSeconds')::numeric;
  if v_num <> trunc(v_num) or v_num < 1 then
    raise exception using errcode = 'CM002', message = 'config_invalid_for_execution:limits.timeoutSeconds';
  end if;
  if v_num > (c ->> 'maxRunActiveSeconds')::numeric then
    raise exception using errcode = 'CM001',
      message = 'config_exceeds_system_ceiling:limits.timeoutSeconds',
      detail  = format('value=%s ceiling=%s', v_num, c ->> 'maxRunActiveSeconds');
  end if;

  -- steps[] -----------------------------------------------------------------
  for v_i in 0 .. v_n - 1 loop
    v_step := v_steps -> v_i;
    if jsonb_typeof(v_step) is distinct from 'object' then
      raise exception using errcode = 'CM002',
        message = format('config_invalid_for_execution:steps[%s]', v_i);
    end if;

    -- retryLimit
    if jsonb_typeof(v_step -> 'retryLimit') is distinct from 'number' then
      raise exception using errcode = 'CM002',
        message = format('config_invalid_for_execution:steps[%s].retryLimit', v_i);
    end if;
    v_num := (v_step ->> 'retryLimit')::numeric;
    if v_num <> trunc(v_num) or v_num < 0 then
      raise exception using errcode = 'CM002',
        message = format('config_invalid_for_execution:steps[%s].retryLimit', v_i);
    end if;
    if v_num > (c ->> 'maxRetriesPerStep')::numeric then
      raise exception using errcode = 'CM001',
        message = format('config_exceeds_system_ceiling:steps[%s].retryLimit', v_i),
        detail  = format('value=%s ceiling=%s', v_num, c ->> 'maxRetriesPerStep');
    end if;

    -- timeoutSeconds (per invocation)
    if jsonb_typeof(v_step -> 'timeoutSeconds') is distinct from 'number' then
      raise exception using errcode = 'CM002',
        message = format('config_invalid_for_execution:steps[%s].timeoutSeconds', v_i);
    end if;
    v_num := (v_step ->> 'timeoutSeconds')::numeric;
    if v_num <> trunc(v_num) or v_num < 1 then
      raise exception using errcode = 'CM002',
        message = format('config_invalid_for_execution:steps[%s].timeoutSeconds', v_i);
    end if;
    if v_num > (c ->> 'maxStepTimeoutSeconds')::numeric then
      raise exception using errcode = 'CM001',
        message = format('config_exceeds_system_ceiling:steps[%s].timeoutSeconds', v_i),
        detail  = format('value=%s ceiling=%s', v_num, c ->> 'maxStepTimeoutSeconds');
    end if;
  end loop;
end;
$$;

revoke execute on function private.system_ceilings()
  from public, anon, authenticated, service_role;
revoke execute on function private.assert_execution_config_within_ceilings(jsonb)
  from public, anon, authenticated, service_role;
