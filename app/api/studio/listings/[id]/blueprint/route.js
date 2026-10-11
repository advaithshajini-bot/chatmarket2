import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { registerBlueprintHandler } from "@/lib/studio/route-handlers";

// Phase 4.4. POST { path } -> 201 { submissionId, format, sha256, sizeBytes, nodeCount, warnings }.
// The server trusts only the storage path: it re-downloads and re-inspects the object. Glue only.

export async function POST(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { status, json } = await registerBlueprintHandler({ supabase, user, listingId: params.id, body });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
