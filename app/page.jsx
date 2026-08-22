import LandingClient from "@/components/LandingClient";
import { CATEGORIES } from "@/lib/categories";
import { PLATFORM_FEE_PCT } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";

// Always hit Supabase fresh — these are the real numbers people land on,
// not a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = createClient();

  const [{ data: liveListings }, { data: purchases }, { data: reviews }] = await Promise.all([
    supabase.from("listings").select("category").eq("status", "live"),
    supabase.from("purchases").select("amount, status"),
    supabase.from("reviews").select("rating"),
  ]);

  const categoryCounts = CATEGORIES.map((name) => ({
    name,
    count: (liveListings || []).filter((l) => l.category === name).length,
  }));

  const threadsSold = (purchases || []).length;
  const netPaidRupees = (purchases || [])
    .filter((p) => p.status === "paid")
    .reduce((sum, p) => sum + Number(p.amount) * (1 - PLATFORM_FEE_PCT), 0);

  const reviewCount = (reviews || []).length;
  const avgRating = reviewCount > 0 ? (reviews || []).reduce((sum, r) => sum + r.rating, 0) / reviewCount : 0;

  return (
    <LandingClient
      categoryCounts={categoryCounts}
      threadsSold={threadsSold}
      netPaidRupees={Math.round(netPaidRupees)}
      avgRating={avgRating}
      reviewCount={reviewCount}
    />
  );
}
