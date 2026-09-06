import Link from "next/link";
import { Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import PurchaseHistoryClient from "@/components/PurchaseHistoryClient";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";

export const dynamic = "force-dynamic";

export default async function PurchaseHistoryPage() {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in to see your purchase history.</p>
          <Link href="/login?next=/purchases" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("id, amount, payment_method, status, purchased_at, listing_id, listings(title, seller_name)")
    .eq("user_id", user.id)
    .order("purchased_at", { ascending: false });

  const { data: disputesData } = await supabase
    .from("disputes")
    .select("purchase_id, status, reason, resolution_note, created_at")
    .eq("buyer_id", user.id);

  const disputeByPurchase = Object.fromEntries((disputesData || []).map((d) => [d.purchase_id, d]));

  const orders = (purchases || []).map((p) => ({
    id: p.id,
    listingId: p.listing_id,
    listingTitle: p.listings?.title || "(listing no longer available)",
    seller: p.listings?.seller_name || "unknown",
    date: p.purchased_at,
    amount: Number(p.amount),
    paymentMethod: p.payment_method,
    status: p.status,
    dispute: disputeByPurchase[p.id] || null,
  }));

  const totalSpent = orders.filter((o) => o.status === "paid").reduce((sum, o) => sum + o.amount, 0);
  const totalRefunded = orders.filter((o) => o.status === "refunded").reduce((sum, o) => sum + o.amount, 0);

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-4xl mx-auto">
        <PurchaseHistoryClient orders={orders} totalSpent={totalSpent} totalRefunded={totalRefunded} />
      </main>
    </div>
  );
}
