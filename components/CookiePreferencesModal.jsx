"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

// chatmarket sets only the cookies it needs: the sign-in session (Supabase auth) and basic site preferences. There are no analytics,
// social-media or advertising cookies, so there is nothing optional to switch on or off; this panel just says so.
const ITEMS = [
  { title: "Sign-in session", body: "Supabase authentication cookies keep you logged in and keep your session secure. Without them you could not sign in or check out." },
  { title: "Site preferences", body: "Small settings stored in your browser (for example, a dismissed notice) so the site behaves the way you left it." },
  { title: "Payments", body: "When you pay, the payment window of our payment partner sets its own cookies to complete and secure the payment. See the payment partner's privacy policy for details." },
];

export default function CookiePreferencesModal({ open, onClose }) {
  const pushedHistoryRef = useRef(false);

  // Mobile only: pushing a history entry while the modal is open means the phone's back gesture closes the modal first.
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined" || window.innerWidth >= 640) return;
    window.history.pushState({ chatmarketCookieModal: true }, "");
    pushedHistoryRef.current = true;
    const handlePopState = () => { pushedHistoryRef.current = false; onClose(); };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (pushedHistoryRef.current) { pushedHistoryRef.current = false; window.history.back(); }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(20, 33, 61, 0.5)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Cookies" className="rounded-md w-full max-w-lg flex flex-col" style={{ background: "#FFFFFF", maxHeight: "85vh" }}>
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Cookies on chatmarket</h2>
          <button onClick={onClose} aria-label="Close"><X size={18} color="#6B6F76" /></button>
        </div>
        <div className="px-6 overflow-y-auto" style={{ flex: 1 }}>
          <p className="text-sm mb-5" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.6 }}>
            We only use cookies that are needed to run the site. We do not use advertising or cross-site tracking cookies. See our{" "}
            <a href="/privacy" target="_blank" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>Privacy Policy</a> for more.
          </p>
          {ITEMS.map((it, i) => (
            <div key={it.title} className={i < ITEMS.length - 1 ? "pb-4 mb-4" : "pb-2"} style={i < ITEMS.length - 1 ? { borderBottom: "1px solid #E4E2D8" } : undefined}>
              <h3 className="text-sm mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>{it.title}</h3>
              <p className="text-xs" style={{ color: "#6B6F76", lineHeight: 1.6 }}>{it.body}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end px-6 py-4" style={{ borderTop: "1px solid #E4E2D8" }}>
          <button onClick={onClose} className="px-4 py-2 rounded text-xs" style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}>Close</button>
        </div>
      </div>
    </div>
  );
}
