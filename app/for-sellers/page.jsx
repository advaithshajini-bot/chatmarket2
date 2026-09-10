import Link from "next/link";
import TopNav from "@/components/TopNav";
import { UploadCloud, ShieldCheck, Tag, ClipboardCheck, Wallet, Star } from "lucide-react";

export const metadata = {
  title: "For sellers — chatmarket",
};

export default function ForSellersPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          How chatmarket works — for sellers
        </h1>
        <p className="text-base mb-10" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
          If you've had a long, useful conversation with Claude, ChatGPT, or Gemini — one that solved a real
          problem, drafted something well, or worked through a plan in detail — that work has value to someone
          else who's facing the same problem from scratch. Here's exactly how turning it into income works.
        </p>

        <section className="mb-10">
          <h2 className="text-xl mb-5" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            The steps, one at a time
          </h2>

          <div className="space-y-6">
            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <UploadCloud size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  1. Export and upload your thread
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  From Sell, upload a .zip file containing the conversation export (JSON or plain text, from Claude,
                  ChatGPT, or Gemini) plus any files it produced — code, documents, images. Give it a clear title,
                  pick a category, and write an honest description of what it covers and roughly how finished it is.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <ShieldCheck size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  2. We screen it automatically
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Before anything goes live, the conversation inside your zip is scanned for things like personal
                  information, emails, phone numbers, and API keys or passwords, and those are automatically
                  redacted. That automatic scan covers the conversation text — not other files you bundle in
                  (code, documents, images) — so don't include anything in those you wouldn't want a stranger to
                  see. If anything gets flagged, your listing goes to "needs edits" instead of live, and you can
                  revise and resubmit it.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <Tag size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  3. Set your price
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  You choose what to charge. The platform fee is built into the price buyers see — there's no
                  separate charge added on top at checkout, and no surprise deduction you didn't expect either;
                  what you set factors it in from the start.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <ClipboardCheck size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  4. A short review, then it's live
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Alongside the automatic screening, listings go through a review before appearing in Browse. Once
                  approved, buyers can find, preview, and purchase it.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <Wallet size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  5. Set up payouts, then get paid
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Before any earnings can be paid out, you'll complete a one-time payout setup with your PAN and
                  bank account details from Sell → Set up payouts. When someone buys your thread, that sale's
                  funds are held for 48 hours (in case the buyer reports a genuine issue) before being released to
                  you.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <Star size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  6. Build a track record
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Buyers rate threads after purchasing. A track record of good ratings makes your future listings
                  more likely to get picked over someone else's.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-10 rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <h2 className="text-base mb-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
            What makes a listing sell
          </h2>
          <ul className="text-sm space-y-1.5" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            <li>• A specific, honest title — "React Native onboarding + auth flow" beats "Coding help"</li>
            <li>• An accurate completion percentage, so buyers know exactly how much is left to finish</li>
            <li>• A description that says what problem it solves and who it's useful for</li>
            <li>• A fair price for the length and depth of the thread</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            A few common questions
          </h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                What if a buyer reports an issue with my listing?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                Our team reviews the report against your listing before any refund decision is made — see the{" "}
                <Link href="/refund-policy" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
                  Refund Policy
                </Link>{" "}
                for how that works. If a sale is refunded, the payout for that sale is reversed.
              </p>
            </div>
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                Can I sell the same conversation more than once?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                Yes — once you upload and list a thread, it can be purchased by multiple buyers.
              </p>
            </div>
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                Do I need to complete payout setup before I can list a thread?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                No — you can list and sell without it, but you'll need to complete it before any earnings can
                actually be paid out to you.
              </p>
            </div>
          </div>
        </section>

        <div className="rounded-md p-6 text-center" style={{ background: "#14213D" }}>
          <p className="text-lg mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#F7F7F4" }}>
            Have a thread worth sharing?
          </p>
          <Link
            href="/sell"
            className="inline-block px-6 py-3 rounded text-sm"
            style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            Sell your first thread →
          </Link>
        </div>
      </main>
    </div>
  );
}
