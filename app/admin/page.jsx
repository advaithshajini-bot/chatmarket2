import Link from "next/link";
import { ShieldAlert, Clock, Lock, Users, Flag, ShieldCheck } from "lucide-react";
import TopNav from "@/components/TopNav";
import AdminQueueClient from "@/components/AdminQueueClient";
import AdminUsersClient from "@/components/AdminUsersClient";
import AdminDisputesClient from "@/components/AdminDisputesClient";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in to view the admin dashboard.</p>
          <Link href="/login?next=/admin" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .single();

  if (!profile?.is_admin) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <ShieldAlert size={24} color="#B33A2E" className="mx-auto mb-3" />
          <p className="text-sm" style={{ color: "#6B6F76" }}>
            Your account doesn't have admin access.
          </p>
        </main>
      </div>
    );
  }

  const { data: queueData } = await supabase
    .from("listings")
    .select("*")
    .in("status", ["pending_review", "flagged"])
    .order("created_at", { ascending: true });

  const queue = (queueData || []).map((l) => ({ ...l, price: Number(l.price) }));

  const { data: usersData } = await supabase
    .from("profiles")
    .select("id, display_name, is_admin, created_at")
    .order("created_at", { ascending: false });

  const users = usersData || [];

  const { data: disputesData } = await supabase
    .from("disputes")
    .select("id, reason, status, resolution_note, created_at, purchase_id, listing_id, buyer_id, listings(title, seller_name), purchases(amount)")
    .order("created_at", { ascending: true });

  const rawDisputes = disputesData || [];
  const buyerIds = [...new Set(rawDisputes.map((d) => d.buyer_id))];
  let buyerNames = {};
  if (buyerIds.length > 0) {
    const { data: buyerProfiles } = await supabase.from("profiles").select("id, display_name").in("id", buyerIds);
    buyerNames = Object.fromEntries((buyerProfiles || []).map((p) => [p.id, p.display_name]));
  }

  const disputes = rawDisputes.map((d) => ({
    id: d.id,
    listingTitle: d.listings?.title || "(listing no longer available)",
    seller: d.listings?.seller_name || "unknown",
    buyer: buyerNames[d.buyer_id] || "unknown",
    amount: d.purchases ? Number(d.purchases.amount) : null,
    reason: d.reason,
    status: d.status,
    resolutionNote: d.resolution_note,
    createdAt: d.created_at,
  }));

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Admin</h1>
          <Link href="/admin/security" className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full" style={{ border: "1px solid #D8D5C9", color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <ShieldCheck size={12} /> Two-factor authentication
          </Link>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-2 gap-4 mb-8">
          <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
            <div className="flex items-center gap-2 mb-1" style={{ color: "#B33A2E" }}>
              <ShieldAlert size={14} />
              <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Flagged</span>
            </div>
            <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {queue.filter((i) => i.status === "flagged").length}
            </p>
          </div>
          <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
            <div className="flex items-center gap-2 mb-1" style={{ color: "#8A6A18" }}>
              <Clock size={14} />
              <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Pending review</span>
            </div>
            <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {queue.filter((i) => i.status === "pending_review").length}
            </p>
          </div>
        </div>

        <p className="text-xs uppercase tracking-wide mb-3" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          Listing queue — live from Supabase
        </p>
        <AdminQueueClient initialQueue={queue} />

        <p className="text-xs mt-8 mb-3" style={{ color: "#6B6F76" }}>
          Refunds only ever happen through a resolved dispute below — see the Razorpay integration doc for how the 48-hour hold and transfer reversal wire up once payments go live.
        </p>

        <div className="flex items-center gap-2 mt-10 mb-3">
          <Flag size={14} color="#6B6F76" />
          <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Disputes — {disputes.filter((d) => d.status === "open").length} open, live from Supabase
          </p>
        </div>
        <AdminDisputesClient initialDisputes={disputes} />

        <div className="flex items-center gap-2 mt-10 mb-3">
          <Users size={14} color="#6B6F76" />
          <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            User management — {users.length} signed up
          </p>
        </div>
        <AdminUsersClient initialUsers={users} currentUserId={userData.user.id} />
      </main>
    </div>
  );
}
