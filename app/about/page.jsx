import LegalPage from "@/components/LegalPage";
import { BUSINESS as B } from "@/lib/business";

export const metadata = { title: "About us — chatmarket" };

const SECTIONS = [
  {
    heading: "What chatmarket is",
    body: [
      "chatmarket is a marketplace for discovering, sharing and monetising AI prompts, workflow playbooks and automated agent configurations. Instead of starting from a blank prompt, buyers pick up something a creator has already built and tested, and continue from there.",
      "Creators list what they have built. Anything uploaded is automatically screened for personal information and secrets before it goes live, then reviewed before it appears for sale.",
    ],
  },
  {
    heading: "How the money works",
    body: [
      "Buyers pay securely through a licensed payment gateway. chatmarket keeps an 18% platform fee on each sale, and creators receive the remaining earnings in a monthly bank transfer (IMPS/NEFT) around the 1st of every month. Items are digital and unlock instantly after payment, and all sales are final.",
    ],
  },
  {
    heading: "Who runs it",
    body: [
      `chatmarket is operated by ${B.operator}, based in ${B.city}.`,
      `Registered address: ${B.address}.`,
      `Contact: ${B.email}. See our Help Centre for support and grievance details.`,
    ],
  },
];

export default function AboutPage() {
  return <LegalPage title="About us" sections={SECTIONS} />;
}
