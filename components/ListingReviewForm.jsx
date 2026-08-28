"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import StarRating from "@/components/StarRating";
import { createClient } from "@/lib/supabase/client";

export default function ListingReviewForm({ listingId, isLoggedIn, existingReview }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(!!existingReview);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!isLoggedIn) {
    return (
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        <Link href={`/login?next=/listing/${listingId}`} style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
          Log in
        </Link>{" "}
        to leave a review.
      </p>
    );
  }

  if (submitted) {
    return (
      <div className="rounded-md p-4 mb-6 flex items-center gap-2 text-sm" style={{ background: "#EAF2EF", color: "#2F6F62" }}>
        <Check size={15} /> Thanks for your review.
      </div>
    );
  }

  const handleSubmit = async () => {
    setSaving(true);
    setError("");

    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();

    // A real purchase gets linked automatically when one exists (powers the
    // "Verified buyer" badge) -- reviewing doesn't require one, but if the
    // reviewer genuinely bought this thread, that's still worth showing.
    const { data: purchase } = await supabase
      .from("purchases")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("listing_id", listingId)
      .maybeSingle();

    const { error: insertError } = await supabase.from("reviews").insert({
      purchase_id: purchase?.id || null,
      user_id: userData.user.id,
      listing_id: listingId,
      rating,
      comment: comment || null,
    });

    if (insertError) {
      setError(insertError.code === "23505" ? "You've already reviewed this listing." : insertError.message);
      setSaving(false);
      return;
    }

    setSubmitted(true);
    setSaving(false);
  };

  return (
    <div className="rounded-md p-4 mb-6" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
      <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
        Write a review
      </p>
      <StarRating value={rating} onChange={setRating} />
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Share your thoughts on this listing (optional)"
        rows={2}
        className="w-full mt-3 px-3 py-2 rounded text-sm outline-none resize-none"
        style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
      />
      {error && <p className="text-xs mt-2" style={{ color: "#B33A2E" }}>{error}</p>}
      <button
        onClick={handleSubmit}
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
  );
}
