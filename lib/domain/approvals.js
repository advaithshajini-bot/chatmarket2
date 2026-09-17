// lib/domain/approvals.js
//
// Human-approval gate records for high-risk run steps (public.approvals,
// PRD S13). Read-only in Phase 1. Deciding an approval (a buyer approving
// their own run's high-risk step, or an admin override) needs a checked
// RPC that also resumes/cancels the underlying run atomically -- the same
// pattern private.resolve_dispute() already uses for disputes. That RPC,
// and the decideApproval() call that would use it, belongs to Phase 4
// (tool/permission system), once there's an execution engine for a
// decision to actually resume.

export async function listRunApprovals(supabase, runId) {
  const { data, error } = await supabase
    .from("approvals")
    .select("id, requested_permission, status, decided_by, decided_at, created_at")
    .eq("run_id", runId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
