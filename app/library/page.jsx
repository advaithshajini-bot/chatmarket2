import Link from "next/link";
import { Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import LibraryClient from "@/components/LibraryClient";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in to see your library.</p>
          <Link href="/login?next=/library" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("id, amount, purchased_at, status, listings(*)")
    .eq("user_id", userData.user.id)
    .order("purchased_at", { ascending: false });

  const { data: reviews } = await supabase
    .from("reviews")
    .select("purchase_id, rating")
    .eq("user_id", userData.user.id);

  const reviewMap = new Map((reviews || []).map((r) => [r.purchase_id, r.rating]));

  const items = (purchases || [])
    .filter((p) => p.listings)
    .map((p) => ({
      purchaseId: p.id,
      purchasedAt: p.purchased_at,
      status: p.status,
      rated: reviewMap.has(p.id),
      myRating: reviewMap.get(p.id) || 0,
      listing: { ...p.listings, price: Number(p.listings.price) },
    }));

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-5xl mx-auto">
        <LibraryClient items={items} />
      </main>
    </div>
  );
}
