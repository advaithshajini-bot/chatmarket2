import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { getRunHandler } from "@/lib/execution/route-handlers";

// Phase 3.2. Calls public.worker_recover_stale_run() (deployed, Phase
// 3.2 Step 1 -- the deliberate authenticated-grant exception, see
// PART3_WORKER_PLAN.md) then reads the run. Logic lives in
// lib/execution/route-handlers.js -- this is glue only.

export async function GET(request, { params }) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  const { status, json } = await getRunHandler({ supabase, user, runId: params.id });
  return NextResponse.json(json, { status });
}
