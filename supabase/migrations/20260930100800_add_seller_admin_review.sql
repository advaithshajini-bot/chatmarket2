-- Migration: add_seller_admin_review   (Phase 4 / Milestone 4.4)
-- Requires 20260930100400 .. 100700 and the Phase 1-3 helpers private.is_admin() / private.is_admin_mfa().
--
-- WHAT THIS ADDS
--   Seller Studio : a seller authors a demo (sample input + <=2 prompt steps) and registers a blueprint file;
--                   both go to 'pending_admin_approval'.
--   Admin desk    : admin + MFA (JWT aal2) review queue; approve / reject with an audit trail.
--   Invariants    : * only an approved demo is ever surfaced by public.listing_demo_info / startable
--                     (listing_demos.approved_at stays THE gate that create_demo_run reads);
--                   * listings.blueprint_* can only change through public.review_listing_blueprint;
--                   * a blueprint object that is pending review or live cannot be deleted/replaced by the seller;
--                   * buyers can read only the CURRENT blueprint object, never a pending/rejected upload;
--                   * approving a blueprint requires the hash the server RE-COMPUTED from the stored bytes
--                     at review time to equal the hash recorded at submission (the client's hash is never trusted).
--
-- ERROR CODES (CM050 unused; CM051..CM062 are new, no collisions with CM001-CM041):
--   CM051 listing_not_found (also: not the seller)    CM052 invalid_demo_sample_input
--   CM053 listing_not_eligible (workflow/agent only)   CM054 demo_not_ready
--   CM055 invalid_review_state                         CM056 stale_review
--   CM057 review_note_required (reject needs >= 10 chars)
--   CM058 invalid_blueprint                            CM059 blueprint_hash_mismatch
--   CM060 self_review_forbidden                        CM061 invalid_decision
--   CM062 review_target_not_found
--   28000 not_authenticated   42501 admin_required / blueprint_write_forbidden

-- ============================================================================ listing_demos: review columns
alter table public.listing_demos
  add column sample_input   text,
  add column review_status  text    not null default 'draft',
  add column review_note    text,
  add column submitted_at   timestamptz,
  add column reviewed_at    timestamptz,
  add column reviewed_by    uuid references auth.users(id) on delete set null,
  add column config_version integer not null default 1;

-- one function, three jobs: validate, reset review on CONTENT change, keep approved_at <-> review_status consistent.
-- Content = demo_config or sample_input. Validation of demo_config runs only on INSERT or when it changes, so that
-- disabling a demo (or any non-content write) is never blocked by e.g. a model deactivated since approval.
create or replace function private.listing_demos_before_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.assert_demo_config(new.demo_config);
    new.review_status := 'draft';
    new.approved_at := null; new.approved_by := null;
    new.reviewed_at := null; new.reviewed_by := null;
    new.review_note := null; new.submitted_at := null;
    new.config_version := 1;
  elsif new.demo_config is distinct from old.demo_config or new.sample_input is distinct from old.sample_input then
    if new.demo_config is distinct from old.demo_config then
      perform private.assert_demo_config(new.demo_config);
    end if;
    new.config_version := old.config_version + 1;
    new.review_status := 'draft';
    new.approved_at := null; new.approved_by := null;
    new.reviewed_at := null; new.reviewed_by := null;
    new.review_note := null; new.submitted_at := null;
  else
    new.config_version := old.config_version;                       -- only a content change may move the version
    -- keep legacy writers (4.2 set_listing_demo_approval, owner scripts) consistent with the new constraint
    if new.approved_at is not null and old.approved_at is null and new.review_status <> 'approved' then
      new.review_status := 'approved';
      new.reviewed_at := coalesce(new.reviewed_at, now());
      new.reviewed_by := coalesce(new.reviewed_by, new.approved_by);
    elsif new.approved_at is null and old.approved_at is not null and new.review_status = 'approved' then
      new.review_status := 'draft';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- backfill rows approved under 4.2 BEFORE the consistency constraint exists
update public.listing_demos
   set review_status = 'approved', reviewed_at = approved_at, reviewed_by = approved_by
 where approved_at is not null;

alter table public.listing_demos
  add constraint listing_demos_review_status check (review_status in ('draft', 'pending_admin_approval', 'approved', 'rejected')),
  add constraint listing_demos_approved_consistent check ((review_status = 'approved') = (approved_at is not null)),
  add constraint listing_demos_sample_input check (sample_input is null
        or (char_length(sample_input) between 1 and 2000 and sample_input !~ '^[[:space:]]*$')),
  add constraint listing_demos_review_note check (review_note is null or char_length(review_note) <= 1000),
  add constraint listing_demos_version_positive check (config_version >= 1);

-- ============================================================================ audit trail (append-only)
create table public.review_audit (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor_id     uuid,
  action       text not null check (action in ('demo_submitted', 'demo_approved', 'demo_rejected', 'demo_approval_set', 'demo_approval_revoked',
                                               'blueprint_submitted', 'blueprint_approved', 'blueprint_rejected', 'blueprint_superseded')),
  subject_kind text not null check (subject_kind in ('demo', 'blueprint')),
  listing_id   uuid,
  subject_id   text,
  note         text,
  detail       jsonb not null default '{}'::jsonb
);
alter table public.review_audit enable row level security;
revoke all on public.review_audit from public, anon, authenticated, service_role;
grant select on public.review_audit to authenticated;
create policy "Admins can read the review audit" on public.review_audit for select to authenticated
  using ((select private.is_admin()));

create function private.review_audit_immutable() returns trigger language plpgsql set search_path = ''
as $$ begin raise exception using errcode = '42501', message = 'review_audit_is_append_only'; end; $$;
create trigger review_audit_no_update before update or delete on public.review_audit
  for each row execute function private.review_audit_immutable();

create function private.write_review_audit(p_action text, p_kind text, p_listing uuid, p_subject text, p_note text, p_detail jsonb)
returns void language sql volatile security definer set search_path = ''
as $$
  insert into public.review_audit (actor_id, action, subject_kind, listing_id, subject_id, note, detail)
  values (auth.uid(), p_action, p_kind, p_listing, p_subject, p_note, coalesce(p_detail, '{}'::jsonb));
$$;

-- ============================================================================ blueprint submissions
create table public.blueprint_submissions (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null references public.listings(id) on delete cascade,
  seller_id    uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  format       text not null check (format in ('n8n', 'flowise', 'langflow')),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  scan_summary jsonb not null default '{}'::jsonb,     -- counts / finding TYPES only, never secret values
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded')),
  review_note  text check (review_note is null or char_length(review_note) <= 1000),
  submitted_at timestamptz not null default now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid references auth.users(id) on delete set null,
  constraint blueprint_submissions_path_shape check (
        storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,100}\.json$'
    and split_part(storage_path, '/', 1) = seller_id::text
    and split_part(storage_path, '/', 2) = listing_id::text),
  constraint blueprint_submissions_reviewed check (status in ('pending', 'superseded') or reviewed_at is not null)
);
create unique index blueprint_submissions_one_pending_idx on public.blueprint_submissions (listing_id) where status = 'pending';
create index blueprint_submissions_path_idx on public.blueprint_submissions (storage_path);
alter table public.blueprint_submissions enable row level security;
revoke all on public.blueprint_submissions from public, anon, authenticated, service_role;
grant select on public.blueprint_submissions to authenticated;                  -- writes only through the RPCs below
create policy "Sellers can read their own submissions" on public.blueprint_submissions for select to authenticated
  using (seller_id = (select auth.uid()));
