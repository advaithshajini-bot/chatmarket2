import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getDemoDetailHandler, reviewDemoHandler } from "@/lib/admin/review-handlers";

// Phase 4.4. GET -> the demo to review (prompts included: the reviewer must see what they approve).
//            POST { decision: "approve"|"reject", expectedVersion, note } -> decision. Glue only.

export async function GET(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getDemoDetailHandler({ supabase, user, listingId: params.id });
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
  const { status, json } = await reviewDemoHandler({ supabase, user, listingId: params.id, body });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
