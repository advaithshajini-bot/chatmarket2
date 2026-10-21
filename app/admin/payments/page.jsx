import Link from "next/link";
import TopNav from "@/components/TopNav";
import AdminPaymentsDesk from "@/components/AdminPaymentsDesk";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getAdminGate } from "@/lib/domain/admin-reviews";
import { getAttention, getDisputes, getLedger, getPayouts } from "@/lib/domain/admin-payments";
import { getSettlementBatches, getSettlementPending } from "@/lib/domain/admin-settlement";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments desk — chatmarket" };

// Milestone 5.3 / 5.5. Admin payments desk. Requires is_admin AND aal2 before it draws anything; every admin_* RPC
// re-checks both (private.is_admin_mfa), so this is UX, not the security boundary. 5.5 adds the Monthly settlement tab (manual UPI
// payouts: preview, freeze a batch, CSV, record the bank reference); nothing on this page calls any outgoing payout API.
export default async function AdminPaymentsPage() {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const gate = await getAdminGate(supabase, user);
  const shell = (body) => (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="max-w-6xl mx-auto px-6 py-10">{body}</main>
    </div>
  );
  if (!user) {
    return shell(<p style={{ color: "#3A3D42" }}><Link href="/login?next=/admin/payments" style={{ textDecoration: "underline" }}>Log in</Link> to continue.</p>);
  }
  if (!gate.isAdmin) {
    return shell(<p style={{ color: "#6B6F76" }}>You don&apos;t have access to this page.</p>);
  }
  if (!gate.allowed) {
    return shell(
      <p style={{ color: "#3A3D42" }}>
        The payments desk requires a verified MFA session. Complete your second-factor check, then reload this page.
      </p>
    );
  }
  const [attention, ledger, disputes, payouts, pending, batches] = await Promise.all([
    getAttention(supabase), getLedger(supabase, "all", 0), getDisputes(supabase, "all", 0), getPayouts(supabase, "all", 0),
    getSettlementPending(supabase, null), getSettlementBatches(supabase),
  ]);
  return shell(<AdminPaymentsDesk initialAttention={attention} initialLedger={ledger} initialDisputes={disputes} initialPayouts={payouts} initialSettlement={{ pending, batches }} />);
}