create policy "Admins can read all submissions" on public.blueprint_submissions for select to authenticated
  using ((select private.is_admin()));

-- ============================================================================ listings.blueprint_* only via review
-- A custom GUC alone is not a boundary against raw SQL, so the trigger ALSO requires that the statement runs as the
-- function owner (current_user is the owner inside a SECURITY DEFINER function, the API role otherwise).
create function private.listings_guard_blueprint()
returns trigger language plpgsql set search_path = ''
as $$
declare v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.blueprint_path is not null or new.blueprint_format is not null
              or new.blueprint_sha256 is not null or new.blueprint_size_bytes is not null;
  else
    v_changed := new.blueprint_path       is distinct from old.blueprint_path
              or new.blueprint_format     is distinct from old.blueprint_format
              or new.blueprint_sha256     is distinct from old.blueprint_sha256
              or new.blueprint_size_bytes is distinct from old.blueprint_size_bytes;
  end if;
  if v_changed and (coalesce(current_setting('chatmarket.blueprint_write', true), '') <> 'on'
                    or current_user in ('anon', 'authenticated', 'service_role', 'authenticator')) then
    raise exception using errcode = '42501', message = 'blueprint_write_forbidden';
  end if;
  return new;
end;
$$;
create trigger listings_guard_blueprint
  before insert or update of blueprint_path, blueprint_format, blueprint_sha256, blueprint_size_bytes on public.listings
  for each row execute function private.listings_guard_blueprint();

