-- Migration: add_can_view_run_helper_function
--
-- Single source of truth for "can this caller see this run" (buyer who
-- ran it, creator who owns the product, or admin), reused by every run-
-- child table (run_steps, usage_events, approvals) instead of each
-- duplicating a 3-way OR against `runs` + `owns_product` + `is_admin`.
-- SECURITY DEFINER so it can read `runs` regardless of the caller's own
-- RLS visibility into that table (mirrors the owns_listing/owns_product
-- pattern already used to sidestep recursion elsewhere in this schema).
create function private.can_view_run(check_run_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.runs r
    where r.id = check_run_id
      and (
        r.user_id = (select auth.uid())
        or private.owns_product(r.product_id)
        or private.is_admin()
      )
  );
$$;

revoke execute on function private.can_view_run(uuid) from public, anon, authenticated;
grant execute on function private.can_view_run(uuid) to authenticated;
