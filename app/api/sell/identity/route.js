import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/payments/service-client";
import { validateIdentity, explainDirectError } from "@/lib/domain/direct-upi";
import { POLICIES, checkLimit, rateLimitedResponse } from "@/lib/security/rate-limit";

// POST the identity & tax form (first, last, email, phone, address, country, pan, idType, idNumber). Saves through the database function
// set_seller_identity_details with the caller's own session. EVERY submission (valid or not) counts against 5 per hour per seller, so the PAN
// field can't be used to test strings in bulk. The database also caps the seller's own writes per hour, whichever way they arrive.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return json({ error: "You need to be logged in." }, 401);

  const limit = await checkLimit(createServiceClient(), POLICIES.identity, userData.user.id);
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds, "attempts to save your details");

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const v = validateIdentity(body || {});
  if (!v.ok) return json({ error: "Please check the highlighted fields.", fields: v.errors }, 400);
  const x = v.values;
  const { error } = await supabase.rpc("set_seller_identity_details", {
    p_first: x.first, p_last: x.last, p_email: x.email, p_phone: x.phone, p_address: x.address, p_country: x.country, p_pan: x.pan, p_id_type: x.idType, p_id_number: x.idNumber,
  });
  if (error) {
    if (error.code === "CM082") return rateLimitedResponse(Number(error.hint) || 3600, "attempts to save your details");
    return json({ error: explainDirectError(error) }, error.code === "42501" ? 401 : 422);
  }
  return json({ ok: true });
}
