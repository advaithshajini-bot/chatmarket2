import Link from "next/link";
import { BadgeCheck, Star } from "lucide-react";
import { BUSINESS } from "@/lib/business";

// Seller summary: avatar initial, name (links to the storefront), short bio, verified badge, rating and sales, and a way to reach support.
// `profile` is the result of public.seller_public_profile(); nothing private is in it.
export function sellerInitial(name) {
  const c = String(name ?? "").trim().charAt(0).toUpperCase();
  return c || "?";
}

export default function SellerCard({ sellerId, profile, fallbackName, listingTitle }) {
  const name = profile?.display_name || fallbackName || "the seller";
  const mail = `mailto:${BUSINESS.email}?subject=${encodeURIComponent(`Question about "${listingTitle ?? "a listing"}"`)}`;
  return (
    <aside aria-label="About the seller" className="rounded-md p-4 mt-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <div className="flex items-center gap-3 mb-3">
        <span className="w-10 h-10 rounded-full flex items-center justify-center text-base shrink-0" style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'Fraunces', serif", fontWeight: 600 }} aria-hidden="true">{sellerInitial(name)}</span>
        <div className="min-w-0">
          <Link href={`/sellers/${sellerId}`} className="text-sm block truncate underline" style={{ color: "#14213D", fontWeight: 600 }}>{name}</Link>
          {profile?.verified && <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: "#2F6F62" }}><BadgeCheck size={12} /> Verified seller</span>}
        </div>
      </div>
      {profile?.bio && <p className="text-xs mb-3" style={{ color: "#3A3D42", lineHeight: 1.6 }}>{profile.bio}</p>}
      <div className="flex items-center gap-4 text-xs mb-3" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>
        <span className="flex items-center gap-1"><Star size={12} fill="#E2A83E" color="#E2A83E" />{profile?.avg_rating ?? "New"}{profile?.review_count ? ` (${profile.review_count})` : ""}</span>
        <span>{profile?.sales_count ?? 0} sale{profile?.sales_count === 1 ? "" : "s"}</span>
      </div>
      <div className="flex items-center justify-between text-xs">
        <Link href={`/sellers/${sellerId}`} className="underline" style={{ color: "#14213D" }}>View all by this seller</Link>
        <a href={mail} className="underline" style={{ color: "#14213D" }}>Contact support</a>
      </div>
    </aside>
  );
}
