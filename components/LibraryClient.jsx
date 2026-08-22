"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, Unlock, Star, Inbox } from "lucide-react";
import ModelTag from "@/components/ModelTag";

function timeAgo(dateString) {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const days = Math.floor(diffMs / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months > 1 ? "s" : ""} ago`;
}

function LibraryCard({ item }) {
  const { listing, purchaseId, purchasedAt, rated, myRating, status } = item;
  return (
    <Link
      href={`/library/${listing.id}`}
      className="text-left rounded-md overflow-hidden block transition-transform hover:-translate-y-0.5"
      style={{ background: "#F7F7F4", border: "1px solid #D8D5C9", boxShadow: "0 1px 2px rgba(20,33,61,0.06)" }}
    >
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <ModelTag model={listing.model} />
          {status === "refunded" ? (
            <span className="text-xs" style={{ color: "#B33A2E", fontFamily: "'IBM Plex Mono', monospace" }}>refunded</span>
          ) : (
            <span className="flex items-center gap-1 text-xs" style={{ color: "#2F6F62", fontFamily: "'IBM Plex Mono', monospace" }}>
              <Unlock size={11} /> unlocked
            </span>
          )}
        </div>
        <h3 className="text-[16px] leading-snug mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          {listing.title}
        </h3>
        <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>
          by {listing.seller_name} · purchased {timeAgo(purchasedAt)}
        </p>
        <div
          className="flex items-center justify-between text-xs pt-3"
          style={{ borderTop: "1px dashed #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}
        >
          <span>{listing.messages} msgs</span>
          {rated ? (
            <span className="flex items-center gap-1" style={{ color: "#E2A83E" }}>
              <Star size={11} fill="#E2A83E" color="#E2A83E" /> {myRating}.0 rated
            </span>
          ) : (
            <span style={{ color: "#8A6A18" }}>not rated yet</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export default function LibraryClient({ items }) {
  const [query, setQuery] = useState("");

  const filtered = items.filter((x) => x.listing.title.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Your unlocked threads
        </h2>
        <Link href="/purchases" className="text-sm" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          View receipts →
        </Link>
      </div>
      <p className="text-sm mb-5" style={{ color: "#6B6F76" }}>
        {items.length} purchase{items.length !== 1 ? "s" : ""}
      </p>

      <div
        className="flex items-center gap-2 px-3 py-2 rounded-full mb-6"
        style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", maxWidth: 360 }}
      >
        <Search size={14} color="#6B6F76" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your library"
          className="text-sm bg-transparent outline-none w-full"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20">
          <Inbox size={28} color="#6B6F76" className="mb-3" />
          <p className="text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            {items.length === 0 ? "Nothing unlocked yet" : "No matches"}
          </p>
          <p className="text-sm" style={{ color: "#6B6F76" }}>
            {items.length === 0 ? "Threads you buy will show up here." : "Try a different search."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((item) => (
            <LibraryCard key={item.purchaseId} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
