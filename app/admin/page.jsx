import Link from "next/link";
import { ShieldAlert, Clock, Lock, Users, Flag, ShieldCheck, Trash2, FileCheck } from "lucide-react";
import TopNav from "@/components/TopNav";
import AdminQueueClient from "@/components/AdminQueueClient";
import AdminUsersClient from "@/components/AdminUsersClient";
import AdminDisputesClient from "@/components/AdminDisputesClient";
import AdminLiveListingsClient from "@/components/AdminLiveListingsClient";
import AdminKycReviewClient from "@/components/AdminKycReviewClient";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
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
    .eq("id", user.id)
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

  // Live listings, separately from the pending/flagged moderation queue --
  // for removing something that was already approved and later found to
  // be deficient in some way.
  const { data: liveListingsData } = await supabase
    .from("listings")
    .select("id, title, price, category, model, seller_name, created_at")
    .eq("status", "live")
    .order("created_at", { ascending: false });
  const liveListings = (liveListingsData || []).map((l) => ({ ...l, price: Number(l.price) }));

  // Seller payout KYC awaiting or already given a decision. Submitting KYC
  // used to be treated as "payout setup complete" on its own -- this is
  // the actual admin sign-off step before that's true.
  const { data: kycData } = await supabase
    .from("seller_kyc")
    .select("*")
    .neq("status", "draft")
    .order("updated_at", { ascending: true });

  const rawKyc = kycData || [];
  const kycUserIds = [...new Set(rawKyc.map((k) => k.user_id))];
  let kycSellerNames = {};
  if (kycUserIds.length > 0) {
    const { data: kycProfiles } = await supabase.from("profiles").select("id, display_name").in("id", kycUserIds);
    kycSellerNames = Object.fromEntries((kycProfiles || []).map((p) => [p.id, p.display_name]));
  }

  // Document paths live in a private bucket -- sign them here (server-side,
  // with the admin's own session) so the client can open them directly
  // without needing its own storage call.
  const signAttachment = async (path) => {
    if (!path) return null;
    const { data, error } = await supabase.storage.from("seller-kyc-documents").createSignedUrl(path, 60 * 15);
    return error ? null : data.signedUrl;
  };

  const kycRecords = await Promise.all(
    rawKyc.map(async (k) => ({
      ...k,
      sellerName: kycSellerNames[k.user_id] || "Unknown",
      panAttachmentUrl: await signAttachment(k.pan_attachment_path),
      aadhaarAttachmentUrl: await signAttachment(k.aadhaar_attachment_path),
    }))
  );

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
          <Trash2 size={14} color="#6B6F76" />
          <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Live listings — {liveListings.length}, live from Supabase
          </p>
        </div>
        <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>
          Remove a listing that's already approved and live if it's later found deficient. The seller sees your reason on their dashboard.
        </p>
        <AdminLiveListingsClient initialListings={liveListings} />

        <div className="flex items-center gap-2 mt-10 mb-3">
          <FileCheck size={14} color="#6B6F76" />
          <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Seller payout KYC — {kycRecords.filter((k) => k.status === "submitted").length} awaiting review, live from Supabase
          </p>
        </div>
        <AdminKycReviewClient initialRecords={kycRecords} />

        <div className="flex items-center gap-2 mt-10 mb-3">
          <Users size={14} color="#6B6F76" />
          <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            User management — {users.length} signed up
          </p>
        </div>
        <AdminUsersClient initialUsers={users} currentUserId={user.id} />
      </main>
    </div>
  );
}
