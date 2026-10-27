import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { createRazorpayClient } from "@/lib/payments/razorpay-client";
import { onboardLinkedAccount, refreshLinkedAccount } from "@/lib/payments/route-onboarding";
import { validateRouteForm } from "@/lib/domain/route";

// Seller linked-account onboarding for Razorpay Route (flag the Route flag; test keys first).
//   POST { action: "submit", ...form }  -> create the linked account, request the Route product, send bank settlement details
//   POST { action: "refresh" }          -> re-read the account status from Razorpay
// PAN and bank details are passed to Razorpay and never stored by us: only razorpay_account_id and the status are saved.
// The secret key stays on the server; the browser never talks to Razorpay.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return json({ error: "Razorpay isn't configured on this deployment yet." }, 500);
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return json({ error: "You need to be logged in." }, 401);

  const { data: routeOn } = await supabase.rpc("route_checkout_enabled");
  if (routeOn !== true) return json({ error: "route_disabled" }, 403);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const service = createServiceClient();
  if (!service) return json({ error: "Checkout isn't fully configured on this deployment yet." }, 500);
  const db = createPaymentsDb(service);
  const rzp = createRazorpayClient({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET });

  const { data: acct } = await service.from("seller_payout_accounts").select("razorpay_account_id, route_status").eq("user_id", userData.user.id).maybeSingle();

  try {
    if (body?.action === "refresh") {
      if (!acct?.razorpay_account_id) return json({ error: "No payment account yet." }, 404);
      const r = await refreshLinkedAccount({ db, rzp, userId: userData.user.id, accountId: acct.razorpay_account_id });
      return r.ok ? json({ ok: true, routeStatus: r.routeStatus, ready: r.ready }) : json({ error: "We couldn't reach Razorpay just now. Please try again." }, 502);
    }
    if (acct?.route_status === "activated") return json({ error: "route_account_exists" }, 409);
    const form = validateRouteForm(body);
    if (!form.ok) return json({ error: "Please check the highlighted fields.", fields: form.errors }, 400);
    const r = await onboardLinkedAccount({ db, rzp, userId: userData.user.id, value: form.value, existingAccountId: acct?.razorpay_account_id ?? null });
    if (!r.ok) {
      // Razorpay's own message is safe wording (no card/bank data); never echo the request body.
      return json({ error: r.retryable ? "Razorpay is busy. Please try again in a moment." : (r.message || "Razorpay couldn't accept these details."), step: r.step }, r.retryable ? 502 : 422);
    }
    return json({ ok: true, routeStatus: r.routeStatus, ready: r.ready });
  } catch (e) {
    const m = String(e?.message ?? "");
    if (/route_account_exists|too_many_route_attempts/.test(m)) return json({ error: m }, 409);
    return json({ error: "We couldn't complete that just now. Please try again in a moment." }, 500);
  }
}
