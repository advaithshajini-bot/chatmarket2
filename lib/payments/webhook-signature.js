// lib/payments/webhook-signature.js -- Razorpay webhook signature check (framework-free).
// Razorpay signs the RAW request body: hex(HMAC-SHA256(rawBody, webhookSecret)) in X-Razorpay-Signature.
import crypto from "crypto";

export function computeWebhookSignature(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/** Constant-time check. Never throws; any malformed input is simply "not valid". */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (typeof rawBody !== "string" || typeof signatureHeader !== "string" || typeof secret !== "string" || !secret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const expected = Buffer.from(computeWebhookSignature(rawBody, secret), "hex");
  const given = Buffer.from(signatureHeader.toLowerCase(), "hex");
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

export function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}
