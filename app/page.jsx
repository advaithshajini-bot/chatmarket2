import LandingClient from "@/components/LandingClient";
import { CATEGORIES } from "@/lib/categories";
import { createClient } from "@/lib/supabase/server";
import { listProductsCurated } from "@/lib/domain/products";

// Always hit Supabase fresh — these are the real numbers people land on,
// not a build-time snapshot.
export const dynamic = "force-dynamic";

function normalize(products) {
  return products.map((p) => ({
    ...p,
    price: Number(p.price),
    rating: p.rating !== null && p.rating !== undefined ? Number(p.rating) : null,
  }));
}

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

  // Phase 2 — first real callers of the Phase 1 domain layer on the
  // homepage. All three currently return only product_type='playbook'
  // rows (the only kind that exists in production), which is expected and
  // correct — these sections render Workflow/Agent cards the moment any
  // exist, with no code change needed later.
  // Each section has its own query (see listProductsCurated): Featured = most reviews, Popular = most paid purchases, New = newest.
  const [featured, popular, newest] = await Promise.all([
    listProductsCurated(supabase, "featured", { limit: 6 }),
    listProductsCurated(supabase, "popular", { limit: 6 }),
    listProductsCurated(supabase, "new", { limit: 6 }),
  ]);

  const featuredProducts = normalize(featured);
  const popularProducts = normalize(popular);
  const newProducts = normalize(newest);

  return (
    <LandingClient
      categoryCounts={categoryCounts}
      featuredProducts={featuredProducts}
      popularProducts={popularProducts}
      newProducts={newProducts}
    />
  );
}
