import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/payments/service-client";
import { checkLimit, rateLimitedResponse, clientIp } from "@/lib/security/rate-limit";

// POST { email, role_interest: "buyer" | "seller" | "both", source?, website? } -> one row in public.waitlist_signups.
// Abuse protection: hidden "website" honeypot, a sliding-window limit per IP (5 sign-ups per hour, shared Postgres limiter), unique email.
// An email that is already on the list also answers { ok: true }, so the route cannot be used to find out who has signed up.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const WAITLIST_IP = { bucket: "waitlist_ip", limit: 5, windowSeconds: 3600 };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ROLES = new Set(["buyer", "seller", "both"]);

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (body?.website) return json({ ok: true }); // honeypot: pretend success, store nothing

  const email = String(body?.email ?? "").trim().toLowerCase();
  const role = ROLES.has(body?.role_interest) ? body.role_interest : "buyer";
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "Please enter a valid email address." }, 400);

  const service = createServiceClient();
  if (!service) return json({ error: "Sign-ups are unavailable right now. Please try again later." }, 503);

  const limit = await checkLimit(service, WAITLIST_IP, clientIp(request.headers));
  if (!limit.allowed) return rateLimitedResponse(limit.retryAfterSeconds, "sign-up attempts");

  const { error } = await service.from("waitlist_signups").insert({ email, role_interest: role });
  if (error && error.code !== "23505") return json({ error: "Something went wrong. Please try again." }, 500);
  return json({ ok: true });
}
