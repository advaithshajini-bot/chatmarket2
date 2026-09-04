import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PCT } from "@/lib/constants";

// Verifies the payment signature server-side before trusting that a payment
// actually happened -- the client-side Checkout.js success callback alone is
// not proof of payment, since it's just JS running in the buyer's browser.
export async function POST(request) {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    return NextResponse.json({ error: "Razorpay isn't configured on this deployment yet." }, { status: 500 });
  }

  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "You need to be logged in to check out." }, { status: 401 });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, listingId, paymentMethod } = await request.json();
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !listingId) {
    return NextResponse.json({ error: "Missing payment details." }, { status: 400 });
  }

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  const signatureValid =
    expectedSignature.length === razorpay_signature.length &&
    crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(razorpay_signature));

  if (!signatureValid) {
    return NextResponse.json({ error: "Payment verification failed — signature mismatch." }, { status: 400 });
  }

  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, price")
    .eq("id", listingId)
    .single();
  if (listingError || !listing) {
    return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  }

  // The client-supplied paymentMethod is just whichever button the buyer
  // clicked before the Razorpay modal opened -- for the "Razorpay" option
  // (and in general) they can still pick a different method inside the
  // modal itself. Fetch the payment record from Razorpay so "Paid via"
  // reflects what was actually used, not what was pre-selected.
  let resolvedPaymentMethod = paymentMethod || "razorpay";
  try {
    const paymentRes = await fetch(`https://api.razorpay.com/v1/payments/${razorpay_payment_id}`, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64"),
      },
    });
    const paymentData = await paymentRes.json();
    if (paymentRes.ok && paymentData.method) {
      resolvedPaymentMethod = paymentData.method;
    }
  } catch (e) {
    // Fall back to the client-supplied value below rather than failing
    // the whole purchase over a "Paid via" label.
  }

  const { data: purchase, error: insertError } = await supabase
    .from("purchases")
    .insert({
      user_id: userData.user.id,
      listing_id: listingId,
      amount: listing.price,
      payment_method: resolvedPaymentMethod,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      platform_fee: Number(listing.price) * PLATFORM_FEE_PCT,
    })
    .select("id")
    .single();

  if (insertError) {
    // 23505 = unique_violation on (user_id, listing_id) -- the payment was
    // genuinely verified, they just already had a purchase row (e.g. a
    // retried request). Look it up rather than treating this as a failure.
    if (insertError.code === "23505") {
      const { data: existing } = await supabase
        .from("purchases")
        .select("id")
        .eq("user_id", userData.user.id)
        .eq("listing_id", listingId)
        .single();
      return NextResponse.json({ success: true, purchaseId: existing?.id });
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, purchaseId: purchase.id });
}
