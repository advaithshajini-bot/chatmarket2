import LegalPage from "@/components/LegalPage";
import { BUSINESS as B } from "@/lib/business";

export const metadata = { title: "Terms and Conditions — chatmarket" };

const SECTIONS = [
  {
    heading: "1. Who we are and what chatmarket is",
    body: [
      `chatmarket is an online marketplace operated by ${B.operator}, ${B.address}. It is a technology platform that lets independent creators ("Sellers") list AI prompts, playbooks, workflows and agent configurations (shown on the site as threads), and lets users ("Buyers") discover and buy them.`,
      "chatmarket acts only as an intermediary and technology enabler. The sale is between the Seller and the Buyer. Sellers create and are responsible for their listings; chatmarket does not author, own or guarantee them.",
      "By creating an account or buying or selling on chatmarket you agree to these Terms and Conditions.",
    ],
  },
  {
    heading: "2. Accounts",
    body: [
      "You must give accurate information and keep your login secure. You are responsible for everything that happens under your account. One account can be used to both buy and sell.",
      "You must be legally able to enter a contract in India to use chatmarket.",
    ],
  },
  {
    heading: "3. Listings and content",
    body: [
      "Sellers are solely responsible for the accuracy of a listing's title, description, price, category and content, and must have the right to sell it.",
      "Uploaded content is automatically scanned for personal information and secrets before a listing goes live. Sellers must not upload another person's private data, credentials, or content they have no right to share.",
      "chatmarket may review, flag, reject, suspend or remove any listing or account at its discretion, including sending a listing back to the Seller for edits.",
    ],
  },
  {
    heading: "4. Payments and Seller settlement",
    body: [
      "Payments are processed by a licensed third-party payment gateway. chatmarket does not see or store your card, UPI or bank credentials.",
      "Sellers are paid through split settlement: when a Buyer pays, the Seller's share is allocated to the Seller's verified linked account and settled to the Seller's bank account through the payment partner's regulated settlement system. The platform retains no commission on a sale at present. Sellers must complete the payment partner's verification (identity and bank details) before they can list; those details are given to the payment partner for verification.",
      "The price shown on a listing is the price you pay, in Indian Rupees. Payment gateway charges, if any, are not added to the Buyer's price.",
      "Sellers are responsible for their own tax obligations arising from their sales.",
    ],
  },
  {
    heading: "5. Licence to the Buyer",
    body: [
      "Once payment is successful, the Seller grants the Buyer a personal, non-exclusive, non-transferable licence to access and use the purchased playbook, workflow or thread for the Buyer's own use.",
      "Buyers may not resell, republish, redistribute or share the purchased content, and may not claim it as their own. Sellers keep their intellectual property in what they sell.",
    ],
  },
  {
    heading: "6. All sales are final; reporting an issue",
    body: [
      "Purchased content is a digital good and unlocks in your Library as soon as payment is confirmed. All sales are final: there are no refunds, returns or cancellations after a sale (see our Refund and Cancellation Policy).",
      `If you cannot access what you bought, or it does not match its listing, you can report it at any time from your Purchases page or by writing to ${B.email}. We review reports and may act on the listing or the Seller's account, but a report does not result in a refund. A charge that is a payment error rather than a sale (such as the same order charged twice) is returned to the original payment source.`,
      `Complaints about chatmarket itself can be sent to our Grievance Officer (see the Help Centre). ${B.supportSla}`,
    ],
  },
  {
    heading: "7. Ratings and reviews",
    body: ["Buyers may rate and review a listing after buying it. Reviews should describe a genuine experience."],
  },
  {
    heading: "8. Prohibited use",
    body: [
      "You may not use chatmarket to list, seek or distribute illegal content, content that infringes someone else's rights, malicious code, or material intended to harass, defraud or harm others, or to misuse another person's payment instrument or identity.",
    ],
  },
  {
    heading: "9. Limitation of liability",
    body: [
      "chatmarket is provided on an \"as is\" basis. AI output and the usefulness of any playbook, workflow or agent depends on the tools you use it with, and we do not promise any particular result.",
      "To the extent permitted by law, chatmarket is not liable for indirect or consequential loss, or for the acts, omissions or content of Sellers. Our total liability for any claim relating to a purchase is limited to the amount you paid for that purchase.",
      "Nothing in these terms limits any right you have under applicable consumer protection law.",
    ],
  },
  {
    heading: "10. Changes and termination",
    body: [
      "We may update these terms from time to time; the date at the top shows the latest version, and continuing to use chatmarket means you accept it. We may suspend or close accounts that break these terms.",
    ],
  },
  {
    heading: "11. Governing law and jurisdiction",
    body: [
      `These terms are governed by the laws of India. The courts at ${B.city} have exclusive jurisdiction over any dispute arising from them.`,
    ],
  },
  {
    heading: "12. Contact",
    body: [`${B.operator}, ${B.address}. Email: ${B.email}.`],
  },
];

export default function TermsPage() {
  return <LegalPage title="Terms and Conditions" updated={B.lastUpdated} sections={SECTIONS} />;
}
