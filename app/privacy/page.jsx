import TopNav from "@/components/TopNav";

export const metadata = {
  title: "Privacy Policy — chatmarket",
};

const SECTIONS = [
  {
    heading: "1. Information we collect",
    body: [
      "Account information you provide directly: name, email address, and password (stored securely, never in plain text).",
      "Content you upload as a seller: chat threads, listing titles, descriptions, and prices.",
      "Payment information is handled entirely by Razorpay — chatmarket never sees or stores your card, UPI, or bank account numbers.",
      "Seller payout information (PAN, bank account, address) collected during payout setup, stored separately and restricted to you and admins.",
    ],
  },
  {
    heading: "2. How we use information",
    body: [
      "To operate the marketplace: showing listings, processing purchases, and unlocking threads you've bought.",
      "To screen listings for personal information or secrets before they go live.",
      "To communicate with you about your account, purchases, or listings.",
      "To investigate reported issues and disputes.",
    ],
  },
  {
    heading: "3. Cookies",
    body: [
      "chatmarket uses required cookies to keep you signed in and remember basic preferences. With your consent, we may also use analytics, social media, or advertising cookies — you can review and change these anytime from \"Manage cookies\" in the site footer.",
    ],
  },
  {
    heading: "4. Sharing of information",
    body: [
      "We share payment details with Razorpay solely to process transactions.",
      "We don't sell your personal information to third parties.",
      "We may disclose information if required by law or to protect the safety of our users.",
    ],
  },
  {
    heading: "5. Data retention and security",
    body: [
      "We retain account and transaction information for as long as your account is active and as needed to comply with legal obligations.",
      "Sensitive documents (like KYC uploads) are stored in access-restricted storage, readable only by you and admins.",
    ],
  },
  {
    heading: "6. Your choices",
    body: [
      "You can review and update your account information at any time. You can request deletion of your account by contacting support, subject to records we're required to retain.",
    ],
  },
  {
    heading: "7. Changes to this policy",
    body: [
      "We may update this Privacy Policy from time to time. Material changes will be reflected by an updated date at the top of this page.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Privacy Policy
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
      </main>
    </div>
  );
}
