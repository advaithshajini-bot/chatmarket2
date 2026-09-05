import TopNav from "@/components/TopNav";
import BrowseClient from "@/components/BrowseClient";
import SiteFooter from "@/components/SiteFooter";
import { createClient } from "@/lib/supabase/server";

// Always hit Supabase fresh rather than caching a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function BrowsePage() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("listings")
    .select("*")
    .eq("status", "live")
    .order("created_at", { ascending: false });

  // RLS already restricts this to status = 'live', but the .eq() above keeps
  // the query self-documenting and avoids relying on RLS alone.
  const listings = (data || []).map((l) => ({
    ...l,
    price: Number(l.price),
    rating: l.rating !== null ? Number(l.rating) : null,
  }));

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-6xl mx-auto">
        {error && <p className="text-sm mb-4" style={{ color: "#B33A2E" }}>Couldn't load listings: {error.message}</p>}
        <BrowseClient listings={listings} />
        <SiteFooter />
      </main>
    </div>
  );
}
