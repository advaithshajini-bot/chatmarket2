"use client";

import { useState } from "react";
import Link from "next/link";
import CookiePreferencesModal from "@/components/CookiePreferencesModal";

const LINKS = [
  { label: "About us", href: "/about" },
  { label: "Help center", href: "/help" },
  { label: "Privacy policy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Refund Policy", href: "/refund" },
  { label: "Contact us", href: "/help" },
];

export default function SiteFooter() {
  const [cookiesOpen, setCookiesOpen] = useState(false);

  return (
    <>
      <footer className="mt-12 pt-6 pb-10 px-6" style={{ borderTop: "1px solid #D8D5C9" }}>
        <div className="flex justify-center mb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.svg" alt="ChatMarket" width={646} height={146} className="h-7 w-auto" style={{ display: "block" }} />
        </div>
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          <span className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            © 2026 ChatMarket. All rights reserved.
          </span>
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-xs"
              style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              {link.label}
            </Link>
          ))}
          <button
            onClick={() => setCookiesOpen(true)}
            className="text-xs"
            style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
          >
            Manage cookies
          </button>
        </div>
      </footer>

      <CookiePreferencesModal open={cookiesOpen} onClose={() => setCookiesOpen(false)} />
    </>
  );
}
