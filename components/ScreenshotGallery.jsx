"use client";

import { useState } from "react";

export default function ScreenshotGallery({ screenshots }) {
  const [active, setActive] = useState(0);
  if (!screenshots || screenshots.length === 0) return null;

  return (
    <div className="mb-6">
      <div className="rounded-md overflow-hidden mb-2" style={{ border: "1px solid #D8D5C9", background: "#F7F7F4" }}>
        <img src={screenshots[active]} alt={`Output screenshot ${active + 1}`} className="w-full object-cover" style={{ maxHeight: 340 }} />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          {active + 1} of {screenshots.length} — swipe for output screenshots
        </span>
        <div className="flex items-center gap-1.5">
          {screenshots.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className="rounded-full"
              style={{ width: 6, height: 6, background: i === active ? "#14213D" : "#D8D5C9" }}
              aria-label={`Show screenshot ${i + 1}`}
            />
          ))}
        </div>
      </div>
      {screenshots.length > 1 && (
        <div className="flex gap-2 mt-2 overflow-x-auto pb-1">
          {screenshots.map((url, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className="shrink-0 rounded overflow-hidden"
              style={{ width: 56, height: 56, border: i === active ? "2px solid #14213D" : "1px solid #D8D5C9" }}
            >
              <img src={url} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
