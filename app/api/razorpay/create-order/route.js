import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";

// Phase 1 of real Razorpay integration: standard Orders API for buyer
// checkout. This doesn't need Route/seller payouts to work — funds land in
// the platform account, same as any non-marketplace Razorpay integration.
// Route (splitting to sellers) is a separate phase once Route is approved
// on the account.
export async function POST(request) {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return NextResponse.json({ error: "Razorpay isn't configured on this deployment yet." }, { status: 500 });
  }

  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "You need to be logged in to check out." }, { status: 401 });
  }

  // Flag `direct_upi_checkout` ON: buyers pay the seller's UPI ID directly and the platform never takes the money, so no gateway order is created.
  const { data: directOnly } = await supabase.rpc("direct_upi_checkout_enabled");
  if (directOnly === true) {
    return NextResponse.json({ error: "Payments now go directly to the seller. Refresh the page to see the new checkout." }, { status: 403 });
  }

  const { listingId } = await request.json();
  if (!listingId) {
    return NextResponse.json({ error: "Missing listingId." }, { status: 400 });
  }

  // Always price from the DB, never trust an amount from the client.
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, price, status, title")
    .eq("id", listingId)
    .single();

  if (listingError || !listing) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }
  if (listing.status !== "live") {
    return NextResponse.json({ error: "This listing isn't available for purchase." }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("purchases")
    .select("id")
    .eq("user_id", userData.user.id)
    .eq("listing_id", listingId)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "You already own this thread." }, { status: 409 });
  }

  const amountPaise = Math.round(Number(listing.price) * 100);

  const razorpayRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      // Razorpay caps receipt at 40 chars.
      receipt: `l_${listingId.replace(/-/g, "").slice(0, 20)}_${Date.now().toString(36)}`,
      notes: { listingId, userId: userData.user.id },
    }),
  });

  const razorpayData = await razorpayRes.json();
  if (!razorpayRes.ok) {
    return NextResponse.json({ error: razorpayData.error?.description || "Razorpay order creation failed." }, { status: 502 });
  }

  // Record who is paying for what BEFORE handing the order id to the browser. The webhook (and verify-payment)
  // resolve a payment through this row, so an order we cannot record must not be payable.
  const service = createServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Checkout isn't fully configured on this deployment yet." }, { status: 500 });
  }
  try {
    await createPaymentsDb(service).recordPaymentOrder({
      orderId: razorpayData.id,
      userId: userData.user.id,
      listingId: listing.id,
      amountPaise,
    });
  } catch {
    return NextResponse.json({ error: "Couldn't start checkout. Please try again." }, { status: 502 });
  }

  return NextResponse.json({
    orderId: razorpayData.id,
    amount: razorpayData.amount,
    currency: razorpayData.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    listingTitle: listing.title,
  });
}
