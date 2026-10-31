"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import { formatDuration } from "@/lib/domain/listing-rules";

// Preview media for a listing card: a muted video that plays from the start while the pointer is over it and resets when it leaves.
// Touch devices (no hover), a video that fails to load, and listings without a video all fall back to the first screenshot.
// With `controls` it becomes the primary player (listing page): native controls, audio toggle, no hover logic.
export default function ListingVideoCard({ videoUrl, poster, duration, title = "", controls = false, aspect = "16 / 9", className = "" }) {
  const ref = useRef(null);
  const [canHover, setCanHover] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    try { setCanHover(window.matchMedia("(hover: hover) and (pointer: fine)").matches); } catch { setCanHover(false); }
  }, []);

  const showVideo = !!videoUrl && !failed && (controls || canHover);
  const start = () => { const v = ref.current; if (!v) return; v.currentTime = 0; v.muted = true; const p = v.play(); if (p?.catch) p.catch(() => {}); setPlaying(true); };
  const stop = () => { const v = ref.current; if (!v) return; v.pause(); v.currentTime = 0; setPlaying(false); };

  return (
    <div
      className={`relative overflow-hidden rounded-md ${className}`}
      style={{ aspectRatio: aspect, background: "#14213D", border: "1px solid #D8D5C9" }}
      onMouseEnter={!controls && showVideo ? start : undefined}
      onMouseLeave={!controls && showVideo ? stop : undefined}
      data-video-card="true"
    >
      {showVideo ? (
        <video
          ref={ref} src={videoUrl} poster={poster || undefined} muted={!controls} loop={!controls} playsInline controls={controls} preload="metadata"
          className="w-full h-full object-cover" onError={() => setFailed(true)} aria-label={title ? `Preview video: ${title}` : "Preview video"}
        />
      ) : poster ? (
        <img src={poster} alt={title ? `${title} preview` : "Listing preview"} className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-full flex items-center justify-center" style={{ color: "#F7F7F4" }}><Play size={22} /></div>
      )}
      {!controls && videoUrl && !failed && !playing && (
        <span className="absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity" aria-hidden="true">
          <span className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(20,33,61,0.65)", color: "#FFFFFF" }}><Play size={16} fill="#FFFFFF" /></span>
        </span>
      )}
      {!controls && Number.isFinite(duration) && duration > 0 && (
        <span className="absolute bottom-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(20,33,61,0.8)", color: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}>{formatDuration(duration)}</span>
      )}
    </div>
  );
}
