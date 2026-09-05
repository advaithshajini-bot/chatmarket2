import Link from "next/link";
import TopNav from "@/components/TopNav";

export const metadata = {
  title: "Refund Policy — chatmarket",
};

const SECTIONS = [
  {
    heading: "1. Reporting an issue",
    body: [
      "If a purchased thread doesn't match what its listing described — wrong content, missing messages, or otherwise not as advertised — you can report it from your Purchases page.",
      "You must report the issue within 48 hours of the purchase. This window exists partly because seller payouts are held for 48 hours after a sale precisely to allow time for a dispute like this.",
      "Once 48 hours have passed, \"Report an issue\" is no longer available for that purchase.",
    ],
  },
  {
    heading: "2. What happens after you report an issue",
    body: [
      "Describe what's wrong when you submit your report. Our team reviews the listing, the thread, and your report.",
      "You'll be notified once a decision is made. This is generally handled within a few business days.",
    ],
  },
  {
    heading: "3. Refund outcomes",
    body: [
      "If we determine the thread genuinely didn't match its listing, we'll issue a refund to your original payment method via Razorpay.",
      "If the thread matches what was listed and the issue doesn't reflect a genuine mismatch, the report may be denied and no refund issued.",
      "Refund decisions are made at chatmarket's discretion based on the evidence in your report and the listing itself.",
    ],
  },
  {
    heading: "4. What isn't covered",
    body: [
      "Change of mind after unlocking a thread isn't grounds for a refund on its own.",
      "Reports submitted after the 48-hour window can't be processed.",
    ],
  },
  {
    heading: "5. Seller-side refunds",
    body: [
      "If a sale is refunded, the corresponding payout to the seller for that sale is reversed or withheld.",
    ],
  },
];

export default function RefundPolicyPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Refund Policy
        </h1>
        <p className="text-sm mb-10" style={{ color: "#6B6F76" }}>
          Last updated: September 2026
        </p>

        <div className="space-y-8">
          {SECTIONS.map((section) => (
            <div key={section.heading}>
              <h2 className="text-lg mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
                {section.heading}
              </h2>
              {section.body.map((para, i) => (
                <p key={i} className="text-sm mb-2" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                  {para}
                </p>
              ))}
            </div>
          ))}
        </div>

        <p className="text-xs mt-12" style={{ color: "#6B6F76" }}>
          <Link href="/browse" style={{ color: "#14213D", fontWeight: 500 }}>← Back to Browse</Link>
        </p>
      </main>
    </div>
  );
}
