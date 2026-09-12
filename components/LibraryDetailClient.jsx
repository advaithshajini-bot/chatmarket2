"use client";

import { useState } from "react";
import { Unlock, Check, MessageSquare, FileArchive } from "lucide-react";
import ModelTag from "@/components/ModelTag";
import StarRating from "@/components/StarRating";
import { createClient } from "@/lib/supabase/client";

const LIBRARY_DISPLAY_LIMIT = 6;

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

  const thread = listing.thread && listing.thread.length ? listing.thread : listing.preview || [];
  // Display is capped for readability only -- Download below always uses
  // the full uploaded zip, never this truncated preview.
  const displayThread = thread.slice(0, LIBRARY_DISPLAY_LIMIT);
  const hiddenCount = Math.max(thread.length - displayThread.length, 0);

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
          Bought from {listing.seller_name} · {formatDate(purchase.purchased_at)}
        </p>

        {purchase.status === "refunded" && (
          <div className="rounded-md p-3 mb-4 text-xs" style={{ background: "#FBEAE8", color: "#B33A2E" }}>
            This purchase was refunded. You can still view the thread below.
          </div>
        )}

        <div className="rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="space-y-3">
            {displayThread.map((m, i) => (
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
          </div>
          <div className="flex items-center gap-1.5 mt-4 pt-3 text-xs" style={{ borderTop: "1px dashed #D8D5C9", color: "#2F6F62" }}>
            <Unlock size={12} />
            {hiddenCount > 0
              ? `Showing ${displayThread.length} of ${thread.length} messages — download the full zip for everything`
              : "Full thread — nothing hidden"}
          </div>
        </div>

        {!submitted ? (
          <div className="rounded-md p-5 mt-5" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
            <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              How was this thread?
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
        <div className="rounded-md p-5 sticky top-20" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-3">
            <FileArchive size={15} color="#E2A83E" />
            <p className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              Your files
            </p>
          </div>
          <p className="text-xs mb-4" style={{ color: "#6B6F76" }}>
            Download everything the seller uploaded — the conversation plus whatever it produced.
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
      </div>
    </div>
  );
}
