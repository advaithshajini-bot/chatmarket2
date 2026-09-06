import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import TopNav from "@/components/TopNav";

// Shared "you can't be here" screen for pages gated behind a role or
// permission (admin-only sections, a seller-only page viewed by a buyer,
// etc.) -- as opposed to the plain "you need to log in" screens, which are
// for no session at all rather than a session lacking permission.
export default function PermissionDenied({
  message = "You don't have permission to view this page.",
  backHref = "/browse",
  backLabel = "Back to Browse",
}) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-24 max-w-md mx-auto text-center">
        <ShieldAlert size={28} color="#B33A2E" className="mx-auto mb-4" />
        <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          403
        </p>
        <h1 className="text-2xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Permission denied
        </h1>
        <p className="text-sm mb-8" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          {message}
        </p>
        <Link
          href={backHref}
          className="inline-block px-6 py-3 rounded text-sm"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
        >
          {backLabel}
        </Link>
      </main>
    </div>
  );
}
