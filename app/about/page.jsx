import Link from "next/link";
import TopNav from "@/components/TopNav";

export const metadata = {
  title: "About us — chatmarket",
};

export default function AboutPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-6" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          About us
        </h1>

        <div className="space-y-4">
          <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            chatmarket is a marketplace for working AI chat threads. Instead of starting a new conversation with
            Claude, ChatGPT, or Gemini from a blank prompt, buyers can pick up a thread that someone else has
            already built out — a working codebase discussion, a structured piece of writing, a research
            breakdown — and continue from exactly where it left off.
          </p>
          <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            Sellers list threads they've already had — with any personal information or secrets automatically
            screened out before a listing goes live — and buyers unlock the full thread with a single payment.
          </p>
          <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            We're a small team building chatmarket because we kept re-explaining the same context to AI models
            over and over, and figured other people were doing the same thing.
          </p>
        </div>

        <p className="text-xs mt-12" style={{ color: "#6B6F76" }}>
          <Link href="/browse" style={{ color: "#14213D", fontWeight: 500 }}>← Back to Browse</Link>
        </p>
      </main>
    </div>
  );
}
