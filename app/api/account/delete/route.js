import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/payments/service-client";
import { explainDeleteRefusal } from "@/lib/domain/username";

// POST { confirm: "DELETE", reason?: string }. Anonymises the caller's account (database function delete_my_account, run as the caller),
// then locks the login: random unusable email + permanent ban (service key, server only). Purchase and payout records are kept.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return json({ error: "You need to be logged in." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (body?.confirm !== "DELETE") return json({ error: "Type DELETE to confirm." }, 400);

  const admin = createServiceClient();
  if (!admin) return json({ error: "Account deletion isn't available right now. Please contact support." }, 503);

  const { data, error } = await supabase.rpc("delete_my_account");
  if (error) return json({ error: "We couldn't delete your account. Please try again." }, 500);
  if (!data?.ok) return json({ error: explainDeleteRefusal(data?.reason), reason: data?.reason }, 409);

  const uid = userData.user.id;
  const { error: lockError } = await admin.auth.admin.updateUserById(uid, {
    email: `deleted-${uid}@deleted.invalid`,
    ban_duration: "876000h",
    user_metadata: { display_name: "Deleted user", deleted_at: new Date().toISOString(), deletion_reason: typeof body.reason === "string" ? body.reason.slice(0, 120) : null },
  });
  if (lockError) return json({ error: "Your data was removed but we couldn't lock the login. Please contact support." }, 500);

  await supabase.auth.signOut();
  return json({ ok: true });
}
