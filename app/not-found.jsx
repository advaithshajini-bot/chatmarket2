import Link from "next/link";
import { Compass } from "lucide-react";
import TopNav from "@/components/TopNav";

export default function NotFound() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-24 max-w-md mx-auto text-center">
        <Compass size={28} color="#6B6F76" className="mx-auto mb-4" />
        <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          404
        </p>
        <h1 className="text-2xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Page not found
        </h1>
        <p className="text-sm mb-8" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          The page you're looking for doesn't exist, may have moved, or the thread may no longer be available.
        </p>
        <Link
          href="/browse"
          className="inline-block px-6 py-3 rounded text-sm"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
        >
          Back to Browse
        </Link>
      </main>
    </div>
  );
}
