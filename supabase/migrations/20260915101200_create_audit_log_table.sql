-- Migration: create_audit_log_table
--
-- Immutable audit trail for material actions (PRD S12/S17/S25). Phase 1
-- creates the table, admin-only read policy, and a SECURITY DEFINER write
-- helper -- it does NOT wire any existing route (checkout, dispute
-- resolution, KYC, admin moderation) to call it yet. Adding audit writes
-- to those flows would change existing behavior, which this phase is
-- explicitly scoped not to do; that wiring is a Phase 8 (trust & safety)
-- change once there's a real admin UI to view the log.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: some future entries may be system-initiated (e.g. an
  -- automatic timeout), not a specific user's action.
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

create index audit_log_actor_id_idx on public.audit_log (actor_id);
create index audit_log_target_idx on public.audit_log (target_type, target_id);
create index audit_log_created_at_idx on public.audit_log (created_at);

-- Audit log is admin-only to read -- it is not "your own activity
-- history" for a regular user, it's a moderation/security record.
create policy "Admins can view the audit log" on public.audit_log
  for select to authenticated using ((select private.is_admin()));

-- No INSERT policy for `authenticated` or `anon` at all -- rows can only
-- be written through `private.write_audit_log()` below (SECURITY DEFINER,
-- not directly callable by a client either), so entries can't be forged or
-- deleted by anyone, including a compromised client session.
create function private.write_audit_log(
  p_actor_id uuid,
  p_action text,
  p_target_type text,
  p_target_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_actor_id, p_action, p_target_type, p_target_id, p_metadata);
$$;

-- Not granted to anon/authenticated -- only other SECURITY DEFINER
-- functions (future admin-action RPCs, e.g. a later version of
-- resolve_dispute or a new approve_run RPC) call this internally. A
-- future migration will explicitly grant it once such an RPC exists;
-- granting it now with nothing calling it yet would be premature surface
-- area.
revoke execute on function private.write_audit_log(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