-- ============================================================================ storage helpers + policies
create function private.is_current_blueprint(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.listings l where l.blueprint_path = p_name); $$;

create function private.is_pending_blueprint(p_name text)
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.blueprint_submissions s where s.storage_path = p_name and s.status = 'pending'); $$;

-- buyer access: paid purchase of THIS listing AND the object is the listing's current, approved blueprint.
-- (4.2 allowed any object under the listing folder, which would have exposed unreviewed uploads.)
create function private.can_download_blueprint(p_name text, p_uid uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_uid is not null
     and private.is_current_blueprint(p_name)
     and exists (select 1 from public.purchases p
                  where p.listing_id::text = split_part(p_name, '/', 2) and p.user_id = p_uid and p.status = 'paid');
$$;

drop policy "Buyers can download blueprints they paid for" on storage.objects;
create policy "Buyers can download blueprints they paid for" on storage.objects
  for select to authenticated
  using (bucket_id = 'listing-blueprints' and private.can_download_blueprint(name, (select auth.uid())));

drop policy "Sellers can delete their own blueprints" on storage.objects;
create policy "Sellers can delete their own blueprints" on storage.objects
  for delete to authenticated
  using (bucket_id = 'listing-blueprints'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and not private.is_current_blueprint(name)
         and not private.is_pending_blueprint(name));

-- ============================================================================ seller RPCs
create function public.list_demo_models()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception using errcode = '28000', message = 'not_authenticated'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('model', m.model, 'tier', m.tier, 'isDefault', m.is_demo_default)
                                    order by m.is_demo_default desc, m.model)
                     from private.model_pricing m where m.is_active), '[]'::jsonb);
end;
$$;

