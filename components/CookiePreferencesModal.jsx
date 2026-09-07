"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const CATEGORIES = [
  {
    id: "analytics",
    title: "Analytics",
    body: "We use analytics cookies to understand how you use chatmarket so we can make it better — for example, which pages get visited and how people move through checkout.",
  },
  {
    id: "social_media",
    title: "Social Media",
    body: "Social media cookies let sharing buttons and embedded content from social platforms work, and can be used by those platforms to tailor what you see there based on your visit here.",
  },
  {
    id: "advertising",
    title: "Advertising",
    body: "Advertising cookies are used to show you more relevant ads elsewhere and to measure how well those ads perform, based on your activity on chatmarket.",
  },
];

const STORAGE_KEY = "chatmarket-cookie-preferences";

function loadPrefs() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function CookiePreferencesModal({ open, onClose }) {
  const [prefs, setPrefs] = useState({});
  const pushedHistoryRef = useRef(false);

  useEffect(() => {
    if (open) setPrefs(loadPrefs());
  }, [open]);

  // Mobile only: without this, the phone's back button/gesture just runs
  // the browser's normal back navigation, which lands on whatever page was
  // in history before this one -- different every time, and looks like
  // the modal randomly sends you somewhere else. Pushing a history entry
  // while the modal is open means back closes the modal first, then
  // behaves normally on a second press. Desktop's back button already
  // worked fine here (nothing to "close" via back on desktop, since this
  // was never confused with real navigation there) so this is skipped
  // above the sm breakpoint used elsewhere in the app.
  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined" || window.innerWidth >= 640) return;

    window.history.pushState({ chatmarketCookieModal: true }, "");
    pushedHistoryRef.current = true;

    const handlePopState = () => {
      pushedHistoryRef.current = false;
      onClose();
    };
    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      // Closed some other way (X, backdrop, Save, Reset) while our dummy
      // history entry is still sitting there unconsumed -- pop it so the
      // back button behaves normally afterward instead of needing an
      // extra press.
      if (pushedHistoryRef.current) {
        pushedHistoryRef.current = false;
        window.history.back();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const setChoice = (id, choice) => setPrefs((p) => ({ ...p, [id]: choice }));

  const handleSave = () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    onClose();
  };

  const handleReset = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setPrefs({});
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(20, 33, 61, 0.5)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-md w-full max-w-lg flex flex-col"
        style={{ background: "#FFFFFF", maxHeight: "85vh" }}
      >
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            Manage cookie preferences
          </h2>
          <button onClick={onClose} aria-label="Close">
            <X size={18} color="#6B6F76" />
          </button>
        </div>

        <div className="px-6 overflow-y-auto" style={{ flex: 1 }}>
          <p className="text-sm mb-6" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.6 }}>
            chatmarket uses cookies to keep you signed in, remember your preferences, and understand how the site is
            used. See our{" "}
            <a href="/privacy" target="_blank" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
              Privacy Policy
            </a>{" "}
            for more.
          </p>

          <div className="pb-5 mb-5" style={{ borderBottom: "1px solid #E4E2D8" }}>
            <h3 className="text-sm mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              Required
            </h3>
            <p className="text-xs" style={{ color: "#6B6F76", lineHeight: 1.6 }}>
              chatmarket uses required cookies to keep you logged in, remember checkout progress, and keep the site
              secure. These can't be switched off since the site won't work properly without them.
            </p>
          </div>

          {CATEGORIES.map((cat, i) => (
            <div key={cat.id} className={i < CATEGORIES.length - 1 ? "pb-5 mb-5" : "pb-2"} style={i < CATEGORIES.length - 1 ? { borderBottom: "1px solid #E4E2D8" } : undefined}>
              <h3 className="text-sm mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                {cat.title}
              </h3>
              <p className="text-xs mb-3" style={{ color: "#6B6F76", lineHeight: 1.6 }}>
                {cat.body}
              </p>
              <div className="flex items-center gap-5">
                <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "#14213D" }}>
                  <input
                    type="radio"
                    name={cat.id}
                    checked={prefs[cat.id] === "accept"}
                    onChange={() => setChoice(cat.id, "accept")}
                    style={{ accentColor: "#14213D" }}
                  />
                  Accept
                </label>
                <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "#14213D" }}>
                  <input
                    type="radio"
                    name={cat.id}
                    checked={prefs[cat.id] === "reject"}
                    onChange={() => setChoice(cat.id, "reject")}
                    style={{ accentColor: "#14213D" }}
                  />
                  Reject
                </label>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-3 px-6 py-4" style={{ borderTop: "1px solid #E4E2D8" }}>
          <button
            onClick={handleReset}
            className="px-4 py-2 rounded text-xs"
            style={{ border: "1px solid #D8D5C9", color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
          >
            Reset all
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded text-xs"
            style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
