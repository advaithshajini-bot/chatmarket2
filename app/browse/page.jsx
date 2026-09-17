import TopNav from "@/components/TopNav";
import BrowseClient from "@/components/BrowseClient";
import { createClient } from "@/lib/supabase/server";
import { listProducts } from "@/lib/domain/products";

// Always hit Supabase fresh rather than caching a build-time snapshot.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Explore AI products for work — chatmarket",
  description:
    "Discover Playbooks, Workflows, and Agents for real business work on chatmarket.",
};

export default async function BrowsePage() {
  const supabase = createClient();
  let products = [];
  let error = null;

  try {
    products = await listProducts(supabase, { status: "live" });
  } catch (e) {
    error = e;
  }

  // listings.price/rating are numeric columns that the Supabase client can
  // return as strings -- cast the same way the pre-Phase-2 direct query did,
  // since lib/domain/products.js's toProduct() intentionally passes values
  // through unchanged rather than coercing types itself.
  const normalized = products.map((p) => ({
    ...p,
    price: Number(p.price),
    rating: p.rating !== null && p.rating !== undefined ? Number(p.rating) : null,
  }));

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-6xl mx-auto">
        {error && (
          <p className="text-sm mb-4" style={{ color: "#B33A2E" }}>
            Couldn't load listings: {error.message}
          </p>
        )}
        <BrowseClient products={normalized} />
      </main>
    </div>
  );
}
