import { permanentRedirect } from "next/navigation";

// The policy lives at /refund. This keeps the old address (and any links already shared) working.
export const metadata = { title: "Refund and Cancellation Policy — chatmarket" };
export default function RefundPolicyRedirect() {
  permanentRedirect("/refund");
}
