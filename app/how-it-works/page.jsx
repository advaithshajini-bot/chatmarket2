import Link from "next/link";
import TopNav from "@/components/TopNav";
import { CheckCircle2, ShieldCheck, Unlock, Search, CreditCard, MessageSquare } from "lucide-react";

export const metadata = {
  title: "How it works — chatmarket",
};

export default function HowItWorksPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          How chatmarket works — for buyers
        </h1>
        <p className="text-base mb-10" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
          If you've never bought a "chat thread" before, this is the plain-language version — no jargon, just what
          you're actually getting and how the whole thing works, start to finish.
        </p>

        <section className="mb-10">
          <h2 className="text-xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            First: what is a "thread," and why would I buy one?
          </h2>
          <p className="text-sm mb-3" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            When you use an AI assistant like Claude, ChatGPT, or Gemini, you have a back-and-forth conversation
            with it — you ask something, it responds, you ask a follow-up, and so on. That whole conversation is a
            "thread."
          </p>
          <p className="text-sm mb-3" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            Sometimes someone works through a problem with an AI for a while — building part of an app, drafting a
            business plan, working out a piece of writing — and gets most of the way there, but not all the way.
            Instead of that work going to waste, they can sell the thread on chatmarket. You buy it, and you
            instantly have all that back-and-forth already done — you're not starting from a blank page, you're
            picking up from wherever they left off.
          </p>
          <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            Think of it like buying a partially-built piece of furniture with instructions already worked out,
            instead of a pile of raw wood.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl mb-5" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            The steps, one at a time
          </h2>

          <div className="space-y-6">
            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <Search size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  1. Browse and find a thread
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Head to Browse and filter by category — Web Development, Writing & Content, Business & Strategy,
                  and more. Each listing shows which AI model the thread is from, how many messages it contains,
                  and roughly how "complete" the work is (for example, "90% complete" means it's nearly finished).
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <MessageSquare size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  2. Preview before you pay
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Every listing shows you the real first two messages of the thread for free, so you can see the
                  actual writing style and content before buying — not just a description someone wrote about it.
                  The rest stays locked until you pay.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <CreditCard size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  3. Pay to unlock
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Checkout runs through Razorpay, so you can pay with UPI, a credit or debit card, netbanking, or
                  Google Pay — whatever you'd normally use to pay for anything online. The listed price already
                  includes chatmarket's platform fee, so there's nothing extra added at checkout.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <Unlock size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  4. It unlocks immediately, in your Library
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  The moment payment goes through, the full thread appears in your Library — no waiting. From
                  there you can: <strong>copy it</strong> in a format ready to paste into a new Claude, ChatGPT, or
                  Gemini conversation to keep going where it left off, or <strong>download the zip file</strong> the
                  seller uploaded — the conversation plus whatever it produced (code, documents, images) — to keep
                  or use offline.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#EAF2EF" }}>
                <CheckCircle2 size={17} color="#2F6F62" />
              </div>
              <div>
                <h3 className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                  5. Rate it
                </h3>
                <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  Once you've had a look, leave a star rating (and an optional comment) from your Library. This
                  helps other buyers know which sellers and threads are reliable.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-10 rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={17} color="#14213D" />
            <h2 className="text-base" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
              What if the thread isn't what it was described as?
            </h2>
          </div>
          <p className="text-sm mb-2" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            Go to Purchases and select "Report an issue" within 48 hours of buying it. Our team reviews what
            happened and can issue a refund if the thread genuinely doesn't match its listing. See our{" "}
            <Link href="/refund-policy" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
              Refund Policy
            </Link>{" "}
            for the details.
          </p>
          <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
            Every thread is also automatically checked for personal information and passwords/API keys before it's
            allowed to go live, so you're not going to end up with someone else's private data.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            A few common questions
          </h2>
          <div className="space-y-4">
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                Do I need my own Claude, ChatGPT, or Gemini account to use what I buy?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                Only if you want to continue the conversation with the AI itself — you'll paste the copied thread
                into your own account with that AI tool and keep going. If you just want to read it, use the code,
                or reuse whatever it produced, downloading the zip file is enough on its own.
              </p>
            </div>
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                Is the seller's name or personal information in the thread?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                The conversation itself is scanned and personal details are stripped out before a listing is
                allowed to go live. That automatic scan covers the conversation text — not the other files a
                seller might bundle in (code, documents, images), so treat those the way you would any file from
                a stranger.
              </p>
            </div>
            <div>
              <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                What does "% complete" actually mean?
              </p>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                It's the seller's own estimate of how far along the work in the thread is — 100% means they
                consider it finished, lower numbers mean there's more left to do, which you'd continue yourself
                after unlocking it.
              </p>
            </div>
          </div>
        </section>

        <div className="rounded-md p-6 text-center" style={{ background: "#14213D" }}>
          <p className="text-lg mb-4" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#F7F7F4" }}>
            Ready to see what's out there?
          </p>
          <Link
            href="/browse"
            className="inline-block px-6 py-3 rounded text-sm"
            style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            Browse threads →
          </Link>
        </div>
      </main>
    </div>
  );
}