create function public.save_listing_demo(p_listing_id uuid, p_demo_config jsonb, p_sample_input text, p_is_enabled boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_listing public.listings%rowtype;
  v_demo    public.listing_demos%rowtype;
begin
  if auth.uid() is null then raise exception using errcode = '28000', message = 'not_authenticated'; end if;
  select l.* into v_listing from public.listings l where l.id = p_listing_id and l.seller_id = auth.uid();
  if not found then raise exception using errcode = 'CM051', message = 'listing_not_found'; end if;
  if v_listing.product_type not in ('workflow', 'agent') then
    raise exception using errcode = 'CM053', message = 'listing_not_eligible';
  end if;
  if p_sample_input is not null and (char_length(p_sample_input) > 2000 or p_sample_input ~ '^[[:space:]]*$') then
    raise exception using errcode = 'CM052', message = 'invalid_demo_sample_input';
  end if;
  perform private.assert_demo_config(p_demo_config);                -- CM001 / CM002

  insert into public.listing_demos as d (listing_id, demo_config, sample_input, is_enabled)
  values (p_listing_id, p_demo_config, p_sample_input, coalesce(p_is_enabled, true))
  on conflict (listing_id) do update
    set demo_config = excluded.demo_config, sample_input = excluded.sample_input, is_enabled = excluded.is_enabled;

  select d.* into v_demo from public.listing_demos d where d.listing_id = p_listing_id;
  return jsonb_build_object('configVersion', v_demo.config_version, 'reviewStatus', v_demo.review_status, 'isEnabled', v_demo.is_enabled);
end;
$$;

create function public.submit_listing_demo_for_review(p_listing_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare v_demo public.listing_demos%rowtype;
begin
  if auth.uid() is null then raise exception using errcode = '28000', message = 'not_authenticated'; end if;
  perform 1 from public.listings l where l.id = p_listing_id and l.seller_id = auth.uid();
  if not found then raise exception using errcode = 'CM051', message = 'listing_not_found'; end if;
  select d.* into v_demo from public.listing_demos d where d.listing_id = p_listing_id for update;
  if not found or not v_demo.is_enabled or v_demo.sample_input is null then
    raise exception using errcode = 'CM054', message = 'demo_not_ready';
  end if;
  if v_demo.review_status not in ('draft', 'rejected') then
    raise exception using errcode = 'CM055', message = 'invalid_review_state';
  end if;
  perform private.assert_demo_config(v_demo.demo_config);
  update public.listing_demos d
     set review_status = 'pending_admin_approval', submitted_at = now(), review_note = null, reviewed_at = null, reviewed_by = null
   where d.listing_id = p_listing_id;
  perform private.write_review_audit('demo_submitted', 'demo', p_listing_id, p_listing_id::text, null,
                                     jsonb_build_object('configVersion', v_demo.config_version));
  return jsonb_build_object('configVersion', v_demo.config_version, 'reviewStatus', 'pending_admin_approval');
end;
$$;

-- p_scan carries counts / finding types computed by the server route; it is informational only (admins re-verify).
create function public.submit_listing_blueprint(p_listing_id uuid, p_path text, p_format text, p_sha256 text, p_size_bytes integer, p_scan jsonb default '{}'::jsonb)
returns uuid language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_listing public.listings%rowtype;
  v_obj_size bigint;
  v_id uuid;
begin
  if auth.uid() is null then raise exception using errcode = '28000', message = 'not_authenticated'; end if;
  select l.* into v_listing from public.listings l where l.id = p_listing_id and l.seller_id = auth.uid() for update;
  if not found then raise exception using errcode = 'CM051', message = 'listing_not_found'; end if;
  if v_listing.product_type not in ('workflow', 'agent') then
    raise exception using errcode = 'CM053', message = 'listing_not_eligible';
  end if;
  if p_path is null or p_format is null or p_sha256 is null or p_size_bytes is null
     or p_format not in ('n8n', 'flowise', 'langflow')
     or p_sha256 !~ '^[0-9a-f]{64}$' or p_size_bytes not between 1 and 5242880
     or split_part(p_path, '/', 1) <> auth.uid()::text or split_part(p_path, '/', 2) <> p_listing_id::text
     or p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,100}\.json$'
     or jsonb_typeof(coalesce(p_scan, '{}'::jsonb)) is distinct from 'object' then
    raise exception using errcode = 'CM058', message = 'invalid_blueprint';
  end if;
  -- the object must really be in the private bucket, and its size (when Storage records one) must match
  select (o.metadata ->> 'size')::bigint into v_obj_size
    from storage.objects o where o.bucket_id = 'listing-blueprints' and o.name = p_path;
  if not found or (v_obj_size is not null and v_obj_size <> p_size_bytes) then
    raise exception using errcode = 'CM058', message = 'invalid_blueprint';
  end if;

  update public.blueprint_submissions s set status = 'superseded'
   where s.listing_id = p_listing_id and s.status = 'pending';
  insert into public.blueprint_submissions (listing_id, seller_id, storage_path, format, sha256, size_bytes, scan_summary)
  values (p_listing_id, auth.uid(), p_path, p_format, p_sha256, p_size_bytes, coalesce(p_scan, '{}'::jsonb))
  returning id into v_id;
  perform private.write_review_audit('blueprint_submitted', 'blueprint', p_listing_id, v_id::text, null,
                                     jsonb_build_object('format', p_format, 'sizeBytes', p_size_bytes, 'sha256', p_sha256));
  return v_id;
end;
$$;

-- ============================================================================ admin RPCs (admin + MFA first, always)
create function public.admin_review_queue(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_lim integer; v_demos jsonb; v_bps jsonb;
begin
  if not private.is_admin_mfa() then raise exception using errcode = '42501', message = 'admin_required'; end if;
  v_lim := least(200, greatest(1, coalesce(p_limit, 50)));
  select coalesce(jsonb_agg(x order by x ->> 'submittedAt'), '[]'::jsonb) into v_demos from (
    select jsonb_build_object('listingId', d.listing_id, 'title', l.title, 'sellerName', l.seller_name,
                              'stepCount', jsonb_array_length(d.demo_config -> 'steps'),
                              'configVersion', d.config_version, 'submittedAt', d.submitted_at) as x
      from public.listing_demos d join public.listings l on l.id = d.listing_id
     where d.review_status = 'pending_admin_approval' order by d.submitted_at limit v_lim) q;
  select coalesce(jsonb_agg(x order by x ->> 'submittedAt'), '[]'::jsonb) into v_bps from (
    select jsonb_build_object('submissionId', s.id, 'listingId', s.listing_id, 'title', l.title, 'sellerName', l.seller_name,
                              'format', s.format, 'sizeBytes', s.size_bytes, 'submittedAt', s.submitted_at) as x
      from public.blueprint_submissions s join public.listings l on l.id = s.listing_id
     where s.status = 'pending' order by s.submitted_at limit v_lim) q;
  return jsonb_build_object('demos', v_demos, 'blueprints', v_bps);
end;
$$;

create function public.admin_get_demo_for_review(p_listing_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_d public.listing_demos%rowtype; v_l public.listings%rowtype;
begin
  if not private.is_admin_mfa() then raise exception using errcode = '42501', message = 'admin_required'; end if;
  select d.* into v_d from public.listing_demos d where d.listing_id = p_listing_id;
  if not found then raise exception using errcode = 'CM062', message = 'review_target_not_found'; end if;
  select l.* into v_l from public.listings l where l.id = p_listing_id;
  return jsonb_build_object('listingId', v_d.listing_id, 'title', v_l.title, 'sellerName', v_l.seller_name, 'sellerId', v_l.seller_id,
    'reviewStatus', v_d.review_status, 'configVersion', v_d.config_version, 'isEnabled', v_d.is_enabled,
    'sampleInput', v_d.sample_input, 'demoConfig', v_d.demo_config, 'submittedAt', v_d.submitted_at, 'reviewNote', v_d.review_note);
end;
$$;

create function public.admin_get_blueprint_for_review(p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_s public.blueprint_submissions%rowtype; v_l public.listings%rowtype;
begin
  if not private.is_admin_mfa() then raise exception using errcode = '42501', message = 'admin_required'; end if;
  select s.* into v_s from public.blueprint_submissions s where s.id = p_submission_id;
  if not found then raise exception using errcode = 'CM062', message = 'review_target_not_found'; end if;
  select l.* into v_l from public.listings l where l.id = v_s.listing_id;
  return jsonb_build_object('submissionId', v_s.id, 'listingId', v_s.listing_id, 'title', v_l.title, 'sellerName', v_l.seller_name,
    'sellerId', v_s.seller_id, 'status', v_s.status, 'storagePath', v_s.storage_path, 'format', v_s.format, 'sha256', v_s.sha256,
    'sizeBytes', v_s.size_bytes, 'scanSummary', v_s.scan_summary, 'submittedAt', v_s.submitted_at, 'reviewNote', v_s.review_note);
end;
$$;

create function public.review_listing_demo(p_listing_id uuid, p_decision text, p_expected_version integer, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_d public.listing_demos%rowtype; v_seller uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.is_admin_mfa() then raise exception using errcode = '42501', message = 'admin_required'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception using errcode = 'CM061', message = 'invalid_decision';
  end if;
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 10) then
    raise exception using errcode = 'CM057', message = 'review_note_required';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = 'CM057', message = 'review_note_required';
  end if;
  select d.* into v_d from public.listing_demos d where d.listing_id = p_listing_id for update;
  if not found then raise exception using errcode = 'CM062', message = 'review_target_not_found'; end if;
  select l.seller_id into v_seller from public.listings l where l.id = p_listing_id;
  if v_seller is not distinct from auth.uid() then
    raise exception using errcode = 'CM060', message = 'self_review_forbidden';
  end if;
  if v_d.review_status <> 'pending_admin_approval' then
    raise exception using errcode = 'CM055', message = 'invalid_review_state';
  end if;
  if p_expected_version is distinct from v_d.config_version then
    raise exception using errcode = 'CM056', message = 'stale_review';
  end if;

  if p_decision = 'approve' then
    if not v_d.is_enabled or v_d.sample_input is null then
      raise exception using errcode = 'CM054', message = 'demo_not_ready';
    end if;
    perform private.assert_demo_config(v_d.demo_config);
    update public.listing_demos d
       set review_status = 'approved', approved_at = now(), approved_by = auth.uid(),
           reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note
     where d.listing_id = p_listing_id;
  else
    update public.listing_demos d
       set review_status = 'rejected', approved_at = null, approved_by = null,
           reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note
     where d.listing_id = p_listing_id;
  end if;
  perform private.write_review_audit(case when p_decision = 'approve' then 'demo_approved' else 'demo_rejected' end, 'demo', p_listing_id, p_listing_id::text, v_note,
                                     jsonb_build_object('configVersion', v_d.config_version));
  return jsonb_build_object('reviewStatus', case when p_decision = 'approve' then 'approved' else 'rejected' end,
                            'configVersion', v_d.config_version);
end;
$$;

create function public.review_listing_blueprint(p_submission_id uuid, p_decision text, p_verified_sha256 text default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_s public.blueprint_submissions%rowtype; v_seller uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not private.is_admin_mfa() then raise exception using errcode = '42501', message = 'admin_required'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception using errcode = 'CM061', message = 'invalid_decision';
  end if;
  if p_decision = 'reject' and (v_note is null or char_length(v_note) < 10) then
    raise exception using errcode = 'CM057', message = 'review_note_required';
  end if;
  if v_note is not null and char_length(v_note) > 1000 then
    raise exception using errcode = 'CM057', message = 'review_note_required';
  end if;
  select s.* into v_s from public.blueprint_submissions s where s.id = p_submission_id for update;
  if not found then raise exception using errcode = 'CM062', message = 'review_target_not_found'; end if;
  select l.seller_id into v_seller from public.listings l where l.id = v_s.listing_id for update;
  if v_seller is not distinct from auth.uid() then
    raise exception using errcode = 'CM060', message = 'self_review_forbidden';
  end if;
  if v_s.status <> 'pending' then
    raise exception using errcode = 'CM055', message = 'invalid_review_state';
  end if;

  if p_decision = 'approve' then
    -- the caller (server route) re-downloaded the stored object and re-hashed it: it must equal what was submitted
    if p_verified_sha256 is null or p_verified_sha256 !~ '^[0-9a-f]{64}$' or p_verified_sha256 <> v_s.sha256 then
      raise exception using errcode = 'CM059', message = 'blueprint_hash_mismatch';
    end if;
    perform 1 from storage.objects o where o.bucket_id = 'listing-blueprints' and o.name = v_s.storage_path;
    if not found then raise exception using errcode = 'CM058', message = 'invalid_blueprint'; end if;

    perform set_config('chatmarket.blueprint_write', 'on', true);
    update public.listings l
       set blueprint_path = v_s.storage_path, blueprint_format = v_s.format,
           blueprint_sha256 = v_s.sha256, blueprint_size_bytes = v_s.size_bytes
     where l.id = v_s.listing_id;
    perform set_config('chatmarket.blueprint_write', 'off', true);

    update public.blueprint_submissions s set status = 'superseded'
     where s.listing_id = v_s.listing_id and s.status = 'approved';
    update public.blueprint_submissions s
       set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note
     where s.id = p_submission_id;
  else
    update public.blueprint_submissions s
       set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note
     where s.id = p_submission_id;
  end if;
  perform private.write_review_audit(case when p_decision = 'approve' then 'blueprint_approved' else 'blueprint_rejected' end, 'blueprint', v_s.listing_id, p_submission_id::text, v_note,
                                     jsonb_build_object('sha256', v_s.sha256, 'format', v_s.format));
  return jsonb_build_object('status', case when p_decision = 'approve' then 'approved' else 'rejected' end);
end;
$$;

-- 4.2's direct approve/revoke stays (admin + MFA) but now leaves an audit trail and honours the review columns
create or replace function public.set_listing_demo_approval(p_listing_id uuid, p_approved boolean)
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
    update public.listing_demos d
       set review_status = 'approved', approved_at = now(), approved_by = auth.uid(), reviewed_at = now(), reviewed_by = auth.uid()
     where d.listing_id = p_listing_id;
    perform private.write_review_audit('demo_approval_set', 'demo', p_listing_id, p_listing_id::text, null, '{}'::jsonb);
  else
    update public.listing_demos d
       set review_status = 'draft', approved_at = null, approved_by = null
     where d.listing_id = p_listing_id;
    perform private.write_review_audit('demo_approval_revoked', 'demo', p_listing_id, p_listing_id::text, null, '{}'::jsonb);
  end if;
end;
$$;

-- ============================================================================ listing_demo_info: + sampleInput
create or replace function public.listing_demo_info(p_listing_id uuid)
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
  if not found or not v_demo.is_enabled or v_demo.approved_at is null or v_demo.review_status <> 'approved' then
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
    'budgetExhausted', not private.demo_budget_has_room(),
    'sampleInput',     v_demo.sample_input
  );
exception when others then
  return v_unavailable;
end;
$$;

-- ============================================================================ privileges
revoke execute on function private.review_audit_immutable()                                    from public, anon, authenticated, service_role;
revoke execute on function private.write_review_audit(text, text, uuid, text, text, jsonb)     from public, anon, authenticated, service_role;
revoke execute on function private.listings_guard_blueprint()                                  from public, anon, authenticated, service_role;
-- storage policies call these as the signed-in user, so authenticated needs EXECUTE (they return only a boolean)
revoke execute on function private.is_current_blueprint(text)                                  from public, anon, service_role;
revoke execute on function private.is_pending_blueprint(text)                                  from public, anon, service_role;
revoke execute on function private.can_download_blueprint(text, uuid)                          from public, anon, service_role;
grant  execute on function private.is_current_blueprint(text), private.is_pending_blueprint(text),
                           private.can_download_blueprint(text, uuid)                          to authenticated;

revoke execute on function public.list_demo_models()                                           from public, anon, service_role;
revoke execute on function public.save_listing_demo(uuid, jsonb, text, boolean)                from public, anon, service_role;
revoke execute on function public.submit_listing_demo_for_review(uuid)                         from public, anon, service_role;
revoke execute on function public.submit_listing_blueprint(uuid, text, text, text, integer, jsonb) from public, anon, service_role;
revoke execute on function public.admin_review_queue(integer)                                  from public, anon, service_role;
revoke execute on function public.admin_get_demo_for_review(uuid)                              from public, anon, service_role;
revoke execute on function public.admin_get_blueprint_for_review(uuid)                         from public, anon, service_role;
revoke execute on function public.review_listing_demo(uuid, text, integer, text)               from public, anon, service_role;
revoke execute on function public.review_listing_blueprint(uuid, text, text, text)             from public, anon, service_role;
grant  execute on function public.list_demo_models(), public.save_listing_demo(uuid, jsonb, text, boolean),
                           public.submit_listing_demo_for_review(uuid),
                           public.submit_listing_blueprint(uuid, text, text, text, integer, jsonb),
                           public.admin_review_queue(integer), public.admin_get_demo_for_review(uuid),
                           public.admin_get_blueprint_for_review(uuid), public.review_listing_demo(uuid, text, integer, text),
                           public.review_listing_blueprint(uuid, text, text, text)             to authenticated;
-- create or replace keeps the existing grants of set_listing_demo_approval and listing_demo_info (anon + authenticated)
