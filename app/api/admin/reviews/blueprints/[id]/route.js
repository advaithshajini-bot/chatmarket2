import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getBlueprintDetailHandler, reviewBlueprintHandler } from "@/lib/admin/review-handlers";

// Phase 4.4. GET -> submission + live re-verification of the stored file + a 60-second download link.
//            POST { decision: "approve"|"reject", note } -> decision (approve re-hashes the stored bytes first). Glue only.

export async function GET(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getBlueprintDetailHandler({ supabase, user, submissionId: params.id });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { status, json } = await reviewBlueprintHandler({ supabase, user, submissionId: params.id, body });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
