import TopNav from "@/components/TopNav";

export const metadata = {
  title: "Help center — chatmarket",
};

const FAQS = [
  {
    q: "How do I buy a thread?",
    a: "Open any listing from Browse and pay with UPI, card, netbanking, or a wallet through Razorpay. Once payment is confirmed, the full thread unlocks in your Library immediately.",
  },
  {
    q: "What can I do with a thread after I buy it?",
    a: "You can read it in your Library, copy it for Claude, ChatGPT, or Gemini to continue the conversation, or download the full zip file the seller uploaded.",
  },
  {
    q: "How do I sell a thread?",
    a: "Go to Sell and upload a .zip file containing your exported conversation (JSON or plain text, from Claude, ChatGPT, or Gemini) plus any outputs it produced. We scan the conversation for personal information before it's listed, then it goes to a short review before appearing on Browse.",
  },
  {
    q: "When do I get paid as a seller?",
    a: "You'll need to complete payout setup (PAN and bank details) from Sell → Set up payouts before any earnings can be paid out.",
  },
  {
    q: "What if a thread doesn't match its listing?",
    a: "Open Purchases, find the order, and select \"Report an issue\" within 48 hours of the purchase. Our team reviews reported issues and may issue a refund.",
  },
  {
    q: "How do I reset my password?",
    a: "From the login page, select \"Forgot password\" and follow the link we email you.",
  },
];

export default function HelpPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Help center
        </h1>
        <p className="text-sm mb-10" style={{ color: "#6B6F76" }}>
          Common questions about buying, selling, and using chatmarket.
        </p>

        <div className="space-y-8">
          {FAQS.map((item) => (
            <div key={item.q}>
              <h2 className="text-base mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
                {item.q}
              </h2>
              <p className="text-sm" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
