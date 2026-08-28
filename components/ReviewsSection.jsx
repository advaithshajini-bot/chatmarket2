import { Star, User, BadgeCheck } from "lucide-react";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function ReviewStars({ rating }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={13} fill={n <= rating ? "#E2A83E" : "none"} color="#E2A83E" />
      ))}
    </div>
  );
}

export default function ReviewsSection({ reviews, reviewForm }) {
  return (
    <div id="reviews" className="mt-8 scroll-mt-20">
      <h2 className="text-lg mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        Reviews {reviews.length > 0 && <span style={{ color: "#6B6F76", fontWeight: 400 }}>({reviews.length})</span>}
      </h2>

      {reviewForm}

      {reviews.length === 0 ? (
        <p className="text-sm" style={{ color: "#6B6F76" }}>
          No reviews yet — be the first to unlock and rate this thread.
        </p>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: "#EDEEEA", border: "1px solid #D8D5C9" }}
                  >
                    <User size={13} color="#6B6F76" />
                  </div>
                  <span className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, color: "#14213D" }}>
                    {r.reviewerName}
                  </span>
                  {r.purchase_id && (
                    <span
                      className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full"
                      style={{ background: "#EAF2EF", color: "#2F6F62", fontFamily: "'IBM Plex Mono', monospace" }}
                    >
                      <BadgeCheck size={11} /> Verified buyer
                    </span>
                  )}
                </div>
                <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  {formatDate(r.created_at)}
                </span>
              </div>
              <ReviewStars rating={r.rating} />
              {r.comment && (
                <p className="text-sm mt-2" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  {r.comment}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
