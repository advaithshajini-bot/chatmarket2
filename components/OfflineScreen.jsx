"use client";

import { useEffect, useState } from "react";
import { WifiOff, RotateCw } from "lucide-react";

export default function OfflineScreen() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(typeof navigator !== "undefined" && !navigator.onLine);

    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-6"
      style={{ background: "#EDEEEA" }}
    >
      <div className="text-center max-w-xs">
        <WifiOff size={28} color="#6B6F76" className="mx-auto mb-4" />
        <h1 className="text-xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          No internet connection
        </h1>
        <p className="text-sm mb-6" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Check your connection — chatmarket will come back as soon as you're back online.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded text-sm"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
        >
          <RotateCw size={14} /> Try again
        </button>
      </div>
    </div>
  );
}
