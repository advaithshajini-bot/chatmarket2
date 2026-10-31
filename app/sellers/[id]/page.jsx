import Link from "next/link";
import { ArrowLeft, BadgeCheck, Star } from "lucide-react";
import TopNav from "@/components/TopNav";
import ProductCard from "@/components/ProductCard";
import { sellerInitial } from "@/components/SellerCard";
import { createClient } from "@/lib/supabase/server";
import { getSellerPublicProfile, getMostPopularListingIds } from "@/lib/domain/sellers";
import { listProductsBySeller, listProducts } from "@/lib/domain/products";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = (rows) => rows.map((p) => ({ ...p, price: Number(p.price), rating: p.rating !== null && p.rating !== undefined ? Number(p.rating) : null }));

export async function generateMetadata({ params }) {
  if (!UUID_RE.test(params.id)) return { title: "Seller not found — chatmarket" };
  const data = await getSellerPublicProfile(createClient(), params.id);
  return { title: data ? `${data.display_name} — chatmarket creator` : "Seller not found — chatmarket" };
}

export default async function SellerPage({ params }) {
  const supabase = createClient();
  const profile = UUID_RE.test(params.id) ? await getSellerPublicProfile(supabase, params.id) : null;

  if (!profile) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <div className="px-6 py-16 text-center">
          <p style={{ color: "#6B6F76" }}>Seller not found.</p>
          <Link href="/browse" style={{ color: "#14213D" }}>Back to browse</Link>
        </div>
      </div>
    );
  }

  // Their live listings only (RLS already hides everything else from the public), and the platform-wide most popular ones.
  const own = normalize((await listProductsBySeller(supabase, params.id)).filter((p) => p.status === "live"));
  const ids = await getMostPopularListingIds(supabase, 6);
  let popular = [];
  if (ids.length > 0) {
    const live = normalize(await listProducts(supabase, { status: "live", limit: 200 }));
    const byId = new Map(live.map((p) => [p.id, p]));
    popular = ids.map((id) => byId.get(id)).filter(Boolean);
  }

  const joined = profile.joined_at ? new Date(profile.joined_at).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-5xl mx-auto">
        <Link href="/browse" className="flex items-center gap-1.5 text-sm mb-6" style={{ color: "#6B6F76" }}><ArrowLeft size={14} /> Back to browse</Link>

        <header className="flex flex-col sm:flex-row sm:items-center gap-4 mb-10">
          <span className="w-16 h-16 rounded-full flex items-center justify-center text-2xl shrink-0" style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'Fraunces', serif", fontWeight: 600 }} aria-hidden="true">{sellerInitial(profile.display_name)}</span>
          <div className="min-w-0">
            <h1 className="text-3xl flex items-center gap-2 flex-wrap" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {profile.display_name}
              {profile.verified && <span className="inline-flex items-center gap-1 text-xs" style={{ color: "#2F6F62", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}><BadgeCheck size={14} /> Verified seller</span>}
            </h1>
            {profile.bio && <p className="text-sm mt-1" style={{ color: "#3A3D42", lineHeight: 1.6 }}>{profile.bio}</p>}
            <p className="text-xs mt-2 flex items-center gap-4 flex-wrap" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>
              {joined && <span>Joined {joined}</span>}
              <span>{profile.listing_count} playbook{profile.listing_count === 1 ? "" : "s"} listed</span>
              <span>{profile.sales_count} sale{profile.sales_count === 1 ? "" : "s"}</span>
              <span className="flex items-center gap-1"><Star size={12} fill="#E2A83E" color="#E2A83E" />{profile.avg_rating ?? "New"}{profile.review_count ? ` (${profile.review_count})` : ""}</span>
            </p>
          </div>
        </header>

        <section aria-label="Threads by this seller" className="mb-12">
          <h2 className="text-xl mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Threads by this Seller</h2>
          {own.length === 0 ? <p className="text-sm" style={{ color: "#6B6F76" }}>No live listings right now.</p> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{own.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          )}
        </section>

        <section aria-label="Most popular threads">
          <h2 className="text-xl mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Most popular threads</h2>
          {popular.length === 0 ? <p className="text-sm" style={{ color: "#6B6F76" }}>Nothing to recommend yet.</p> : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{popular.map((p) => <ProductCard key={p.id} product={p} />)}</div>
          )}
        </section>
      </main>
    </div>
  );
}
