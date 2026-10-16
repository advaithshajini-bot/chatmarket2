import Link from "next/link";
import TopNav from "@/components/TopNav";
import AdminPaymentsDesk from "@/components/AdminPaymentsDesk";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getAdminGate } from "@/lib/domain/admin-reviews";
import { getAttention, getBalances, getDisputes, getLedger } from "@/lib/domain/admin-payments";

export const dynamic = "force-dynamic";
export const metadata = { title: "Payments desk — chatmarket" };

// Milestone 5.3. Admin payments desk. Requires is_admin AND aal2 before it draws anything; every admin_* reporting RPC
// re-checks both (private.is_admin_mfa), so this is UX, not the security boundary. Read-only apart from the two existing
// admin actions (clear a parked review, set a seller's payout account), which are themselves admin + MFA RPCs.
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
  const [attention, ledger, disputes, balances] = await Promise.all([
    getAttention(supabase), getLedger(supabase, "all", 0), getDisputes(supabase, "all", 0), getBalances(supabase),
  ]);
  return shell(<AdminPaymentsDesk initialAttention={attention} initialLedger={ledger} initialDisputes={disputes} initialBalances={balances} />);
}
