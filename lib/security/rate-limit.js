// lib/security/rate-limit.js -- SERVER-ONLY helpers around the database limiter (public.rate_limit_hit / rate_limit_reset, service_role only).
// The counters live in Postgres, so every serverless instance shares them. Keys are SHA-256 hashes: no raw email or IP is stored.
// If the service key is missing or the limiter call itself fails, the request is ALLOWED (a limiter outage must not lock every user out);
// the seller-write triggers in the database and Supabase's own auth limits remain as backstops.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server.js";

export const POLICIES = Object.freeze({
  login_ip:      { bucket: "login_ip",      limit: 20, windowSeconds: 900 },   // 20 sign-in attempts per IP per 15 minutes
  login_account: { bucket: "login_account", limit: 8,  windowSeconds: 900 },   // 8 attempts per account (email) per 15 minutes; cleared by a successful login
  identity:      { bucket: "identity_api",  limit: 5,  windowSeconds: 3600 },  // 5 PAN / identity submissions per seller per hour
  bank:          { bucket: "bank_api",      limit: 5,  windowSeconds: 3600 },  // 5 bank-detail submissions per seller per hour
});

export const hashKey = (value) => createHash("sha256").update(String(value ?? "").trim().toLowerCase()).digest("hex");

/** Client IP as set by the platform proxy (first entry of x-forwarded-for, else x-real-ip). "unknown" when absent. */
export function clientIp(headers) {
  const xff = headers?.get?.("x-forwarded-for");
  const first = xff ? xff.split(",")[0].trim() : "";
  return first || headers?.get?.("x-real-ip")?.trim() || "unknown";
}

/** Count one attempt. Returns { allowed, retryAfterSeconds, degraded? }. Never throws. */
export async function checkLimit(service, policy, rawKey) {
  if (!service) return { allowed: true, retryAfterSeconds: 0, degraded: true };
  try {
    const { data, error } = await service.rpc("rate_limit_hit", {
      p_bucket: policy.bucket, p_key: hashKey(rawKey), p_limit: policy.limit, p_window_seconds: policy.windowSeconds,
    });
    if (error || !data || typeof data.allowed !== "boolean") return { allowed: true, retryAfterSeconds: 0, degraded: true };
    return { allowed: data.allowed, retryAfterSeconds: Number(data.retry_after_seconds) || 0 };
  } catch {
    return { allowed: true, retryAfterSeconds: 0, degraded: true };
  }
}

export async function resetLimit(service, policy, rawKey) {
  if (!service) return;
  try { await service.rpc("rate_limit_reset", { p_bucket: policy.bucket, p_key: hashKey(rawKey) }); } catch { /* best effort */ }
}

export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 60));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.ceil(s / 60);
  return m < 90 ? `${m} minutes` : `${Math.ceil(m / 60)} hours`;
}

/** 429 with Retry-After and a message that never says which limit (IP or account) was hit. */
export function rateLimitedResponse(retryAfterSeconds, what = "attempts") {
  const s = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 60));
  return NextResponse.json(
    { error: `Too many ${what}. Please try again in ${waitText(s)}.`, code: "rate_limited", retryAfterSeconds: s },
    { status: 429, headers: { "Retry-After": String(s), "Cache-Control": "no-store" } },
  );
}
