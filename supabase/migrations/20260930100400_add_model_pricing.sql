-- Migration: add_model_pricing   (Phase 4 / Milestone 4.2, part 1 of 3)
--
-- Provider price list for the demo worker. Prices are DATA, not code: swapping a
-- model, repricing or changing the FX rate is a one-row UPDATE, and every consumer
-- (config assertion, context RPC, cost function) reads this table.
--
-- MODELS (Anthropic only; verified against Anthropic's deprecation page on 2026-10-03):
--   claude-3-7-sonnet-20250219 and claude-3-5-haiku-20241022 were RETIRED on
--   2026-02-19 -- requests to them fail -- so they are NOT seeded.
--   claude-haiku-4-5-20251001  economy       $1 / $5   per MTok   (demo default)
--   claude-sonnet-4-6          intelligence  $3 / $15  per MTok   (opt-in per demo)
--   !! USD prices come from third-party summaries of Anthropic's pricing; Anthropic's own
--   !! pricing page could not be opened when this was written. VERIFY before activating.
--   Haiku 4.5's earliest possible retirement is 2026-10-15 (no notice posted yet):
--   when that changes, add the replacement row and set is_active = false on this one.
--
-- INR rate = USD price * fx_inr_per_usd * (1 + safety_margin), stored to 4 decimals
-- (generated columns). Seeded: fx 86, margin 5%  ->  Haiku 90.30 / 451.50, Sonnet 270.90 / 1354.50.
--
-- OWNER ONLY. Nothing here is reachable through the API roles; the worker reads prices
-- through public.worker_get_step_context (next migration).

create table private.model_pricing (
  model                text primary key check (model ~ '^[a-z0-9][a-z0-9._-]{2,80}$'),
  tier                 text not null check (tier in ('economy', 'intelligence')),
  input_usd_per_mtok   numeric not null check (input_usd_per_mtok  > 0),
  output_usd_per_mtok  numeric not null check (output_usd_per_mtok > 0),
  fx_inr_per_usd       numeric not null check (fx_inr_per_usd > 0),
  safety_margin        numeric not null default 0.05 check (safety_margin >= 0 and safety_margin <= 1),
  is_active            boolean not null default true,
  is_demo_default      boolean not null default false,
  priced_on            date    not null default current_date,
  source_note          text,
  input_inr_per_mtok   numeric generated always as
                         (round(input_usd_per_mtok  * fx_inr_per_usd * (1 + safety_margin), 4)) stored,
  output_inr_per_mtok  numeric generated always as
                         (round(output_usd_per_mtok * fx_inr_per_usd * (1 + safety_margin), 4)) stored
);
create unique index model_pricing_one_demo_default_idx on private.model_pricing (is_demo_default) where is_demo_default;

revoke all on private.model_pricing from public, anon, authenticated, service_role;

insert into private.model_pricing
  (model, tier, input_usd_per_mtok, output_usd_per_mtok, fx_inr_per_usd, safety_margin, is_active, is_demo_default, source_note)
values
  ('claude-haiku-4-5-20251001', 'economy',      1, 5,  86, 0.05, true, true,  'USD price from third-party summaries of Anthropic pricing; verify. FX 86 per product decision.'),
  ('claude-sonnet-4-6',         'intelligence', 3, 15, 86, 0.05, true, false, 'USD price from third-party summaries of Anthropic pricing; verify. FX 86 per product decision.');

-- allowlist: a model is allowed iff it has an ACTIVE row
create function private.is_model_allowed(p_model text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.model_pricing m where m.model = p_model and m.is_active);
$$;

-- Cost of one call in INR, rounded UP to 4 decimals (never under-counts).
-- Exact numeric arithmetic; the worker reproduces it in integer math (tested for equality).
create function private.model_cost_inr(p_model text, p_input_tokens bigint, p_output_tokens bigint)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_in  numeric;
  v_out numeric;
begin
  if p_input_tokens is null or p_output_tokens is null or p_input_tokens < 0 or p_output_tokens < 0 then
    raise exception using errcode = 'CM040', message = 'invalid_token_counts';
  end if;
  select m.input_inr_per_mtok, m.output_inr_per_mtok into v_in, v_out
    from private.model_pricing m where m.model = p_model and m.is_active;
  if not found then
    raise exception using errcode = 'CM041', message = 'model_not_allowed';
  end if;
  return ceil((p_input_tokens * v_in + p_output_tokens * v_out) / 1000000.0 * 10000) / 10000;
end;
$$;

revoke execute on function private.is_model_allowed(text)                from public, anon, authenticated, service_role;
revoke execute on function private.model_cost_inr(text, bigint, bigint)  from public, anon, authenticated, service_role;
