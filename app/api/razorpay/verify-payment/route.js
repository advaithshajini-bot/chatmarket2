import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PCT } from "@/lib/constants";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { verifyResponseFor } from "@/lib/payments/fulfilment";

// Browser-side confirmation after Checkout.js. The Razorpay `payment.captured` webhook now does the same job
// without needing the browser, and both call the SAME idempotent database function, so whichever arrives first
// wins and the other is a harmless "already_fulfilled".
//
// The signature proves this browser really completed THIS payment of THIS order. The order -> (buyer, listing,
// amount) mapping comes from our own payment_orders row, never from the request body.
export async function POST(request) {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return NextResponse.json({ error: "Razorpay isn't configured on this deployment yet." }, { status: 500 });
  }

  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "You need to be logged in to check out." }, { status: 401 });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, paymentMethod } = await request.json();
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return NextResponse.json({ error: "Missing payment details." }, { status: 400 });
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  const signatureValid =
    expectedSignature.length === String(razorpay_signature).length &&
    crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(String(razorpay_signature)));

  if (!signatureValid) {
    return NextResponse.json({ error: "Payment verification failed — signature mismatch." }, { status: 400 });
  }

  const service = createServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Checkout isn't fully configured on this deployment yet." }, { status: 500 });
  }

  // Ask Razorpay what was really paid and how (the "Paid via" label and the amount). If the lookup fails we fall
  // back to the order's own amount: the signature already proves this order was paid.
  let resolvedPaymentMethod = typeof paymentMethod === "string" ? paymentMethod : "razorpay";
  let paidAmountPaise = null;
  try {
    const paymentRes = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
      },
    });
    const paymentData = await paymentRes.json();
    if (paymentRes.ok) {
      if (paymentData.method) resolvedPaymentMethod = paymentData.method;
      if (paymentData.status === "failed") {
        return NextResponse.json({ error: "This payment did not go through." }, { status: 402 });
      }
      if (Number.isInteger(paymentData.amount)) paidAmountPaise = paymentData.amount;
    }
  } catch (e) {
    // fall through with the defaults above
  }

  try {
    const result = await createPaymentsDb(service).fulfil({
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      amountPaise: paidAmountPaise,
      currency: "INR",
      method: resolvedPaymentMethod,
      signature: razorpay_signature,
      feePct: PLATFORM_FEE_PCT,
      expectedUserId: userData.user.id,
      eventId: null,
    });
    const r = verifyResponseFor(result);
    return NextResponse.json(r.json, { status: r.status });
  } catch {
    return NextResponse.json({ error: "Couldn't record the purchase." }, { status: 500 });
  }
}
