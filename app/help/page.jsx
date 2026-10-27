import Link from "next/link";
import TopNav from "@/components/TopNav";
import { BUSINESS as B } from "@/lib/business";

export const metadata = { title: "Help center — chatmarket" };

const FAQS = [
  {
    q: "How do I buy a playbook or thread?",
    a: "Open any listing from Browse and pay with UPI, card or netbanking. Once payment is confirmed, it unlocks in your Library immediately.",
  },
  {
    q: "What can I do with it after I buy it?",
    a: "You can read it in your Library, copy it into Claude, ChatGPT or Gemini to continue, or download the files the seller uploaded. It is licensed to you for your own use.",
  },
  {
    q: "How do I sell?",
    a: "Go to Sell. First set up your payment account (your details are verified by our payment partner), then upload your playbook, workflow or thread. We scan it for personal information, then it gets a short review before it appears on Browse.",
  },
  {
    q: "How and when do I get paid as a seller?",
    a: "Buyers pay through our payment gateway, and 100% of the sale price is settled to your verified bank account. chatmarket takes no commission. Settlement timing follows the payment partner's settlement schedule.",
  },
  {
    q: "What if something doesn't work or doesn't match its listing?",
    a: `You can report it at any time with "Report an issue" on your Purchases page, or by emailing ${B.email}. Our team reviews every report. All sales are final, so reports do not lead to refunds; see the Refund Policy.`,
  },
  {
    q: "How do I reset my password?",
    a: "From the login page, select \"Forgot password\" and follow the link we email you.",
  },
];

const text = { color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 };

export default function HelpPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Help center</h1>
        <p className="text-sm mb-10" style={{ color: "#6B6F76" }}>Common questions about buying, selling and using chatmarket.</p>

        <section className="mb-12 rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <h2 className="text-lg mb-3" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Contact us</h2>
          <p className="text-sm mb-3" style={text}>{B.supportSla}</p>
          <dl className="text-sm space-y-2" style={text}>
            <div><dt className="inline font-semibold">Support email: </dt><dd className="inline"><a href={`mailto:${B.email}`} style={{ color: "#14213D", textDecoration: "underline" }}>{B.email}</a></dd></div>
            <div><dt className="inline font-semibold">Grievance Officer: </dt><dd className="inline">{B.operator} (Email: <a href={`mailto:${B.email}`} style={{ color: "#14213D", textDecoration: "underline" }}>{B.email}</a>), appointed under the Information Technology (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021. We acknowledge grievances within 24 hours and aim to resolve them within 15 days.</dd></div>
            <div><dt className="inline font-semibold">Registered business address: </dt><dd className="inline">{B.address}</dd></div>
          </dl>
          <p className="text-sm mt-3" style={text}>
            Payment or policy question? See the <Link href="/refund" style={{ color: "#14213D", textDecoration: "underline" }}>Refund Policy</Link>.
          </p>
        </section>

        <div className="space-y-8">
          {FAQS.map((item) => (
            <div key={item.q}>
              <h2 className="text-base mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>{item.q}</h2>
              <p className="text-sm" style={text}>{item.a}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
