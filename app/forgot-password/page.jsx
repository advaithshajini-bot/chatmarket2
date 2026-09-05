"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, CheckCircle2 } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";

// Step 1: buyer/seller enters their email, we email them a 6-digit code
// (Supabase's password-recovery OTP -- the "reset password" email template
// on the project needs to include {{ .Token }} for this to arrive as a
// code rather than only a magic link; see README).
// Step 2: they enter that code, which opens a short-lived recovery session.
// Step 3: with that recovery session active, they set + confirm a new
// password via supabase.auth.updateUser().
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState("");

  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [resent, setResent] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const handleSendCode = async (e) => {
    e.preventDefault();
    setEmailError("");
    setSending(true);

    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== "undefined" ? `${window.location.origin}/forgot-password` : undefined,
    });

    setSending(false);
    if (error) {
      setEmailError(error.message);
      return;
    }
    setStep(2);
  };

  const handleResend = async () => {
    setCodeError("");
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== "undefined" ? `${window.location.origin}/forgot-password` : undefined,
    });
    if (error) {
      setCodeError(error.message);
      return;
    }
    setResent(true);
    setTimeout(() => setResent(false), 4000);
  };

  const handleVerifyCode = async (e) => {
    e.preventDefault();
    setCodeError("");
    setVerifying(true);

    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "recovery" });

    setVerifying(false);
    if (error) {
      setCodeError(error.message);
      return;
    }
    setStep(3);
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setSaveError("");

    if (newPassword.length < 6) {
      setSaveError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setSaveError("Passwords don't match.");
      return;
    }

    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);

    if (error) {
      setSaveError(error.message);
      return;
    }

    // The recovery session that verifyOtp created has done its job -- sign
    // out so they log back in fresh with the new password, per the request.
    await supabase.auth.signOut();
    router.push("/login?reset=1");
  };

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav hideAuthLinks />
      <main className="px-6 py-16 max-w-sm mx-auto">
        {step === 1 && (
          <>
            <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Reset your password
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              Enter the email on your account and we'll send you a verification code.
            </p>
            <form onSubmit={handleSendCode} className="space-y-4">
              <div>
                <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2.5 rounded text-sm outline-none"
                  style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
                  required
                />
              </div>
              {emailError && <p className="text-xs" style={{ color: "#B33A2E" }}>{emailError}</p>}
              <button
                type="submit"
                disabled={sending}
                className="w-full py-3 rounded text-sm"
                style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
              >
                {sending ? "Sending code..." : "Send verification code"}
              </button>
            </form>
            <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
              <Link href="/login" style={{ color: "#14213D", fontWeight: 500 }}>← Back to log in</Link>
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Enter your code
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              We sent a 6-digit verification code to <span style={{ color: "#14213D", fontWeight: 500 }}>{email}</span>.
            </p>
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoFocus
                className="w-full px-3 py-2.5 rounded text-center text-lg tracking-widest outline-none"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
              />
              {codeError && <p className="text-xs" style={{ color: "#B33A2E" }}>{codeError}</p>}
              {resent && <p className="text-xs" style={{ color: "#2F6F62" }}>Code resent — check your inbox.</p>}
              <button
                type="submit"
                disabled={code.length !== 6 || verifying}
                className="w-full py-3 rounded text-sm"
                style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
              >
                {verifying ? "Verifying..." : "Verify code"}
              </button>
            </form>
            <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
              Didn't get it?{" "}
              <button onClick={handleResend} style={{ color: "#14213D", fontWeight: 500 }}>
                Resend code
              </button>
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Set a new password
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              Choose a new password for your account.
            </p>
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  New password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2.5 rounded text-sm outline-none"
                  style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
                  required
                />
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  Confirm new password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3 py-2.5 rounded text-sm outline-none"
                  style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
                  required
                />
              </div>
              {saveError && <p className="text-xs" style={{ color: "#B33A2E" }}>{saveError}</p>}
              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded text-sm inline-flex items-center justify-center gap-2"
                style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
              >
                <KeyRound size={15} /> {saving ? "Updating..." : "Update password"}
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
