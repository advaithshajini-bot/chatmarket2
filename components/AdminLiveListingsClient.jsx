"use client";

import { useState } from "react";
import { Trash2, X } from "lucide-react";
import ModelTag from "@/components/ModelTag";
import { createClient } from "@/lib/supabase/client";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function AdminLiveListingsClient({ initialListings }) {
  const [listings, setListings] = useState(initialListings);
  const [removingId, setRemovingId] = useState(null);
  const [reason, setReason] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const handleRemove = async (id) => {
    if (!reason.trim()) {
      setError("Give the seller a reason for the removal.");
      return;
    }
    setBusyId(id);
    setError("");

    const supabase = createClient();
    const { data: updated, error: updateError } = await supabase
      .from("listings")
      .update({ status: "removed", removal_reason: reason.trim(), removed_at: new Date().toISOString() })
      .eq("id", id)
      .select("id");

    if (updateError) {
      setError(updateError.message);
      setBusyId(null);
      return;
    }
    if (!updated || updated.length === 0) {
      setError("That change didn't go through — check that your admin session is verified and try again.");
      setBusyId(null);
      return;
    }

    setListings((prev) => prev.filter((l) => l.id !== id));
    setRemovingId(null);
    setReason("");
    setBusyId(null);
    showToast("Listing removed — seller notified on their dashboard");
  };

  if (listings.length === 0) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>No live listings.</p>;
  }

  return (
    <div className="space-y-2 relative">
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2.5 rounded-md text-sm z-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
          {toast}
        </div>
      )}
      {listings.map((l) => (
        <div key={l.id} className="rounded-md p-3" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <ModelTag model={l.model} />
                <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  {l.title}
                </p>
              </div>
              <p className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>
                {l.seller_name} · {l.category} · ₹{l.price} · listed {formatDate(l.created_at)}
              </p>
            </div>
            {removingId !== l.id && (
              <button
                onClick={() => { setRemovingId(l.id); setReason(""); setError(""); }}
                className="shrink-0 px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                style={{ border: "1px solid #F0C4BE", color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif" }}
              >
                <Trash2 size={12} /> Remove
              </button>
            )}
          </div>

          {removingId === l.id && (
            <div className="mt-3 pt-3" style={{ borderTop: "1px dashed #D8D5C9" }}>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Reason for removing this listing (shown to the seller)..."
                rows={3}
                className="w-full text-xs p-2 rounded outline-none resize-none mb-2"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", background: "#FFFFFF" }}
              />
              {error && <p className="text-xs mb-2" style={{ color: "#B33A2E" }}>{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleRemove(l.id)}
                  disabled={busyId === l.id}
                  className="px-3 py-1.5 rounded text-xs"
                  style={{ background: "#B33A2E", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
                >
                  {busyId === l.id ? "Removing..." : "Confirm removal"}
                </button>
                <button
                  onClick={() => { setRemovingId(null); setError(""); }}
                  disabled={busyId === l.id}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1"
                  style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
                >
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
