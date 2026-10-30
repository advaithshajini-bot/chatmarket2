import LegalPage from "@/components/LegalPage";
import { BUSINESS as B } from "@/lib/business";

export const metadata = { title: "Privacy Policy — chatmarket" };

const SECTIONS = [
  {
    heading: "1. Who is responsible for your data",
    body: [`${B.operator}, ${B.address}, operates chatmarket and is responsible for the personal data described here. Email ${B.email} with any privacy question.`],
  },
  {
    heading: "2. What we collect",
    body: [
      { list: [
        "Account data: your name and email address, and your password (stored only in secured, hashed form).",
        "Transaction data: order ID, payment reference, amount, listing and date. This is metadata about the transaction, not your payment credentials.",
        "Seller content: the playbooks, workflows, threads, screenshots, titles, descriptions and prices you upload.",
        "Seller payment account status: for Sellers, the identifier and verification status of the linked payment account.",
        "Support messages you send us and reports you raise about a purchase.",
      ] },
    ],
  },
  {
    heading: "3. Payment data",
    body: [
      "We never store card numbers, CVVs, UPI PINs or net-banking credentials on our servers. Payments are collected and tokenised by our licensed payment gateway partner, which processes them under PCI-DSS standards.",
      "Sellers save their bank account details (beneficiary name, account number, IFSC and account type) so we can pay out their earnings by bank transfer. We store them in access-restricted storage, show a seller only the last four digits of their own account, and use them only to make payouts and keep payout records. They can be deleted on request, subject to records we must keep by law.",
    ],
  },
  {
    heading: "4. How we use it",
    body: [
      { list: [
        "to run the marketplace: show listings, process purchases and unlock what you bought;",
        "to screen listings for personal information or secrets before they go live;",
        "to contact you about your account, orders and support requests;",
        "to investigate disputes, prevent fraud and keep the platform safe; and",
        "to meet legal, tax and accounting obligations.",
      ] },
      "If you use a live demo on a listing, the text you type is sent to our AI provider to produce the demo output.",
    ],
  },
  {
    heading: "5. Who we share it with",
    body: [
      { list: [
        "Our licensed payment gateway partner: for payments, payment-error reversals, Seller verification and settlement.",
        "Supabase: secure database, authentication and file hosting for chatmarket.",
        "Our AI provider (Anthropic), only for live-demo runs you start.",
        "Sellers see that a purchase happened on their listing; they do not receive your payment details.",
        "Authorities, when the law requires it.",
      ] },
      "We do not sell your personal information.",
    ],
  },
  {
    heading: "6. Cookies",
    body: [
      "We use only the cookies needed to sign you in and keep your session secure. We do not use advertising or cross-site tracking cookies. See \"Manage cookies\" in the footer for details.",
    ],
  },
  {
    heading: "7. Retention and security",
    body: [
      "We keep account and transaction records while your account is active and for as long as law and accounting rules require. Data is stored with access controls and encrypted connections; no system is perfectly secure, so please use a strong password.",
    ],
  },
  {
    heading: "8. Your rights",
    body: [
      `You can view and update your account details at any time. You can ask us to correct or delete your data, or withdraw a consent, by emailing ${B.email}. We will respond within the time the law allows; some transaction records must be kept even after deletion of your account.`,
    ],
  },
  {
    heading: "9. Changes",
    body: ["If we change this policy, the date at the top changes. Material changes will also be announced on the site."],
  },
];

export default function PrivacyPage() {
  return <LegalPage title="Privacy Policy" updated={B.lastUpdated} sections={SECTIONS} />;
}
