import Link from "next/link";
import TopNav from "@/components/TopNav";

export const metadata = {
  title: "Terms and Conditions — chatmarket",
};

const SECTIONS = [
  {
    heading: "1. What chatmarket is",
    body: [
      "chatmarket is a marketplace where sellers list working AI chat threads (from Claude, ChatGPT, Gemini and similar tools) for buyers to purchase and continue from. By creating an account, you agree to these Terms and Conditions.",
    ],
  },
  {
    heading: "2. Accounts",
    body: [
      "You must provide accurate information when creating an account and are responsible for keeping your login credentials secure. You're responsible for all activity that happens under your account.",
      "One account may be used for both buying and selling.",
    ],
  },
  {
    heading: "3. Listings and content",
    body: [
      "Sellers are solely responsible for the accuracy of a listing's title, description, price, category, and the thread content itself.",
      "Uploaded threads are automatically scanned for personal information and secrets before a listing goes live. Sellers must not knowingly upload threads containing another person's private data, credentials, or content they don't have the right to share.",
      "chatmarket reserves the right to review, flag, reject, or remove any listing at its discretion, including sending a listing back to the seller for edits.",
    ],
  },
  {
    heading: "4. Payments",
    body: [
      "Payments are processed through Razorpay. chatmarket does not store your card, UPI, or bank details.",
      "A platform fee is included in the displayed price of every listing.",
      "Funds from a sale may be held for a short period after purchase to allow for a possible dispute, as noted at checkout.",
    ],
  },
  {
    heading: "5. Disputes and refunds",
    body: [
      "If a purchased thread doesn't match its listing, buyers can report an issue from their Purchases page within 48 hours of the purchase. Reports made after that window can't be submitted.",
      "chatmarket reviews reported issues and may issue a refund at its discretion based on the evidence provided.",
    ],
  },
  {
    heading: "6. Ratings and reviews",
    body: [
      "Buyers may rate and review a thread after purchasing it. Reviews should reflect a genuine experience with the thread you bought.",
    ],
  },
  {
    heading: "7. Seller payouts",
    body: [
      "Sellers must complete payout setup (identity and bank account details) before earnings can be paid out. chatmarket may request additional verification for compliance purposes.",
    ],
  },
  {
    heading: "8. Prohibited use",
    body: [
      "You may not use chatmarket to list or seek threads containing illegal content, content that infringes someone else's rights, malicious code, or material intended to harass, defraud, or harm others.",
    ],
  },
  {
    heading: "9. Changes to these terms",
    body: [
      "chatmarket may update these Terms and Conditions from time to time. Continuing to use chatmarket after changes are posted means you accept the updated terms.",
    ],
  },
  {
    heading: "10. Contact",
    body: [
      "Questions about these terms can be sent to the chatmarket support address listed in your account settings.",
    ],
  },
];

export default function TermsPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Terms and Conditions
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
          <Link href="/signup" style={{ color: "#14213D", fontWeight: 500 }}>← Back to create an account</Link>
        </p>
      </main>
    </div>
  );
}
