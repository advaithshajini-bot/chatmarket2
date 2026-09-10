"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  Trash2,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  ExternalLink,
  FileArchive,
} from "lucide-react";
import ModelTag from "@/components/ModelTag";
import { createClient } from "@/lib/supabase/client";

async function downloadListingZip(zipPath, setError) {
  if (!zipPath) {
    setError("No zip file was uploaded for this listing.");
    return;
  }
  const supabase = createClient();
  const { data, error } = await supabase.storage.from("listing-files").createSignedUrl(zipPath, 60);
  if (error || !data) {
    setError("Couldn't generate a download link — try again in a moment.");
    return;
  }
  window.location.href = data.signedUrl;
}

function timeAgo(dateString) {
  const diffMs = Date.now() - new Date(dateString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function QueueRow({ item, onApprove, onFlag, onRemove, busy }) {
  const [open, setOpen] = useState(false);
  const [showFullThread, setShowFullThread] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const flagged = item.status === "flagged";
  const fullThread = item.thread && item.thread.length ? item.thread : (item.preview || []);
  const preview = item.preview && item.preview.length ? item.preview : fullThread.slice(0, 2);
  const displayedMessages = showFullThread ? fullThread : preview.slice(0, 2);

  return (
    <div style={{ background: "#FFFFFF" }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3.5 gap-4 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          {flagged ? <ShieldAlert size={15} color="#B33A2E" className="shrink-0" /> : <Clock size={15} color="#8A6A18" className="shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", fontWeight: 500 }}>
              {item.title}
            </p>
            <p className="text-xs" style={{ color: "#6B6F76" }}>
              by {item.seller_name} · {item.category} · {timeAgo(item.created_at)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm hidden sm:inline" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            ₹{item.price}
          </span>
          <span
            className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide"
            style={{
              background: flagged ? "#FBEAE8" : "#FBF1DD",
              color: flagged ? "#B33A2E" : "#8A6A18",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {flagged ? "flagged" : "pending"}
          </span>
          {open ? <ChevronUp size={16} color="#6B6F76" /> : <ChevronDown size={16} color="#6B6F76" />}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4" style={{ background: "#FAFAF8" }}>
          <div className="flex items-center gap-2 pt-3 mb-3">
            <ModelTag model={item.model} />
            <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
              {item.messages} msgs · {item.completion}% complete
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Price set by seller</p>
              <p className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>₹{item.price}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Category</p>
              <p className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{item.category}</p>
            </div>
          </div>

          {item.screening_findings && item.screening_findings.length > 0 && (
            <div className="rounded-md p-2.5 mb-3" style={{ background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
              <p className="text-[11px] uppercase tracking-wide mb-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#B33A2E" }}>
                Auto-redacted before saving
              </p>
              {item.screening_findings.map((f) => (
                <p key={f.type} className="text-xs" style={{ color: "#8A342B" }}>
                  {f.count}× {f.type}{f.count === 1 ? "" : "s"}
                </p>
              ))}
            </div>
          )}

          {item.description && (
            <div className="mb-3">
              <p className="text-[10px] uppercase tracking-wide mb-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Description written by seller</p>
              <p className="text-xs" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                {item.description}
              </p>
            </div>
          )}

          <div className="mb-3">
            <button
              onClick={() => downloadListingZip(item.output_zip_path, setDownloadError)}
              className="text-[11px] font-medium inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded"
              style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", border: "1px solid #D8D5C9" }}
            >
              <FileArchive size={12} /> Download uploaded zip
            </button>
            {downloadError && <p className="text-[11px] mt-1" style={{ color: "#B33A2E" }}>{downloadError}</p>}
          </div>

          {displayedMessages.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1.5 flex-wrap gap-y-1.5">
                <p className="text-[10px] uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  {showFullThread ? `Full conversation uploaded by seller (${fullThread.length} messages)` : "Preview shown to buyers"}
                </p>
                {fullThread.length > 2 && (
                  <button
                    onClick={() => setShowFullThread((v) => !v)}
                    className="text-[11px] font-medium"
                    style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
                  >
                    {showFullThread ? "Show preview only" : `Show full thread (${fullThread.length} msgs) →`}
                  </button>
                )}
              </div>
              <div className="space-y-1.5" style={{ maxHeight: showFullThread ? "420px" : "none", overflowY: showFullThread ? "auto" : "visible" }}>
                {displayedMessages.map((m, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <MessageSquare size={12} className="mt-0.5 shrink-0" color="#6B6F76" />
                    <div
                      className="text-xs px-2 py-1.5 rounded"
                      style={{
                        background: m.who === "user" ? "#EDEEEA" : "#FFFFFF",
                        border: "1px solid #E4E2D8",
                        color: "#3A3D42",
                        fontFamily: "'IBM Plex Sans', sans-serif",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center flex-wrap gap-2">
            <button
              onClick={() => onApprove(item.id)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1"
              style={{ background: "#2F6F62", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              <CheckCircle2 size={12} /> Approve & publish
            </button>
            <button
              onClick={() => onFlag(item.id)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1"
              style={{ border: "1.5px solid #8A6A18", color: "#8A6A18", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              <XCircle size={12} /> Send back to seller
            </button>
            <button
              onClick={() => onRemove(item.id)}
              disabled={busy}
              className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1"
              style={{ border: "1.5px solid #B33A2E", color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              <Trash2 size={12} /> Remove
            </button>
            <Link
              href={`/listing/${item.id}`}
              target="_blank"
              className="ml-auto px-3 py-1.5 rounded text-xs inline-flex items-center gap-1"
              style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              View full listing <ExternalLink size={11} />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminQueueClient({ initialQueue }) {
  const [queue, setQueue] = useState(initialQueue);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const updateStatus = async (id, status, successMessage) => {
    setBusyId(id);
    setError("");
    const supabase = createClient();
    const { data: updated, error: updateError } = await supabase
      .from("listings")
      .update({ status })
      .eq("id", id)
      .select("id");

    if (updateError) {
      setError(updateError.message);
      setBusyId(null);
      return;
    }

    // Supabase doesn't error on an update that matches 0 rows (e.g. blocked
    // silently by RLS) — .select() lets us tell "nothing changed" apart from
    // a real success instead of showing a false "published" toast.
    if (!updated || updated.length === 0) {
      setError("That change didn't go through — check that your admin session is verified and try again.");
      setBusyId(null);
      return;
    }

    setQueue((prev) => prev.filter((i) => i.id !== id));
    showToast(successMessage);
    setBusyId(null);
  };

  const handleApprove = (id) => updateStatus(id, "live", "Listing published");
  const handleFlag = (id) => updateStatus(id, "flagged", "Sent back to seller — rejected");
  const handleRemove = (id) => updateStatus(id, "removed", "Listing removed");

  return (
    <div>
      {error && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{error}</p>}

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
        {queue.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>Queue is clear.</p>
        ) : (
          queue.map((item, i) => (
            <div key={item.id} style={{ borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
              <QueueRow item={item} onApprove={handleApprove} onFlag={handleFlag} onRemove={handleRemove} busy={busyId === item.id} />
            </div>
          ))
        )}
      </div>

      {toast && (
        <div
          className="fixed bottom-[88px] sm:bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full text-sm"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
