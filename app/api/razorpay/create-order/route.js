import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { buildOrderBody } from "@/lib/domain/route";

// Standard Razorpay Orders API for buyer checkout. Flag the Route flag OFF: funds land in the platform account.
// Flag ON (Route, test mode first): the order carries ONE transfer for 100% of the amount to the seller's activated linked account,
// so Razorpay splits at capture. chatmarket commission is 0. The Route flag takes precedence over the direct-UPI flag.
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
  const { data: routeOn } = await supabase.rpc("route_checkout_enabled");
  const { data: directOnly } = await supabase.rpc("direct_upi_checkout_enabled");
  if (directOnly === true && routeOn !== true) {
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

  // Route: resolve the seller's linked account on the server (never from the client). No activated account -> no order.
  const service = createServiceClient();
  if (!service) {
    return NextResponse.json({ error: "Checkout isn't fully configured on this deployment yet." }, { status: 500 });
  }
  const paymentsDb = createPaymentsDb(service);
  let routeAccountId = null;
  if (routeOn === true) {
    let target;
    try { target = await paymentsDb.routeCheckoutTarget({ listingId: listing.id }); }
    catch { return NextResponse.json({ error: "Couldn't start checkout. Please try again." }, { status: 502 }); }
    if (!target?.available) {
      return NextResponse.json({ error: "This seller hasn't finished setting up payments yet.", code: "seller_not_ready" }, { status: 409 });
    }
    routeAccountId = target.account_id;
  }

  const razorpayRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
    },
    body: JSON.stringify(buildOrderBody({ amountPaise, listingId, userId: userData.user.id, accountId: routeAccountId })),
  });

  const razorpayData = await razorpayRes.json();
  if (!razorpayRes.ok) {
    return NextResponse.json({ error: razorpayData.error?.description || "Razorpay order creation failed." }, { status: 502 });
  }

  // Record who is paying for what BEFORE handing the order id to the browser. The webhook (and verify-payment)
  // resolve a payment through this row, so an order we cannot record must not be payable.
  try {
    if (routeAccountId) {
      await paymentsDb.recordRoutePaymentOrder({ orderId: razorpayData.id, userId: userData.user.id, listingId: listing.id, amountPaise, accountId: routeAccountId });
    } else {
      await paymentsDb.recordPaymentOrder({ orderId: razorpayData.id, userId: userData.user.id, listingId: listing.id, amountPaise });
    }
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
