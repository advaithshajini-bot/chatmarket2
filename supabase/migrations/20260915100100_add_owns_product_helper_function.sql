-- Migration: add_owns_product_helper_function
--
-- `listings` physically IS the Product table for now (see previous
-- migration), so this is a thin, semantically-named wrapper around the
-- existing `private.owns_listing()` -- not a duplicate implementation.
-- New Chatmarket 2.0 tables (product_tools, product_permissions, runs,
-- etc.) reference `owns_product` rather than `owns_listing` directly, so
-- that if Product ever becomes its own physical table later, only this one
-- function needs to change -- every RLS policy built on top of it does not.
--
-- SECURITY DEFINER + empty search_path + revoke-then-grant-to-authenticated,
-- matching the exact pattern already used by private.owns_listing() and
-- private.is_admin() elsewhere in this schema.
create function private.owns_product(check_product_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select private.owns_listing(check_product_id);
$$;

revoke execute on function private.owns_product(uuid) from public, anon, authenticated;
grant execute on function private.owns_product(uuid) to authenticated;
