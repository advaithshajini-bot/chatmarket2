import LandingClient from "@/components/LandingClient";
import { CATEGORIES } from "@/lib/categories";
import { createClient } from "@/lib/supabase/server";

// Always hit Supabase fresh — these are the real numbers people land on,
// not a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = createClient();

  // Category counts read straight from listings (already public — "live"
  // listings are publicly readable).
  const { data: liveListings } = await supabase
    .from("listings")
    .select("category")
    .eq("status", "live");

  const categoryCounts = CATEGORIES.map((name) => ({
    name,
    count: (liveListings || []).filter((l) => l.category === name).length,
  }));

  return <LandingClient categoryCounts={categoryCounts} />;
}
