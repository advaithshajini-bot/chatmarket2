-- Mandatory listing media (4-10 screenshots + 1 short preview video), tighter text limits, seller storefront reads.
-- ADDITIVE: new columns, a replaced trigger function (same trigger), one new storage bucket + policies, two read functions. No existing row is changed.
--   * listings.preview_video_url, listings.preview_video_duration (5-15 s)
--   * profiles.bio (optional, <= 280 characters) for the creator page
--   * private.enforce_listing_rules REPLACED (CM081). A seller creating their own listing now needs:
--       title 10-20, description 500-2000 (all types); price 50-999 (all types);
--       playbooks also: zip note 250-500, 4-10 screenshots, a preview video, video duration 5-15 s.
--     Messages: title_out_of_range, description_out_of_range, zip_contents_out_of_range, screenshots_count_invalid, video_required,
--     video_duration_out_of_range, price_out_of_range. Server/admin inserts and UPDATEs are untouched.
--   * storage bucket `listing-media` (public read, 25 MB cap, png/jpg/jpeg/webp/mp4/webm). A bucket can only cap one size, so the 10 MB per-image
--     limit and the 25 MB video limit are enforced by the upload form; the bucket caps everything at 25 MB and the policy limits file types.
--   * public.seller_public_profile(uuid) and public.most_popular_listings(int): read-only, SECURITY DEFINER, live listings only, no private data.
-- Rollback: restore private.enforce_listing_rules from 20261030100000; drop the two functions; drop the new columns once unused.

alter table public.listings
  add column preview_video_url text check (preview_video_url is null or length(preview_video_url) <= 1000),
  add column preview_video_duration numeric check (preview_video_duration is null or (preview_video_duration >= 5.0 and preview_video_duration <= 15.0));
alter table public.profiles add column bio text check (bio is null or length(bio) <= 280);

create or replace function private.enforce_listing_rules()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_shots integer;
begin
  if (select auth.uid()) is null or new.seller_id is distinct from (select auth.uid()) then
    return new;
  end if;
  if length(btrim(coalesce(new.title, ''))) not between 10 and 20 then
    raise exception using errcode = 'CM081', message = 'title_out_of_range';
  end if;
  if length(btrim(coalesce(new.description, ''))) not between 500 and 2000 then
    raise exception using errcode = 'CM081', message = 'description_out_of_range';
  end if;
  if new.product_type = 'playbook' then
    if length(btrim(coalesce(new.zip_contents, ''))) not between 250 and 500 then
      raise exception using errcode = 'CM081', message = 'zip_contents_out_of_range';
    end if;
    v_shots := case when jsonb_typeof(new.screenshots) = 'array' then jsonb_array_length(new.screenshots) else 0 end;
    if v_shots not between 4 and 10 then
      raise exception using errcode = 'CM081', message = 'screenshots_count_invalid';
    end if;
    if length(btrim(coalesce(new.preview_video_url, ''))) = 0 then
      raise exception using errcode = 'CM081', message = 'video_required';
    end if;
    if new.preview_video_duration is null or new.preview_video_duration < 5.0 or new.preview_video_duration > 15.0 then
      raise exception using errcode = 'CM081', message = 'video_duration_out_of_range';
    end if;
  end if;
  if new.price is null or new.price < 50 or new.price > 999 then
    raise exception using errcode = 'CM081', message = 'price_out_of_range';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-media', 'listing-media', true, 26214400, array['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'])
on conflict (id) do nothing;

create policy "Listing media is publicly readable" on storage.objects for select to public using (bucket_id = 'listing-media');
create policy "Sellers can upload listing media into their own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'listing-media' and (storage.foldername(name))[1] = (select auth.uid())::text
              and name ~* '\.(png|jpe?g|webp|mp4|webm)$');
create policy "Sellers can delete their own listing media" on storage.objects for delete to authenticated
  using (bucket_id = 'listing-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Admins can delete any listing media" on storage.objects for delete to authenticated
  using (bucket_id = 'listing-media' and (select private.is_admin()));

-- ---------------------------------------------------------------- creator storefront reads
create or replace function public.seller_public_profile(p_seller uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_p record;
  v_listings integer;
  v_sales integer;
  v_rating numeric;
  v_reviews integer;
  v_verified boolean;
begin
  select pr.display_name, pr.bio, pr.created_at into v_p from public.profiles pr where pr.id = p_seller;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  select count(*)::integer into v_listings from public.listings l where l.seller_id = p_seller and l.status = 'live';
  select count(*)::integer into v_sales from public.purchases pu join public.listings l on l.id = pu.listing_id
   where l.seller_id = p_seller and pu.status = 'paid';
  select round(avg(r.rating)::numeric, 1), count(*)::integer into v_rating, v_reviews
    from public.reviews r join public.listings l on l.id = r.listing_id where l.seller_id = p_seller;
  select exists (select 1 from public.seller_payout_accounts a where a.user_id = p_seller and a.status = 'active'
                  and ((a.bank_account_number is not null and a.bank_ifsc is not null) or a.route_status = 'activated'))
    into v_verified;
  return jsonb_build_object('found', true, 'display_name', v_p.display_name, 'bio', v_p.bio, 'joined_at', v_p.created_at,
                            'listing_count', v_listings, 'sales_count', v_sales, 'avg_rating', v_rating, 'review_count', v_reviews, 'verified', v_verified);
end;
$$;
revoke all on function public.seller_public_profile(uuid) from public;
grant execute on function public.seller_public_profile(uuid) to anon, authenticated;

-- most purchased live listings first, then best rated, then newest
create or replace function public.most_popular_listings(p_limit integer default 6)
returns table (listing_id uuid)
language sql stable security definer set search_path = ''
as $$
  select l.id
    from public.listings l
    left join (select pu.listing_id, count(*) as n from public.purchases pu where pu.status = 'paid' group by pu.listing_id) s on s.listing_id = l.id
   where l.status = 'live'
   order by coalesce(s.n, 0) desc, coalesce(l.rating, 0) desc, l.created_at desc
   limit least(greatest(coalesce(p_limit, 6), 1), 24);
$$;
revoke all on function public.most_popular_listings(integer) from public;
grant execute on function public.most_popular_listings(integer) to anon, authenticated;
