import Link from "next/link";
import { Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import SellerEarningsClient from "@/components/SellerEarningsClient";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PCT } from "@/lib/constants";

export const dynamic = "force-dynamic";

function weekBucketStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as week start
  const monday = new Date(d.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
}

export default async function EarningsPage() {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in to see your earnings.</p>
          <Link href="/login?next=/sell/earnings" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  // listings!inner filters purchases down to only this seller's listings —
  // this only works because of the "Sellers can view purchases of their own
  // listings" RLS policy (backed by a SECURITY DEFINER helper to avoid the
  // listings/purchases cross-reference recursion — see docs/supabase-schema.sql).
  const { data: rows, error } = await supabase
    .from("purchases")
    .select("id, amount, payment_method, status, purchased_at, user_id, listings!inner(id, title, seller_id)")
    .eq("listings.seller_id", userData.user.id)
    .order("purchased_at", { ascending: false });

  const purchases = rows || [];

  const buyerIds = [...new Set(purchases.map((p) => p.user_id))];
  let buyerNames = {};
  if (buyerIds.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, display_name").in("id", buyerIds);
    buyerNames = Object.fromEntries((profiles || []).map((p) => [p.id, p.display_name]));
  }

  const paid = purchases.filter((p) => p.status === "paid");
  const refunded = purchases.filter((p) => p.status === "refunded");

  const grossEarnings = paid.reduce((sum, p) => sum + Number(p.amount), 0);
  const platformFee = grossEarnings * PLATFORM_FEE_PCT;
  const netEarnings = grossEarnings - platformFee;
  const refundedTotal = refunded.reduce((sum, p) => sum + Number(p.amount), 0);

  // Last 8 weeks of net earnings, bucketed by week.
  const now = new Date();
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weeks.push(weekBucketStart(d));
  }
  const weekTotals = Object.fromEntries(weeks.map((w) => [w, 0]));
  paid.forEach((p) => {
    const bucket = weekBucketStart(p.purchased_at);
    if (bucket in weekTotals) {
      weekTotals[bucket] += Number(p.amount) * (1 - PLATFORM_FEE_PCT);
    }
  });
  const weeklyEarnings = weeks.map((w, i) => ({ week: `Wk ${i + 1}`, amount: Math.round(weekTotals[w]) }));

  const transactions = purchases.map((p) => ({
    id: p.id,
    listing: p.listings?.title || "(listing removed)",
    buyer: buyerNames[p.user_id] || "buyer",
    amount: Number(p.amount),
    platformFee: Math.round(Number(p.amount) * PLATFORM_FEE_PCT),
    net: Math.round(Number(p.amount) * (1 - PLATFORM_FEE_PCT)),
    status: p.status,
    date: p.purchased_at,
    paymentMethod: p.payment_method,
  }));

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-4xl mx-auto">
        {error && <p className="text-sm mb-4" style={{ color: "#B33A2E" }}>Couldn't load earnings: {error.message}</p>}
        <SellerEarningsClient
          grossEarnings={grossEarnings}
          netEarnings={netEarnings}
          refundedTotal={refundedTotal}
          weeklyEarnings={weeklyEarnings}
          transactions={transactions}
        />
      </main>
    </div>
  );
}
