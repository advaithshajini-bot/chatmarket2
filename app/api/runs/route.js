import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { startRunHandler } from "@/lib/execution/route-handlers";

// Phase 3.2. Calls public.start_run() -- deployed and verified (Phase
// 3.2 Step 1). All actual logic lives in lib/execution/route-handlers.js
// (framework-free, unit-tested directly by
// tests/phase3/l3-route-handlers.test.mjs) -- this file is pure glue:
// real dependencies in, NextResponse out.
//
// CORRECTION, found while wiring this route for real: lib/execution/
// validation.js does NOT belong here. execution_config is set from
// v_listing.configuration (the SELLER's declared config, frozen at
// run-creation time) -- p_input (this route's `input` field) is stored
// separately as runs.input (runtime form data) and is never
// ceiling-checked. L1's real integration point is
// app/api/listings/create-workflow-agent/route.js, not here.

export async function POST(request) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { status, json } = await startRunHandler({ supabase, user, body });
  return NextResponse.json(json, { status });
}
