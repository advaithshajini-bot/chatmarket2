import LandingClient from "@/components/LandingClient";
import { CATEGORIES } from "@/lib/categories";
import { PLATFORM_FEE_PCT } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";

// Always hit Supabase fresh — these are the real numbers people land on,
// not a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = createClient();

  // Category counts read straight from listings (already public — "live"
  // listings are publicly readable), but threads-sold/paid-out/rating come
  // from a SECURITY DEFINER RPC instead of querying purchases/reviews
  // directly. purchases has no public or platform-wide SELECT policy at
  // all (only "your own" / "sales of your own listings"), so a direct
  // query would show zero to a logged-out visitor and an incomplete,
  // personal-only number to a logged-in non-admin buyer — different
  // numbers for different people, which is exactly what this page needs
  // to not do. The RPC returns only the aggregate totals, never row-level
  // purchase/review data, so it's safe to expose to anyone.
  const [{ data: liveListings }, { data: statsRows }] = await Promise.all([
    supabase.from("listings").select("category").eq("status", "live"),
    supabase.rpc("get_platform_stats"),
  ]);

  const categoryCounts = CATEGORIES.map((name) => ({
    name,
    count: (liveListings || []).filter((l) => l.category === name).length,
  }));

  const stats = statsRows?.[0] || { threads_sold: 0, gross_paid: 0, review_count: 0, avg_rating: 0 };
  const threadsSold = Number(stats.threads_sold);
  const netPaidRupees = Number(stats.gross_paid) * (1 - PLATFORM_FEE_PCT);
  const reviewCount = Number(stats.review_count);
  const avgRating = Number(stats.avg_rating);

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
