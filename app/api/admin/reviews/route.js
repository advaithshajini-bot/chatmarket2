import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getQueueHandler } from "@/lib/admin/review-handlers";

// Phase 4.4. GET -> { queue: { demos, blueprints } }. Admin + MFA is enforced inside the RPC. Glue only.

export async function GET() {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getQueueHandler({ supabase, user });
  return NextResponse.json(json, { status, headers: { "Cache-Control": "no-store" } });
}
