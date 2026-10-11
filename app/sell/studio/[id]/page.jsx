import Link from "next/link";
import TopNav from "@/components/TopNav";
import SellerStudio from "@/components/SellerStudio";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getStudioState } from "@/lib/domain/studio";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seller Studio — chatmarket" };

// Phase 4.4. Seller Studio for one of the signed-in seller's own listings. A listing that is not yours looks
// exactly like one that does not exist (getStudioState returns null for both).
export default async function SellerStudioPage({ params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const shell = (body) => (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="max-w-3xl mx-auto px-6 py-10">{body}</main>
    </div>
  );
  if (!user) {
    return shell(
      <p style={{ color: "#3A3D42" }}>
        <Link href={`/login?next=/sell/studio/${params.id}`} style={{ color: "#14213D", textDecoration: "underline" }}>Log in</Link> to use the Seller Studio.
      </p>
    );
  }
  const studio = await getStudioState(supabase, params.id, user.id);
  if (!studio) {
    return shell(
      <p style={{ color: "#6B6F76" }}>
        Listing not found. <Link href="/sell" style={{ color: "#14213D", textDecoration: "underline" }}>Back to selling</Link>
      </p>
    );
  }
  const initial = {
    draft: studio.demo?.draft ?? { sampleInput: "", isEnabled: true, steps: [{ name: "", model: studio.defaultModel, system: "", maxOutputTokens: "300", timeoutSeconds: "20" }] },
    demo: studio.demo,
    submissions: studio.submissions,
    liveBlueprint: studio.liveBlueprint,
  };
  return shell(
    <SellerStudio listingId={studio.listing.id} sellerId={user.id} title={studio.listing.title} eligible={studio.eligible} models={studio.models} initial={initial} />
  );
}
