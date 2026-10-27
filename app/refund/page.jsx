import LegalPage from "@/components/LegalPage";
import { BUSINESS as B } from "@/lib/business";

export const metadata = { title: "Refund and Cancellation Policy — chatmarket" };

const SECTIONS = [
  {
    heading: "1. All sales are final",
    body: [
      "Everything sold on chatmarket is a digital product that unlocks instantly after payment. Because it can be viewed or downloaded straight away, orders cannot be cancelled once placed, and chatmarket does not provide refunds, returns or exchanges after a sale. Please read the listing carefully before you buy.",
    ],
  },
  {
    heading: "2. You can still report an issue",
    body: [
      "If something is wrong with what you bought (it does not open, it is incomplete, or it is not what the listing described), you can report it at any time, in the same way you can leave a review.",
      "Use \"Report an issue\" on your Purchases page, or write to us at " + B.email + ". Our team reads every report and may use it to fix the problem with the Seller, correct or remove a listing, or take action on a Seller's account. A report does not entitle you to a refund.",
    ],
  },
  {
    heading: "3. Payment errors",
    body: [
      "A charge that is not a genuine sale (for example, the same order charged twice by mistake, or a payment that was taken but never completed) is a payment error, not a sale. In those cases the extra or incomplete amount is returned to the original payment source by our payment partner, normally within the standard banking timelines. Write to " + B.email + " with your payment reference if you think this has happened to you.",
    ],
  },
  {
    heading: "4. Sellers",
    body: [
      "Because all sales are final, a Seller's earnings from a completed sale are not taken back because a Buyer reported an issue.",
    ],
  },
  {
    heading: "5. Contact",
    body: [`${B.email} · ${B.operator}, ${B.address}. ${B.supportSla}`],
  },
];

export default function RefundPage() {
  return <LegalPage title="Refund and Cancellation Policy" updated={B.lastUpdated} sections={SECTIONS} />;
}
