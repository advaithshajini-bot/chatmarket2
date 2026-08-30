import { NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@/lib/supabase/server";

const MAX_ATTEMPTS = 5;

export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "You need to be logged in." }, { status: 401 });
  }

  const { channel, code } = await request.json();
  if (channel !== "mobile" && channel !== "email") {
    return NextResponse.json({ error: "Invalid channel." }, { status: 400 });
  }

  const { data: kyc, error: fetchError } = await supabase
    .from("seller_kyc")
    .select("mobile_otp_hash, mobile_otp_expires_at, mobile_otp_attempts, email_otp_hash, email_otp_expires_at, email_otp_attempts")
    .eq("user_id", userData.user.id)
    .single();

  if (fetchError || !kyc) {
    return NextResponse.json({ error: "No OTP was sent yet — send one first." }, { status: 400 });
  }

  const hashField = channel === "mobile" ? "mobile_otp_hash" : "email_otp_hash";
  const expiresField = channel === "mobile" ? "mobile_otp_expires_at" : "email_otp_expires_at";
  const attemptsField = channel === "mobile" ? "mobile_otp_attempts" : "email_otp_attempts";
  const verifiedField = channel === "mobile" ? "mobile_verified" : "email_verified";

  if (!kyc[hashField] || !kyc[expiresField]) {
    return NextResponse.json({ error: "No OTP was sent yet — send one first." }, { status: 400 });
  }
  if (new Date(kyc[expiresField]) < new Date()) {
    return NextResponse.json({ error: "That code has expired — request a new one." }, { status: 400 });
  }
  if (kyc[attemptsField] >= MAX_ATTEMPTS) {
    return NextResponse.json({ error: "Too many incorrect attempts — request a new code." }, { status: 400 });
  }

  const submittedHash = crypto.createHash("sha256").update(String(code || "")).digest("hex");

  if (submittedHash !== kyc[hashField]) {
    await supabase
      .from("seller_kyc")
      .update({ [attemptsField]: kyc[attemptsField] + 1 })
      .eq("user_id", userData.user.id);
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  const { error: updateError } = await supabase
    .from("seller_kyc")
    .update({ [verifiedField]: true, [hashField]: null, [expiresField]: null, [attemptsField]: 0 })
    .eq("user_id", userData.user.id);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
