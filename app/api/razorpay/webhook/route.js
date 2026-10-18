import { NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/payments/webhook-handler";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { PLATFORM_FEE_PCT } from "@/lib/constants";
import { createRazorpayClient } from "@/lib/payments/razorpay-client";
import { createTransferForPurchase } from "@/lib/payments/transfers";
import { payoutPurchase } from "@/lib/payments/vpa-payouts";

// Razorpay -> us. Configure in the Razorpay dashboard (Settings -> Webhooks) with events
// `payment.captured` and `order.paid` (+ the `transfer.*` events once Route is activated), and the same secret as
// RAZORPAY_WEBHOOK_SECRET.
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
  const db = createPaymentsDb(service);
  // 5.2: after a successful fulfilment, best-effort start the Route transfer. A no-op while the
  // phase5_route_transfers flag is OFF; any failure is left to the reconciliation sweep.
  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
  const rzp = keyId && keySecret ? createRazorpayClient({ keyId, keySecret, accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || null }) : null;
  // 5.4: and best-effort start the instant UPI payout (also a no-op while phase6_vpa_payouts is OFF; the two are mutually exclusive in the database).
  const afterFulfil = rzp ? async ({ purchaseId }) => {
    try { await createTransferForPurchase({ db, rzp, purchaseId }); } catch { /* left to the sweep */ }
    await payoutPurchase({ db, rzp, purchaseId });
  } : undefined;
  const r = await handleRazorpayWebhook({
    rawBody,
    headers: request.headers,
    secret,
    feePct: PLATFORM_FEE_PCT,
    db,
    afterFulfil,
  });
  return NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
