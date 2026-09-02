import Link from "next/link";
import { ShieldAlert, Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import AdminMfaSetup from "@/components/AdminMfaSetup";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in.</p>
          <Link href="/login?next=/admin/security" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  const { data: profile } = await supabase.from("profiles").select("is_admin").eq("id", userData.user.id).single();

  if (!profile?.is_admin) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <ShieldAlert size={24} color="#B33A2E" className="mx-auto mb-3" />
          <p className="text-sm" style={{ color: "#6B6F76" }}>Your account doesn't have admin access.</p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-lg mx-auto">
        <Link href="/admin" className="text-sm inline-block mb-6" style={{ color: "#6B6F76" }}>← Back to admin</Link>
        <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Two-factor authentication
        </h1>
        <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
          Sensitive admin actions — approving/rejecting listings, granting admin access, resolving disputes — now
          require this. A stolen password alone isn't enough to change anything on this account.
        </p>
        <AdminMfaSetup />
      </main>
    </div>
  );
}
