import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { saveDemoHandler } from "@/lib/studio/route-handlers";

// Phase 4.4. PUT { sampleInput, isEnabled, steps } -> 200 { demo: { configVersion, reviewStatus, isEnabled } }.
// Logic lives in lib/studio/route-handlers.js; glue only.

export async function PUT(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { status, json } = await saveDemoHandler({ supabase, user, listingId: params.id, body });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
