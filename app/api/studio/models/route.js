import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { listModelsHandler } from "@/lib/studio/route-handlers";

// Phase 4.4. GET -> { models: [{ model, tier, isDefault }] }. Logic lives in lib/studio/route-handlers.js; glue only.

export async function GET() {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await listModelsHandler({ supabase, user });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
