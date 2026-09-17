import Link from "next/link";
import { ArrowLeft, Lock, MessageSquare, Star } from "lucide-react";
import TopNav from "@/components/TopNav";
import ModelTag from "@/components/ModelTag";
import ProductTypeBadge from "@/components/ProductTypeBadge";
import ListingCheckout from "@/components/ListingCheckout";
import ScreenshotGallery from "@/components/ScreenshotGallery";
import ReviewsSection from "@/components/ReviewsSection";
import ListingReviewForm from "@/components/ListingReviewForm";
import WorkflowAgentDetail from "@/components/WorkflowAgentDetail";
import { createClient } from "@/lib/supabase/server";
import { getProduct } from "@/lib/domain/products";
import { listProductTools } from "@/lib/domain/productTools";
import { listProductPermissions } from "@/lib/domain/productPermissions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const supabase = createClient();
  const product = await getProduct(supabase, params.id);
  if (!product) return { title: "Listing not found — chatmarket" };

  const typeLabel = product.type ? product.type[0].toUpperCase() + product.type.slice(1) : "Playbook";
  const description = (product.description || "").slice(0, 155);

  return {
    title: `${product.title} — chatmarket`,
    description,
    openGraph: {
      title: `${product.title} · ${typeLabel} — chatmarket`,
      description,
    },
  };
}

export default async function ListingDetailPage({ params }) {
  const supabase = createClient();
  const product = await getProduct(supabase, params.id);

  if (!product) {
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

  // Reviews and the current user's own review are the same, generic,
  // product-type-independent logic for every listing -- unchanged from
  // before Phase 2, just fetched once here rather than duplicated in both
  // the Playbook body below and WorkflowAgentDetail.
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

  // Workflow/Agent: new, display-only layout. No execute/run button
  // anywhere -- the purchase CTA is the only action, same as a Playbook.
  if (!product.isPlaybook) {
    const [tools, permissions] = await Promise.all([
      listProductTools(supabase, product.id),
      listProductPermissions(supabase, product.id),
    ]);

    return (
      <WorkflowAgentDetail
        product={product}
        tools={tools}
        permissions={permissions}
        reviews={reviews}
        isLoggedIn={!!userData.user}
        existingReview={existingReview}
      />
    );
  }

  // Playbook: the existing, working, tested experience -- rendered
  // unchanged below. `listing` is reconstructed here in the exact shape
  // that JSX already expects (lib/domain's toProduct() deliberately nests
  // these fields under legacyPlaybookFields rather than flattening them;
  // rebuilding the flat shape here means the render logic itself doesn't
  // need to change at all).
  const listing = {
    id: product.id,
    title: product.title,
    description: product.description,
    category: product.category,
    price: Number(product.price),
    status: product.status,
    rating: product.rating !== null && product.rating !== undefined ? Number(product.rating) : null,
    reviews: product.reviewCount,
    seller_id: product.sellerId,
    seller_name: product.sellerName,
    thread: product.legacyPlaybookFields.thread,
    preview: product.legacyPlaybookFields.preview,
    screenshots: product.legacyPlaybookFields.screenshots,
    output_zip_path: product.legacyPlaybookFields.outputZipPath,
    zip_contents: product.legacyPlaybookFields.zipContentsNote,
    messages: product.legacyPlaybookFields.messages,
    completion: product.legacyPlaybookFields.completion,
    model: product.legacyPlaybookFields.model,
  };
  // Always exactly the seller's first 2 uploaded messages — .slice(0, 2)
  // here is a safety net so the locked box never shows more than that,
  // even if a listing's stored `preview` ever ends up longer.
  const preview = (listing.preview && listing.preview.length ? listing.preview : (listing.thread || [])).slice(0, 2);

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
          {/* Order below is mobile-specific (per request): Title → gallery →
              locked-message preview → payment → description → reviews.
              At sm (640px, this app's established mobile cutoff — same one
              MobileTabBar/TopNav use) and up, order/placement resets to the
              original layout: title, description, gallery, locked preview,
              reviews in a 2/3-width column; payment as a separate sidebar
              column. Kept as one instance each of ListingCheckout and
              ListingReviewForm (both stateful) repositioned via CSS, rather
              than duplicating them per breakpoint. */}

          <div className="order-1 sm:order-none lg:col-start-1 lg:col-span-2 lg:row-start-1">
            <div className="flex items-center gap-2 mb-3">
              <ProductTypeBadge type={product.type} />
              <ModelTag model={listing.model} />
            </div>
            <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
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
            </div>
          </div>

          <div className="order-2 sm:order-none lg:col-start-1 lg:col-span-2 lg:row-start-4">
            <ScreenshotGallery screenshots={listing.screenshots} />
          </div>

          <div className="order-3 sm:order-none lg:col-start-1 lg:col-span-2 lg:row-start-2">
            <div className="rounded-md p-5 relative overflow-hidden" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
              <div className="space-y-3">
                {preview.map((m, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <MessageSquare size={14} className="mt-1 shrink-0" color="#6B6F76" />
                    <div
                      className="text-sm px-3 py-2 rounded line-clamp-2"
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
          </div>

          <div className="order-4 sm:order-none lg:col-start-3 lg:row-start-1 lg:row-span-5">
            <ListingCheckout listing={listing} />
          </div>

          <div className="order-5 sm:order-none lg:col-start-1 lg:col-span-2 lg:row-start-3">
            <h2 className="text-lg mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>What's included</h2>
            <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
              <p className="text-sm" style={{ color: "#3A3D42" }}>{listing.description}</p>
            </div>
          </div>

          <div className="order-6 sm:order-none lg:col-start-1 lg:col-span-2 lg:row-start-5">
            <ReviewsSection reviews={reviews} reviewForm={<ListingReviewForm listingId={listing.id} isLoggedIn={!!userData.user} existingReview={existingReview} />} />
          </div>
        </div>
      </main>
    </div>
  );
}
