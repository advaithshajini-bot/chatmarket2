-- Migration: add_missing_phase1_fk_indexes
--
-- Chatmarket 2.0 Phase 1 correction. Postgres does not auto-index foreign
-- key columns (same convention already noted elsewhere in this schema).
-- The Phase 1 zero-cost validation round found three FK columns created by
-- earlier Phase 1 migrations that were missed: approvals.decided_by,
-- payouts.related_purchase_id, payouts.related_run_id. All three are
-- nullable and unpopulated today (no write path exists yet for either
-- table), so this is purely precautionary -- additive, safe to run once,
-- non-destructive, and it changes no existing data or behavior.
create index approvals_decided_by_idx on public.approvals (decided_by);
create index payouts_related_purchase_id_idx on public.payouts (related_purchase_id);
create index payouts_related_run_id_idx on public.payouts (related_run_id);
