"use client";

import Link from "next/link";
import { useAuthUser } from "@/lib/supabase/use-auth-user";
import SocialBar from "@/components/SocialBar";
import AccountMenu from "@/components/AccountMenu";

export default function TopNav({ hideAuthLinks = false }) {
  const user = useAuthUser();

  return (
    <div className="sticky top-0 z-50" style={{ background: "rgba(237,238,234,0.9)", backdropFilter: "blur(8px)" }}>
      <div
        className="flex items-center justify-end px-6 py-2"
        style={{ borderBottom: "1px solid #E4E2D8" }}
      >
        <SocialBar />
      </div>
      <nav
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid #D8D5C9" }}
      >
        <div className="flex items-center gap-8">
          <Link href="/" style={{ fontFamily: "'Fraunces', serif", fontStyle: "italic", fontSize: 20, color: "#14213D" }}>
            chatmarket.
          </Link>
          <div className="hidden sm:flex items-center gap-6 text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <Link href="/browse" style={{ color: "#14213D" }}>Explore</Link>
            <Link href="/#categories" style={{ color: "#14213D" }}>Categories</Link>
            <Link href="/how-it-works" style={{ color: "#14213D" }}>How it works</Link>
            <Link href="/sell" style={{ color: "#14213D" }}>Sell</Link>
            {user && (
              <>
                <Link href="/library" style={{ color: "#14213D" }}>My Library</Link>
                <Link href="/sell" style={{ color: "#14213D" }}>My Products</Link>
                <Link href="/purchases" style={{ color: "#14213D" }}>Dashboard</Link>
              </>
            )}
            {user?.isAdmin && (
              <Link href="/admin" style={{ color: "#14213D" }}>Admin</Link>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {hideAuthLinks ? null : user === undefined ? null : (
            <>
              <AccountMenu user={user} />
              {!user && (
                <Link href="/sell" className="px-4 py-2 rounded text-sm hidden sm:inline-block" style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  Sell on chatmarket
                </Link>
              )}
            </>
          )}
        </div>
      </nav>
    </div>
  );
}
