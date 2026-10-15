// lib/payments/sweep-handler.js -- auth + dispatch for the reconciliation sweep (framework-free).
// Authenticated by a shared secret in "Authorization: Bearer <CRON_SECRET>" (what Vercel Cron sends when the
// CRON_SECRET env var is set). Fails closed: no secret configured = 500, wrong/missing header = 401.
import crypto from "crypto";

export function bearerMatches(headerValue, secret) {
  if (typeof headerValue !== "string" || typeof secret !== "string" || secret.length < 16) return false;
  const given = crypto.createHash("sha256").update(headerValue).digest();
  const want = crypto.createHash("sha256").update(`Bearer ${secret}`).digest();
  return crypto.timingSafeEqual(given, want);
}

export async function handleSweepRequest({ authorization, secret, sweep }) {
  if (!secret || secret.length < 16) return { status: 500, json: { error: "sweep not configured" } };
  if (!bearerMatches(authorization, secret)) return { status: 401, json: { error: "unauthorized" } };
  try {
    return { status: 200, json: { ok: true, ...(await sweep()) } };
  } catch {
    return { status: 500, json: { error: "sweep failed" } };
  }
}
