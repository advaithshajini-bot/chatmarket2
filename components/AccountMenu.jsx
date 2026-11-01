"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { firstName } from "@/lib/domain/public-name";

const LEAVE_DELAY_MS = 150;

// Two-line "Hello, <name> / Accounts & Lists ▾" button with a flyout. Opens on hover (150ms leave delay so the pointer can cross the gap),
// on keyboard focus, and on tap (mobile). `user` is undefined while loading, null when signed out.
export default function AccountMenu({ user }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const root = useRef(null);

  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hideSoon = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), LEAVE_DELAY_MS); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown); document.addEventListener("touchstart", onDown); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("touchstart", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const signOut = async () => {
    await createClient().auth.signOut();
    setOpen(false);
    router.push("/");
    router.refresh();
  };

  const greeting = user ? `Hello, ${firstName(user.name) || "there"}` : "Hello, sign in";
  const item = "block px-3 py-1.5 text-sm rounded hover:bg-[#EDEEEA]";
  const close = () => setOpen(false);

  return (
    <div ref={root} className="relative" onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={(e) => { if (!root.current?.contains(e.relatedTarget)) hideSoon(); }}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="text-left px-2 py-1 rounded leading-tight" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>
        <span className="block text-[11px]" style={{ color: "#6B6F76" }}>{greeting}</span>
        <span className="flex items-center gap-1 text-sm" style={{ fontWeight: 700 }}>Accounts &amp; Lists <ChevronDown size={12} aria-hidden="true" /></span>
      </button>
      {open && (
        <div role="menu" aria-label="Accounts and lists" className="absolute right-0 top-full pt-2 w-64 z-50">
          <div className="rounded-md p-3 shadow-lg" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>
            {user === null && (
              <div className="mb-3 text-center">
                <Link href="/login" onClick={close} role="menuitem" className="block w-full py-2 rounded text-sm" style={{ background: "#14213D", color: "#F7F7F4", fontWeight: 600 }}>Sign In</Link>
                <p className="text-xs mt-2" style={{ color: "#6B6F76" }}>New customer? <Link href="/signup" onClick={close} className="underline" style={{ color: "#14213D" }}>Start here</Link></p>
              </div>
            )}
            <p className="px-3 pb-1 text-[11px] uppercase tracking-wide" style={{ color: "#6B6F76" }}>Your account</p>
            {user && <Link role="menuitem" href={`/sellers/${user.id}`} onClick={close} className={item}>Public Profile</Link>}
            <Link role="menuitem" href="/library" onClick={close} className={item}>My Library</Link>
            <Link role="menuitem" href="/sell/earnings" onClick={close} className={item}>My Products &amp; Listings</Link>
            <Link role="menuitem" href="/sell" onClick={close} className={item}>Creator Dashboard</Link>
            <Link role="menuitem" href="/settings" onClick={close} className={item}>Settings</Link>
            {user?.isAdmin && <Link role="menuitem" href="/admin" onClick={close} className={item}>Admin</Link>}
            {user && (
              <button type="button" role="menuitem" onClick={signOut} className="mt-2 w-full py-2 rounded text-sm" style={{ border: "1px solid #14213D", color: "#14213D", fontWeight: 600 }}>Sign Out</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
