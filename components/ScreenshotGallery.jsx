"use client";

import { useEffect, useState } from "react";

// Output screenshots: one large image with thumbnails; clicking the large image opens a full-screen lightbox (Esc, arrows and the buttons navigate).
export default function ScreenshotGallery({ screenshots }) {
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const n = screenshots?.length ?? 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowRight") setActive((a) => (a + 1) % n);
      else if (e.key === "ArrowLeft") setActive((a) => (a - 1 + n) % n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, n]);

  if (!screenshots || n === 0) return null;

  return (
    <div className="mb-6">
      <button type="button" onClick={() => setOpen(true)} aria-label="Open screenshot full screen" className="block w-full rounded-md overflow-hidden mb-2 cursor-zoom-in" style={{ border: "1px solid #D8D5C9", background: "#F7F7F4" }}>
        <img src={screenshots[active]} alt={`Output screenshot ${active + 1}`} className="w-full object-cover" style={{ maxHeight: 340 }} />
      </button>
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          {active + 1} of {n} — click to enlarge
        </span>
        <div className="flex items-center gap-1.5">
          {screenshots.map((_, i) => (
            <button key={i} onClick={() => setActive(i)} className="rounded-full" style={{ width: 6, height: 6, background: i === active ? "#14213D" : "#D8D5C9" }} aria-label={`Show screenshot ${i + 1}`} />
          ))}
        </div>
      </div>
      {n > 1 && (
        <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
          {screenshots.map((url, i) => (
            <button key={i} onClick={() => setActive(i)} className="shrink-0 rounded overflow-hidden" style={{ width: 56, height: 56, border: i === active ? "2px solid #14213D" : "1px solid #D8D5C9" }}>
              <img src={url} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Screenshot viewer" className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(10,16,30,0.92)" }} onClick={() => setOpen(false)}>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute top-4 right-4 text-2xl" style={{ color: "#FFFFFF" }}>×</button>
          {n > 1 && <button type="button" onClick={(e) => { e.stopPropagation(); setActive((a) => (a - 1 + n) % n); }} aria-label="Previous screenshot" className="absolute left-3 text-3xl px-2" style={{ color: "#FFFFFF" }}>‹</button>}
          <img src={screenshots[active]} alt={`Output screenshot ${active + 1} of ${n}`} className="max-w-full max-h-full object-contain" onClick={(e) => e.stopPropagation()} />
          {n > 1 && <button type="button" onClick={(e) => { e.stopPropagation(); setActive((a) => (a + 1) % n); }} aria-label="Next screenshot" className="absolute right-3 text-3xl px-2" style={{ color: "#FFFFFF" }}>›</button>}
          <span className="absolute bottom-4 text-xs" style={{ color: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}>{active + 1} / {n}</span>
        </div>
      )}
    </div>
  );
}
