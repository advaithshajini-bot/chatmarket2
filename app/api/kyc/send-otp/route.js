import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";

// Real OTP generation/storage/expiry — the only thing not real here is
// delivery. No SMS provider (Twilio, MSG91, etc.) or transactional email
// service is connected yet, so instead of pretending to send it, the code
// is returned directly in the response with devMode: true. This is NOT a
// production security posture — it's an honest stand-in until a real
// provider is wired up, clearly labeled as such end to end (here, in the
// UI, and in the README) rather than silently faking a "sent" state.
export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "You need to be logged in." }, { status: 401 });
  }

  const { channel, mobileCountryCode, mobileNumber, email } = await request.json();
  if (channel !== "mobile" && channel !== "email") {
    return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
  }
  if (channel === "mobile" && (!mobileCountryCode || !mobileNumber)) {
    return NextResponse.json({ error: "Enter a country code and mobile number first." }, { status: 400 });
  }
  if (channel === "email" && !email) {
    return NextResponse.json({ error: "Enter an email address first." }, { status: 400 });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const updateFields =
    channel === "mobile"
      ? {
          mobile_country_code: mobileCountryCode,
          mobile_number: mobileNumber,
          mobile_verified: false,
          mobile_otp_hash: hash,
          mobile_otp_expires_at: expiresAt,
          mobile_otp_attempts: 0,
        }
      : {
          email,
          email_verified: false,
          email_otp_hash: hash,
          email_otp_expires_at: expiresAt,
          email_otp_attempts: 0,
        };

  const { error: upsertError } = await supabase
    .from("seller_kyc")
    .upsert({ user_id: userData.user.id, ...updateFields }, { onConflict: "user_id" });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    devMode: true,
    devOtp: code,
    message: "No SMS/email provider is connected yet, so the code is shown here directly instead of being sent.",
  });
}
