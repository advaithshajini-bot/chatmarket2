import Link from "next/link";
import { ArrowLeft, Lock, MessageSquare, Star } from "lucide-react";
import TopNav from "@/components/TopNav";
import ModelTag from "@/components/ModelTag";
import ListingCheckout from "@/components/ListingCheckout";
import ScreenshotGallery from "@/components/ScreenshotGallery";
import ReviewsSection from "@/components/ReviewsSection";
import ListingReviewForm from "@/components/ListingReviewForm";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ListingDetailPage({ params }) {
  const supabase = createClient();
  const { data: listingRow } = await supabase
    .from("listings")
    .select("*")
    .eq("id", params.id)
    .single();

  if (!listingRow) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <div className="px-6 py-16 text-center">
          <p style={{ color: "#6B6F76" }}>Listing not found.</p>
          <Link href="/browse" style={{ color: "#14213D" }}>Back to browse</Link>
        </div>
      </div>
    );
  }

  const listing = {
    ...listingRow,
    price: Number(listingRow.price),
    rating: listingRow.rating !== null ? Number(listingRow.rating) : null,
  };
  const preview = listing.preview && listing.preview.length ? listing.preview : (listing.thread || []).slice(0, 2);

  const { data: reviewRows } = await supabase
    .from("reviews")
    .select("id, rating, comment, created_at, user_id, purchase_id")
    .eq("listing_id", params.id)
    .order("created_at", { ascending: false });

  const reviewerIds = [...new Set((reviewRows || []).map((r) => r.user_id))];
  let reviewerNames = {};
  if (reviewerIds.length > 0) {
    const { data: reviewerProfiles } = await supabase.from("profiles").select("id, display_name").in("id", reviewerIds);
    reviewerNames = Object.fromEntries((reviewerProfiles || []).map((p) => [p.id, p.display_name]));
  }

  const reviews = (reviewRows || []).map((r) => ({
    ...r,
    reviewerName: reviewerNames[r.user_id] || "Anonymous buyer",
  }));

  const { data: userData } = await supabase.auth.getUser();
  const existingReview = userData.user ? reviews.find((r) => r.user_id === userData.user.id) : null;

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-5xl mx-auto">
        <Link
          href="/browse"
          className="flex items-center gap-1.5 text-sm mb-6"
          style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <ArrowLeft size={14} /> Back to browse
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <ModelTag model={listing.model} />
            <h1 className="text-3xl mt-3 mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {listing.title}
            </h1>
            <div className="flex items-center gap-3 mb-6 text-sm" style={{ color: "#6B6F76" }}>
              <span className="flex items-center gap-1">
                <Star size={13} fill="#E2A83E" color="#E2A83E" />
                {reviews.length > 0 ? (
                  <a href="#reviews" style={{ color: "#6B6F76", textDecoration: "underline" }}>
                    {listing.rating ?? "New"} ({reviews.length} review{reviews.length === 1 ? "" : "s"})
                  </a>
                ) : (
                  <span>{listing.rating ?? "New"}</span>
                )}
              </span>
              <span>·</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{listing.messages} messages</span>
              <span>·</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{listing.completion}% complete</span>
            </div>
            <p className="text-sm mb-6" style={{ color: "#3A3D42" }}>{listing.description}</p>

            <ScreenshotGallery screenshots={listing.screenshots} />

            <div className="rounded-md p-5 relative overflow-hidden" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
              <div className="space-y-3">
                {preview.map((m, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <MessageSquare size={14} className="mt-1 shrink-0" color="#6B6F76" />
                    <div
                      className="text-sm px-3 py-2 rounded"
                      style={{
                        fontFamily: "'IBM Plex Sans', sans-serif",
                        background: m.who === "user" ? "#EDEEEA" : "#FFFFFF",
                        border: "1px solid #E4E2D8",
                        color: "#3A3D42",
                      }}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
                {[1, 2, 3].map((n) => (
                  <div key={n} className="flex gap-2 items-start" style={{ opacity: 0.35 - n * 0.08 }}>
                    <MessageSquare size={14} className="mt-1 shrink-0" color="#6B6F76" />
                    <div className="text-sm px-3 py-2 rounded w-full" style={{ background: "#EDEEEA", border: "1px solid #E4E2D8", height: 32 }} />
                  </div>
                ))}
              </div>

              <div
                className="absolute inset-x-0 bottom-0 h-28 flex items-end justify-center pb-4"
                style={{ background: "linear-gradient(to bottom, rgba(247,247,244,0), rgba(247,247,244,0.97))" }}
              >
                <div
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
                  style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Mono', monospace" }}
                >
                  <Lock size={12} /> {Math.max(listing.messages - preview.length, 0)} more messages locked
                </div>
              </div>
            </div>

            <ReviewsSection reviews={reviews} reviewForm={<ListingReviewForm listingId={listing.id} isLoggedIn={!!userData.user} existingReview={existingReview} />} />
          </div>

          <div>
            <ListingCheckout listing={listing} />
          </div>
        </div>
      </main>
    </div>
  );
}
