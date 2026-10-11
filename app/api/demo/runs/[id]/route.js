import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getDemoRunHandler } from "@/lib/demo/route-handlers";

// Phase 4.3. GET -> { run } : the sanitised view the Try Demo widget polls.
// Logic lives in lib/demo/route-handlers.js (unit-tested); this file is glue only.

export async function GET(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getDemoRunHandler({ supabase, user, runId: params.id });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
