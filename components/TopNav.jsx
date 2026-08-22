"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function TopNav() {
  const router = useRouter();
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ? { name: data.user.user_metadata?.display_name || data.user.email, email: data.user.email } : null);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ? { name: session.user.user_metadata?.display_name || session.user.email, email: session.user.email } : null);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    router.push("/");
    router.refresh();
  };

  return (
    <nav
      className="flex items-center justify-between px-6 py-4 sticky top-0 z-50"
      style={{ background: "rgba(237,238,234,0.9)", backdropFilter: "blur(8px)", borderBottom: "1px solid #D8D5C9" }}
    >
      <div className="flex items-center gap-8">
        <Link href="/" style={{ fontFamily: "'Fraunces', serif", fontStyle: "italic", fontSize: 20, color: "#14213D" }}>
          chatmarket.
        </Link>
        <div className="hidden sm:flex items-center gap-6 text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <Link href="/browse" style={{ color: "#14213D" }}>Browse</Link>
          <Link href="/sell" style={{ color: "#14213D" }}>Sell</Link>
          <Link href="/library" style={{ color: "#14213D" }}>Library</Link>
          <Link href="/purchases" style={{ color: "#14213D" }}>Purchases</Link>
          <Link href="/admin" style={{ color: "#14213D" }}>Admin</Link>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {user === undefined ? null : user ? (
          <>
            <span className="text-sm hidden sm:inline" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
              {user.name}
            </span>
            <button
              onClick={handleLogout}
              className="px-4 py-2 rounded text-sm"
              style={{ border: "1px solid #14213D", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              Log out
            </button>
          </>
        ) : (
          <>
            <Link
              href="/login"
              className="px-4 py-2 rounded text-sm"
              style={{ border: "1px solid #14213D", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              Log in
            </Link>
            <Link
              href="/sell"
              className="px-4 py-2 rounded text-sm"
              style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              Sell a thread
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
