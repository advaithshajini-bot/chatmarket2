import Link from "next/link";
import TopNav from "@/components/TopNav";
import AdminReviewDesk from "@/components/AdminReviewDesk";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getAdminGate, getReviewQueue } from "@/lib/domain/admin-reviews";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moderation desk — chatmarket" };

// Phase 4.4. Admin Moderation Desk. The page requires is_admin AND an aal2 (MFA-verified) session before it draws
// anything; every review RPC re-checks both (private.is_admin_mfa), so this is UX, not the security boundary.
export default async function AdminReviewsPage() {
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
    return shell(<p style={{ color: "#3A3D42" }}><Link href="/login?next=/admin/reviews" style={{ textDecoration: "underline" }}>Log in</Link> to continue.</p>);
  }
  if (!gate.isAdmin) {
    return shell(<p style={{ color: "#6B6F76" }}>You don&apos;t have access to this page.</p>);
  }
  if (!gate.allowed) {
    return shell(
      <p style={{ color: "#3A3D42" }}>
        Reviewing requires a verified MFA session. Complete your second-factor check, then reload this page.
      </p>
    );
  }
  const queue = await getReviewQueue(supabase);
  return shell(<AdminReviewDesk initialQueue={queue} />);
}
