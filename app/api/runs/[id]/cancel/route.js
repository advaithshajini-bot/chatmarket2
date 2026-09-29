import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { cancelRunHandler } from "@/lib/execution/route-handlers";

// Phase 3.2. Calls public.cancel_my_run() (deployed, Phase 3.2 Step 1).
// Logic lives in lib/execution/route-handlers.js -- this is glue only.

export async function POST(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await cancelRunHandler({ supabase, user, runId: params.id });
  return NextResponse.json(json, { status });
}
