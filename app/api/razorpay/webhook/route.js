import { NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/payments/webhook-handler";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { createRazorpayClient } from "@/lib/payments/razorpay-client";
import { PLATFORM_FEE_PCT } from "@/lib/constants";

// Razorpay -> us. Configure in the Razorpay dashboard (Settings -> Webhooks) with events
// `payment.captured` and `order.paid` (+ `refund.*` so refunds and disputes keep tracking), and the same secret as
// RAZORPAY_WEBHOOK_SECRET. For Route (test mode) also subscribe `transfer.processed` and the `account.*` status events. Route orders are split to
// the seller by Razorpay itself; this handler only records the purchase (payment_method 'route', platform_fee 0) and the linked-account status.
// Glue only: all logic lives in lib/payments/webhook-handler.js (unit-tested).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const service = createServiceClient();
  if (!secret || !service) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  // The signature is over the RAW body -- read it as text BEFORE any JSON parsing.
  const rawBody = await request.text();
  const r = await handleRazorpayWebhook({
    rawBody,
    headers: request.headers,
    secret,
    feePct: PLATFORM_FEE_PCT,
    db: createPaymentsDb(service),
    rzp: process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
      ? createRazorpayClient({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET })
      : undefined,
  });
  return NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
