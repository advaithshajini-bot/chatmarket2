"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, Mail, CheckCircle2 } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";

// Step 1: enter email, we send Supabase's password-recovery link.
// (Not an OTP code -- that would need a custom "Reset Password" email
// template with {{ .Token }}, which isn't available on the free Supabase
// plan this project runs on. The default template's magic link works on
// every plan.)
// Step 2: "check your email" -- nothing more happens on THIS tab.
// Step 3: only reachable by actually clicking that link. Supabase fires a
// PASSWORD_RECOVERY auth event when the link's session lands back on this
// page, and that event -- not a button click -- is what unlocks the
// "set new password" form. There's no way to skip straight to it.
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [resent, setResent] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const supabase = createClient();
    // Fires once Supabase parses the recovery tokens out of the URL that
    // the emailed link lands on. This is the only path to step 3.
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setStep(3);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSendLink = async (e) => {
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
    setEmailError("");
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: typeof window !== "undefined" ? `${window.location.origin}/forgot-password` : undefined,
    });
    if (error) {
      setEmailError(error.message);
      return;
    }
    setResent(true);
    setTimeout(() => setResent(false), 4000);
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

    // The recovery session that the link created has done its job -- sign
    // out so the account can only be used again by logging in fresh with
    // the new password, rather than leaving this session usable elsewhere.
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
              Enter the email on your account and we'll send you a link to reset your password.
            </p>
            <form onSubmit={handleSendLink} className="space-y-4">
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
                {sending ? "Sending link..." : "Send verification link"}
              </button>
            </form>
            <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
              <Link href="/login" style={{ color: "#14213D", fontWeight: 500 }}>← Back to log in</Link>
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mb-4"
              style={{ background: "#EAF2EF" }}
            >
              <Mail size={20} color="#2F6F62" />
            </div>
            <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Check your email
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              We sent a password reset link to <span style={{ color: "#14213D", fontWeight: 500 }}>{email}</span>. Open it on
              this device to set a new password — this page will pick it up automatically.
            </p>
            {emailError && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{emailError}</p>}
            {resent && <p className="text-xs mb-3" style={{ color: "#2F6F62" }}>Link resent — check your inbox.</p>}
            <p className="text-xs" style={{ color: "#6B6F76" }}>
              Didn't get it?{" "}
              <button onClick={handleResend} style={{ color: "#14213D", fontWeight: 500 }}>
                Resend link
              </button>
            </p>
            <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
              <Link href="/login" style={{ color: "#14213D", fontWeight: 500 }}>← Back to log in</Link>
            </p>
          </>
        )}

        {step === 3 && (
          <>
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mb-4"
              style={{ background: "#EAF2EF" }}
            >
              <CheckCircle2 size={20} color="#2F6F62" />
            </div>
            <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Set a new password
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              Link verified. Choose a new password for your account.
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
