import { NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/payments/webhook-handler";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { PLATFORM_FEE_PCT } from "@/lib/constants";

// Razorpay -> us. Configure in the Razorpay dashboard (Settings -> Webhooks) with events
// `payment.captured` and `order.paid` (+ `refund.*` so refunds and disputes keep tracking), and the same secret as
// RAZORPAY_WEBHOOK_SECRET. Sellers are paid by hand once a month (no Route transfers, no payouts): nothing runs after fulfilment.
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
  });
  return NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
