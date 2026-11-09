import TopNav from "@/components/TopNav";
import SiteFooter from "@/components/SiteFooter";
import WaitlistForm from "@/components/WaitlistForm";

export const metadata = {
  title: "Join the waitlist — ChatMarket",
  description: "ChatMarket, an India-first marketplace for AI Playbooks, opens in January 2027. Join the waitlist.",
};

// Stand-alone page for the link in your social bios. ?src=ig|yt|fb|li is stored nowhere yet; the form sends it as a label only.
export default function WaitlistPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-14 max-w-md mx-auto">
        <p className="mb-3" style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#2F6F62" }}>Opening January 2027</p>
        <h1 className="text-4xl mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D", lineHeight: 1.1 }}>Be first in when ChatMarket opens.</h1>
        <p className="mb-8" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 16, color: "#3A3D42", lineHeight: 1.65 }}>
          An India-first marketplace for AI Playbooks: prompts and project files with a demo video and real output screenshots. Join as a buyer, a creator, or both.
        </p>
        <div style={{ border: "1px solid #D8D5C9", borderRadius: 10, background: "#F7F7F4", padding: 26 }}>
          <WaitlistForm source="waitlist-page" />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
