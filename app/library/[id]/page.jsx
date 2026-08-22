import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import ModelTag from "@/components/ModelTag";
import LibraryDetailClient from "@/components/LibraryDetailClient";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LibraryDetailPage({ params }) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();

  if (!userData.user) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <Lock size={24} color="#6B6F76" className="mx-auto mb-3" />
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You need to log in to view this.</p>
          <Link href={`/login?next=/library/${params.id}`} style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
        </main>
      </div>
    );
  }

  const { data: purchase } = await supabase
    .from("purchases")
    .select("*")
    .eq("user_id", userData.user.id)
    .eq("listing_id", params.id)
    .maybeSingle();

  if (!purchase) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-md mx-auto text-center">
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>You haven't unlocked this thread.</p>
          <Link href={`/listing/${params.id}`} style={{ color: "#14213D", fontWeight: 500 }}>View listing →</Link>
        </main>
      </div>
    );
  }

  const { data: listingRow } = await supabase
    .from("listings")
    .select("*")
    .eq("id", params.id)
    .single();

  const { data: existingReview } = await supabase
    .from("reviews")
    .select("*")
    .eq("purchase_id", purchase.id)
    .maybeSingle();

  const listing = { ...listingRow, price: Number(listingRow.price) };

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-5xl mx-auto">
        <Link
          href="/library"
          className="flex items-center gap-1.5 text-sm mb-6"
          style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <ArrowLeft size={14} /> Back to library
        </Link>
        <LibraryDetailClient listing={listing} purchase={purchase} existingReview={existingReview} />
      </main>
    </div>
  );
}
