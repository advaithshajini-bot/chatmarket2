import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getBlueprintDownloadHandler } from "@/lib/blueprints/download";

// Phase 4.2. GET -> { url, filename, format, sha256, sizeBytes, expiresInSeconds }.
// Access is enforced by Storage RLS through the caller's own client (see lib/blueprints/download.js).

export async function GET(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getBlueprintDownloadHandler({ supabase, user, listingId: params.id });
  return NextResponse.json(json, { status });
}
