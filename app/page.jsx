import LandingClient from "@/components/LandingClient";
import { CATEGORIES } from "@/lib/categories";
import { createClient } from "@/lib/supabase/server";
import { listProducts } from "@/lib/domain/products";

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
  const [featured, popular, newest] = await Promise.all([
    listProducts(supabase, { status: "live", limit: 6 }),
    listProducts(supabase, { status: "live", limit: 6 }),
    listProducts(supabase, { status: "live", limit: 6 }),
  ]);

  const featuredProducts = normalize(featured);
  const popularProducts = [...normalize(popular)].sort(
    (a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0) || (b.rating ?? 0) - (a.rating ?? 0)
  );
  const newProducts = [...normalize(newest)].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  return (
    <LandingClient
      categoryCounts={categoryCounts}
      featuredProducts={featuredProducts}
      popularProducts={popularProducts}
      newProducts={newProducts}
    />
  );
}
