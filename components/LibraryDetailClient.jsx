"use client";

import { useState } from "react";
import { Check, FileArchive } from "lucide-react";
import ModelTag from "@/components/ModelTag";
import StarRating from "@/components/StarRating";
import ScreenshotGallery from "@/components/ScreenshotGallery";
import ListingVideoCard from "@/components/ListingVideoCard";
import BlueprintDownloadCard from "@/components/BlueprintDownloadCard";
import { createClient } from "@/lib/supabase/client";
import { publicSellerName } from "@/lib/domain/public-name";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function LibraryDetailClient({ listing, purchase, existingReview }) {
  const [rating, setRating] = useState(existingReview?.rating || 0);
  const [reviewText, setReviewText] = useState(existingReview?.comment || "");
  const [submitted, setSubmitted] = useState(!!existingReview);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState(false);

  // Workflow / agent purchases are a downloadable blueprint, not a conversation thread: they get the blueprint
  // card instead of the thread preview and the ZIP card. Playbook purchases render exactly as before.
  const isBlueprintProduct = listing.product_type === "workflow" || listing.product_type === "agent";
  const handleDownloadZip = async () => {
    if (!listing.output_zip_path) {
      setDownloadError("No file was found for this listing — contact support from your Purchases page.");
      return;
    }
    setDownloading(true);
    setDownloadError("");
    const supabase = createClient();
    const { data, error: signError } = await supabase.storage
      .from("listing-files")
      .createSignedUrl(listing.output_zip_path, 60);
    setDownloading(false);
    if (signError || !data) {
      setDownloadError("Couldn't generate a download link — try again in a moment.");
      return;
    }
    window.location.href = data.signedUrl;
  };

  const handleSubmitReview = async () => {
    setSaving(true);
    setError("");
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();

    const { error: insertError } = await supabase.from("reviews").insert({
      purchase_id: purchase.id,
      user_id: userData.user.id,
      listing_id: listing.id,
      rating,
      comment: reviewText || null,
    });

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    setSubmitted(true);
    setSaving(false);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2">
        <ModelTag model={listing.model} />
        <h1 className="text-3xl mt-3 mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          {listing.title}
        </h1>
        <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
          Bought from {publicSellerName(listing.seller_name)} · {formatDate(purchase.purchased_at)}
        </p>

        {purchase.status === "refunded" && (
          <div className="rounded-md p-3 mb-4 text-xs" style={{ background: "#FBEAE8", color: "#B33A2E" }}>
            This purchase was refunded. {isBlueprintProduct ? "Blueprint downloads are no longer available." : "You can still view the listing details below."}
          </div>
        )}

        {/* Same presentation as the public listing page: demo video, output screenshots, description, zip contents. The raw prompts are never shown here; they are inside the downloadable files. */}
        {!isBlueprintProduct && listing.preview_video_url && (
          <div className="mb-5">
            <ListingVideoCard videoUrl={listing.preview_video_url} duration={listing.preview_video_duration == null ? null : Number(listing.preview_video_duration)} poster={listing.screenshots?.[0]} title={listing.title} controls />
          </div>
        )}
        {!isBlueprintProduct && listing.screenshots?.length > 0 && (
          <div className="mb-5"><ScreenshotGallery screenshots={listing.screenshots} /></div>
        )}
        <div className="rounded-md p-5 text-sm" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9", color: "#3A3D42" }}>
          <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>About this {isBlueprintProduct ? "blueprint" : "playbook"}</p>
          <p style={{ whiteSpace: "pre-line" }}>{listing.description}</p>
        </div>
        {!isBlueprintProduct && listing.zip_contents?.trim() && (
          <div className="rounded-md p-5 text-sm mt-4" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", color: "#3A3D42" }}>
            <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>What&apos;s in the zip</p>
            <p style={{ whiteSpace: "pre-line" }}>{listing.zip_contents}</p>
          </div>
        )}

        {!submitted ? (
          <div className="rounded-md p-5 mt-5" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
            <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              How was this {isBlueprintProduct ? "blueprint" : "thread"}?
            </p>
            <StarRating value={rating} onChange={setRating} />
            <textarea
              value={reviewText}
              onChange={(e) => setReviewText(e.target.value)}
              placeholder="Did it deliver what the listing promised? (optional)"
              rows={2}
              className="w-full mt-3 px-3 py-2 rounded text-sm outline-none resize-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            />
            {error && <p className="text-xs mt-2" style={{ color: "#B33A2E" }}>{error}</p>}
            <button
              onClick={handleSubmitReview}
              disabled={rating === 0 || saving}
              className="mt-3 px-4 py-2 rounded text-xs"
              style={{
                background: rating === 0 ? "#D8D5C9" : "#14213D",
                color: "#F7F7F4",
                fontFamily: "'IBM Plex Sans', sans-serif",
                fontWeight: 500,
              }}
          >
            {saving ? "Submitting..." : "Submit review"}
            </button>
          </div>
        ) : (
          <div className="rounded-md p-4 mt-5 flex items-center gap-2 text-sm" style={{ background: "#EAF2EF", color: "#2F6F62" }}>
            <Check size={15} /> Thanks — your rating helps other buyers.
          </div>
        )}
      </div>

      <div>
        {isBlueprintProduct ? (
          <BlueprintDownloadCard listing={listing} refunded={purchase.status === "refunded"} />
        ) : (
        <div className="rounded-md p-5 sticky top-20" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-3">
            <FileArchive size={15} color="#E2A83E" />
            <p className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              Your files
            </p>
          </div>
          <p className="text-xs mb-4" style={{ color: "#6B6F76" }}>
            Download everything the seller uploaded: the prompts, project files and whatever they produced.
          </p>
          <button
            onClick={handleDownloadZip}
            disabled={downloading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
          >
            <FileArchive size={14} /> {downloading ? "Preparing download…" : "Download files (.zip)"}
          </button>
          {downloadError && <p className="text-xs mt-2" style={{ color: "#B33A2E" }}>{downloadError}</p>}
        </div>
        )}
      </div>
    </div>
  );
}
