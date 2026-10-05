-- Migration: add_demo_ui_support   (Phase 4 / Milestone 4.3)
-- Requires 20260930100400..100600. Two changes the demo UI needs:
--
-- 1) public.listing_demo_info(listing)  -- the PUBLIC "can this listing be tried?" answer.
--    listing_demos is private (the demo prompts are the seller's IP), so the listing page cannot read it.
--    This SECURITY DEFINER function returns only what the page needs to draw the widget:
--       {available, stepNames, maxInputChars, runsPerDay, remainingToday, budgetExhausted}
--    It never returns prompts, models, prices or caps in rupees. 'available' is true only when the demo
--    could actually be started right now (both flags on, listing live, demo enabled + approved + valid).
--    Anything unexpected -> {available:false} (fail closed, never an error to a public caller).
--    remainingToday is NULL for anonymous callers. budgetExhausted uses the same committed-spend maths
--    as private.create_demo_run (a test asserts the two agree).
--
-- 2) PRIVACY FIX for demo runs. The existing run policies let the SELLER of a product read every run of
--    that product ("Creators can view runs of their own products", and private.can_view_run for
--    run_steps / approvals). For ordinary runs that is intended. For DEMO runs it would hand a
--    prospective buyer's typed input and the model's answer to the seller -- a privacy leak introduced by
--    my 4.2 design, closed here. After this migration a demo run is visible to: the user who ran it and
--    admins (kept for abuse investigation; the UI says so). Non-demo behaviour is unchanged.

create function private.demo_budget_has_room()
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_cap       numeric := private.demo_setting('per_run_cost_cap_inr');
  v_budget    numeric := private.demo_setting('global_daily_budget_inr');
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_committed numeric;
begin
  select coalesce(sum(case when r.status in ('queued', 'running', 'waiting_for_approval')
                           then (r.execution_config -> 'limits' ->> 'maxCostInr')::numeric
                           else r.cost end), 0)
    into v_committed
    from public.runs r where r.is_demo and r.created_at >= v_day_start;
  return v_committed + v_cap <= v_budget;
end;
$$;

create function public.listing_demo_info(p_listing_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_unavailable constant jsonb := jsonb_build_object('available', false);
  v_listing     public.listings%rowtype;
  v_demo        public.listing_demos%rowtype;
  v_names       jsonb;
  v_user        uuid := auth.uid();
  v_max         numeric;
  v_used        integer;
  v_remaining   integer;
begin
  if not private.is_execution_enabled() or not private.is_demo_enabled() then
    return v_unavailable;
  end if;

  select l.* into v_listing from public.listings l where l.id = p_listing_id;
  if not found or v_listing.status <> 'live' or v_listing.product_type not in ('workflow', 'agent') then
    return v_unavailable;
  end if;

  select d.* into v_demo from public.listing_demos d where d.listing_id = p_listing_id;
  if not found or not v_demo.is_enabled or v_demo.approved_at is null then
    return v_unavailable;
  end if;
  perform private.assert_demo_config(v_demo.demo_config);

  select jsonb_agg(coalesce(nullif(btrim(t.s ->> 'name'), ''), 'Step ' || t.ord) order by t.ord)
    into v_names
    from jsonb_array_elements(v_demo.demo_config -> 'steps') with ordinality as t(s, ord);

  v_max := private.demo_setting('per_user_daily_runs');
  if v_user is not null then
    select count(*) into v_used from public.runs r
     where r.is_demo and r.user_id = v_user and r.created_at > now() - interval '24 hours';
    v_remaining := greatest(0, v_max::integer - v_used);
  end if;

  return jsonb_build_object(
    'available',       true,
    'stepNames',       v_names,
    'maxInputChars',   2000,
    'runsPerDay',      v_max::integer,
    'remainingToday',  v_remaining,
    'budgetExhausted', not private.demo_budget_has_room()
  );
exception when others then
  return v_unavailable;
end;
$$;

revoke execute on function private.demo_budget_has_room() from public, anon, authenticated, service_role;
revoke execute on function public.listing_demo_info(uuid) from public;
grant  execute on function public.listing_demo_info(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------- privacy fix
create or replace function private.can_view_run(check_run_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.runs r
    where r.id = check_run_id
      and (r.user_id = (select auth.uid())
           or (private.owns_product(r.product_id) and not r.is_demo)
           or private.is_admin())
  );
$$;

alter policy "Creators can view runs of their own products" on public.runs
  using ((select private.owns_product(product_id)) and not is_demo);
