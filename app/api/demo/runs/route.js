import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { startDemoRunHandler } from "@/lib/demo/route-handlers";

// Phase 4.2. POST { listingId, text } -> 201 { runId }. Poll with the existing GET /api/runs/[id].
// All logic lives in lib/demo/route-handlers.js (unit-tested); this file is glue only.

export async function POST(request) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { status, json } = await startDemoRunHandler({ supabase, user, body });
  return NextResponse.json(json, { status });
}
