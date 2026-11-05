import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/payments/service-client";
import { POLICIES, checkLimit, resetLimit, clientIp, rateLimitedResponse } from "@/lib/security/rate-limit";

// POST { email, password }. Password sign-in with brute-force protection: every attempt counts against the caller's IP AND the account (email);
// over the limit -> 429 + Retry-After and the password is not even checked. A successful sign-in clears the account counter (the IP counter keeps running).
// The session cookies are set here, on the server, exactly as the browser sign-in did. Wrong credentials always get the same generic answer.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password || email.length > 254 || password.length > 1024) return json({ error: "Enter your email and password." }, 400);

  const service = createServiceClient();
  const ip = await checkLimit(service, POLICIES.login_ip, clientIp(request.headers));
  if (!ip.allowed) return rateLimitedResponse(ip.retryAfterSeconds, "sign-in attempts");
  const acct = await checkLimit(service, POLICIES.login_account, email);
  if (!acct.allowed) return rateLimitedResponse(acct.retryAfterSeconds, "sign-in attempts");

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const status = error.status === 429 ? 429 : 401;
    return json({ error: status === 429 ? "Too many sign-in attempts. Please try again in a few minutes." : error.message || "Invalid login credentials" }, status);
  }
  await resetLimit(service, POLICIES.login_account, email);
  return json({ ok: true });
}
