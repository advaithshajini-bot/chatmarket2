-- Migration: add_blueprint_storage   (Phase 4 / Milestone 4.2, part 3 of 3)
--
-- Where the downloadable blueprint (n8n / Flowise / LangFlow JSON) lives and who may read it.
--
-- WHY A NEW BUCKET (not 'listing-files'): listing-files already holds the chat-export ZIPs that
-- the sell page uploads and the library page downloads (listing-files + createSignedUrl). A
-- JSON-only / 5 MiB limit there would break the existing core product. 'listing-blueprints' is
-- separate, private, and strict. listing-files and its policies are NOT touched.
--
-- WHY NOT A jsonb COLUMN ON listings: live listings are readable by anon and authenticated
-- ("Live listings are publicly readable"), every column included. A blueprint column would be
-- free to everyone. Only the file's PATH, format, hash and size go on the listing (none of them
-- is secret); the bytes sit behind storage RLS.
--
-- ACCESS (storage.objects RLS, bucket 'listing-blueprints', path <seller_id>/<listing_id>/<name>.json)
--   seller  : insert/read/delete under their own folder, and only for a listing they own
--   admin   : read
--   buyer   : read iff they hold a purchases row with status 'paid' for that listing (a refund
--             flips status and removes access; copies already downloaded cannot be recalled)
--   everyone else: nothing
--   Policy comparisons are done on TEXT (listing_id::text = folder), never by casting the
--   user-controlled folder name to uuid, so a malformed path cannot raise an error inside a policy.
--
-- DOWNLOAD: the app asks Storage for a 60-second signed URL with the BUYER's own client
-- (lib/blueprints/download.js), so the RLS above is the access check -- no service key involved.

alter table public.listings
  add column blueprint_path       text,
  add column blueprint_format     text,
  add column blueprint_sha256     text,
  add column blueprint_size_bytes integer;

alter table public.listings
  add constraint listings_blueprint_all_or_none check (
       (blueprint_path is null and blueprint_format is null and blueprint_sha256 is null and blueprint_size_bytes is null)
    or (blueprint_path is not null and blueprint_format is not null and blueprint_sha256 is not null and blueprint_size_bytes is not null)),
  add constraint listings_blueprint_format check (blueprint_format in ('n8n', 'flowise', 'langflow')),
  add constraint listings_blueprint_sha256 check (blueprint_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint listings_blueprint_size   check (blueprint_size_bytes between 1 and 5242880),
  add constraint listings_blueprint_path_shape check (
       blueprint_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,100}\.json$'
   and split_part(blueprint_path, '/', 2) = id::text);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-blueprints', 'listing-blueprints', false, 5242880, array['application/json'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "Sellers can upload blueprints for their own listings" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'listing-blueprints'
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,100}\.json$'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.listings l
                 where l.id::text = (storage.foldername(name))[2] and l.seller_id = (select auth.uid())));

create policy "Sellers can read their own blueprints" on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-blueprints' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Sellers can delete their own blueprints" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-blueprints' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "Admins can read any blueprint" on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-blueprints' and (select private.is_admin()));

create policy "Buyers can download blueprints they paid for" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'listing-blueprints'
    and exists (select 1 from public.purchases p
                 where p.listing_id::text = (storage.foldername(name))[2]
                   and p.user_id = (select auth.uid())
                   and p.status = 'paid'));
