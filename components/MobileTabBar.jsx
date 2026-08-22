"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Home, LayoutGrid, Plus, Receipt, User, Library, LogOut, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function TabLink({ href, label, Icon, active }) {
  return (
    <Link href={href} className="flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5">
      <Icon size={20} strokeWidth={active ? 2.4 : 1.8} color={active ? "#14213D" : "#6B6F76"} />
      <span
        className="text-[10px]"
        style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: active ? "#14213D" : "#6B6F76", fontWeight: active ? 600 : 400 }}
      >
        {label}
      </span>
    </Link>
  );
}

export default function MobileTabBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out
  const [youOpen, setYouOpen] = useState(false);
  const sheetRef = useRef(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ? { name: data.user.user_metadata?.display_name || data.user.email } : null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ? { name: session.user.user_metadata?.display_name || session.user.email } : null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setYouOpen(false);
  }, [pathname]);

  useEffect(() => {
    const handleClick = (e) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target)) setYouOpen(false);
    };
    if (youOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [youOpen]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setYouOpen(false);
    router.push("/");
    router.refresh();
  };

  // No dedicated account/settings screen exists yet, so "You" opens a
  // lightweight sheet with the same destinations already reachable from
  // TopNav's logged-in state, rather than a full profile page.
  const isYouSectionActive = ["/library", "/purchases"].some((p) => pathname?.startsWith(p));

  return (
    <>
      {youOpen && user && (
        <div
          ref={sheetRef}
          className="fixed left-3 right-3 rounded-lg p-2 sm:hidden"
          style={{ bottom: "calc(64px + env(safe-area-inset-bottom) + 8px)", background: "#FFFFFF", border: "1px solid #D8D5C9", boxShadow: "0 -4px 20px rgba(20,33,61,.12)", zIndex: 60 }}
        >
          <p className="text-xs px-3 py-2" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            Signed in as <span style={{ color: "#14213D", fontWeight: 500 }}>{user.name}</span>
          </p>
          <Link href="/library" className="flex items-center gap-2.5 px-3 py-2.5 rounded text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <Library size={15} /> Library
          </Link>
          <Link href="/purchases" className="flex items-center gap-2.5 px-3 py-2.5 rounded text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <Receipt size={15} /> Purchases
          </Link>
          <Link href="/admin" className="flex items-center gap-2.5 px-3 py-2.5 rounded text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <ShieldCheck size={15} /> Admin
          </Link>
          <button onClick={handleLogout} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded text-sm text-left" style={{ color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <LogOut size={15} /> Log out
          </button>
        </div>
      )}

      <nav
        className="fixed bottom-0 left-0 right-0 sm:hidden flex items-stretch"
        style={{ background: "rgba(255,255,255,0.96)", backdropFilter: "blur(8px)", borderTop: "1px solid #D8D5C9", paddingBottom: "env(safe-area-inset-bottom)", height: "calc(64px + env(safe-area-inset-bottom))", zIndex: 50 }}
      >
        <TabLink href="/" label="Home" Icon={Home} active={pathname === "/"} />
        <TabLink href="/browse" label="Browse" Icon={LayoutGrid} active={pathname?.startsWith("/browse")} />

        <Link href="/sell" className="flex flex-col items-center justify-center flex-1 relative">
          <span
            className="flex items-center justify-center rounded-full"
            style={{ width: 40, height: 40, background: "#E2A83E", marginTop: -18, boxShadow: "0 2px 8px rgba(226,168,62,.4)" }}
          >
            <Plus size={20} color="#14213D" strokeWidth={2.4} />
          </span>
          <span
            className="text-[10px] mt-0.5"
            style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: pathname?.startsWith("/sell") ? "#14213D" : "#6B6F76", fontWeight: pathname?.startsWith("/sell") ? 600 : 400 }}
          >
            Sell
          </span>
        </Link>

        <TabLink href="/purchases" label="Orders" Icon={Receipt} active={pathname?.startsWith("/purchases")} />

        {user ? (
          <button onClick={() => setYouOpen((v) => !v)} className="flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5">
            <User size={20} strokeWidth={youOpen || isYouSectionActive ? 2.4 : 1.8} color={youOpen || isYouSectionActive ? "#14213D" : "#6B6F76"} />
            <span className="text-[10px]" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: youOpen || isYouSectionActive ? "#14213D" : "#6B6F76", fontWeight: youOpen || isYouSectionActive ? 600 : 400 }}>
              You
            </span>
          </button>
        ) : (
          <TabLink href="/login" label="You" Icon={User} active={pathname?.startsWith("/login")} />
        )}
      </nav>
    </>
  );
}
