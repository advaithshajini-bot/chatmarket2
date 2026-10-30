-- Listing quality bars + price bounds, enforced by the database for a seller creating their own listing.
--   title >= 10 characters, description >= 500, zip contents note >= 250 (playbooks only), price between 50 and 999 rupees. All measured after trimming.
-- The trigger name sorts AFTER listings_require_seller_ready, so seller readiness (bank account / linked account) is reported before form quality.
-- Only INSERTs made by the seller themselves through the API are checked (auth.uid() = seller_id); server/admin inserts and later UPDATEs are untouched,
-- so existing listings are unaffected. Error code CM081, messages: title_too_short, description_too_short, zip_contents_too_short, price_out_of_range.
-- ADDITIVE: one function and one trigger. Rollback: drop trigger listings_rules_check on public.listings; drop function private.enforce_listing_rules();

create or replace function private.enforce_listing_rules()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or new.seller_id is distinct from (select auth.uid()) then
    return new;
  end if;
  if length(btrim(coalesce(new.title, ''))) < 10 then
    raise exception using errcode = 'CM081', message = 'title_too_short';
  end if;
  if length(btrim(coalesce(new.description, ''))) < 500 then
    raise exception using errcode = 'CM081', message = 'description_too_short';
  end if;
  if new.product_type = 'playbook' and length(btrim(coalesce(new.zip_contents, ''))) < 250 then
    raise exception using errcode = 'CM081', message = 'zip_contents_too_short';
  end if;
  if new.price is null or new.price < 50 or new.price > 999 then
    raise exception using errcode = 'CM081', message = 'price_out_of_range';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_listing_rules() from public, anon, authenticated;

create trigger listings_rules_check before insert on public.listings
  for each row execute function private.enforce_listing_rules();
