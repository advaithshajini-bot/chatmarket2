import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { submitDemoHandler } from "@/lib/studio/route-handlers";

// Phase 4.4. POST -> 200 { demo: { configVersion, reviewStatus: "pending_admin_approval" } }. Glue only.

export async function POST(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await submitDemoHandler({ supabase, user, listingId: params.id });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
