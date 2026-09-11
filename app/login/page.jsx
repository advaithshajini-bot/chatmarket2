"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { LogIn, CheckCircle2 } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.92l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.11A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54V6.62H1.26a12 12 0 0 0 0 10.76l4.01-3.11Z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.26 6.62l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/browse";
  const justVerified = searchParams.get("verified") === "1";
  const justReset = searchParams.get("reset") === "1";
  const oauthError = searchParams.get("error") === "oauth";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(justVerified);

  // Set once a password sign-in succeeds for an account that has MFA
  // enrolled (only admins, in practice) and the session still needs to be
  // elevated to aal2 before it's actually usable for sensitive actions.
  const [mfaChallenge, setMfaChallenge] = useState(null); // { factorId, challengeId }
  const [mfaCode, setMfaCode] = useState("");
  const [mfaError, setMfaError] = useState("");
  const [mfaVerifying, setMfaVerifying] = useState(false);

  useEffect(() => {
    // The email confirmation link redirects here carrying a session token in
    // the URL (Supabase's implicit-grant flow) — the client picks that up
    // automatically. If it did, there's no reason to make them fill out the
    // login form again; forward them straight in.
    if (!justVerified) return;
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.push(next);
        router.refresh();
      } else {
        setCheckingSession(false);
      }
    });
  }, [justVerified, next, router]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    // Password alone only gets an aal1 session. If this account has an
    // MFA factor enrolled (only admins, via /admin/security), the session
    // needs a second step before it's elevated to aal2 -- otherwise every
    // admin write will silently fail against the aal2-gated policies even
    // though sign-in "succeeded".
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData && aalData.nextLevel === "aal2" && aalData.currentLevel !== "aal2") {
      const { data: factorsData } = await supabase.auth.mfa.listFactors();
      const factor = factorsData?.totp?.[0];
      if (factor) {
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id });
        if (challengeError) {
          setError(challengeError.message);
          setLoading(false);
          return;
        }
        setMfaChallenge({ factorId: factor.id, challengeId: challengeData.id });
        setLoading(false);
        return;
      }
    }

    router.push(next);
    router.refresh();
  };

  const handleVerifyMfa = async (e) => {
    e.preventDefault();
    setMfaError("");
    setMfaVerifying(true);

    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: mfaChallenge.factorId,
      challengeId: mfaChallenge.challengeId,
      code: mfaCode,
    });

    setMfaVerifying(false);
    if (verifyError) {
      setMfaError(verifyError.message);
      return;
    }

    router.push(next);
    router.refresh();
  };

  const handleGoogleSignIn = async () => {
    setError("");
    setGoogleLoading(true);
    const supabase = createClient();
    const { error: oauthErr } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    // On success, Supabase redirects the browser to Google immediately —
    // this only returns (with an error) if that redirect never happened.
    if (oauthErr) {
      setError(oauthErr.message);
      setGoogleLoading(false);
    }
  };

  if (mfaChallenge) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav hideAuthLinks />
        <main className="px-6 py-16 max-w-sm mx-auto">
          <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            Enter your code
          </h1>
          <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
            This account has two-factor authentication on — enter the 6-digit code from your authenticator app.
          </p>
          <form onSubmit={handleVerifyMfa} className="space-y-4">
            <input
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              autoFocus
              className="w-full px-3 py-2.5 rounded text-center text-lg tracking-widest outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
            />
            {mfaError && <p className="text-xs" style={{ color: "#B33A2E" }}>{mfaError}</p>}
            <button
              type="submit"
              disabled={mfaCode.length !== 6 || mfaVerifying}
              className="w-full py-3 rounded text-sm"
              style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
            >
              {mfaVerifying ? "Verifying…" : "Verify"}
            </button>
          </form>
        </main>
      </div>
    );
  }

  if (checkingSession) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav hideAuthLinks />
        <main className="px-6 py-16 max-w-sm mx-auto text-center">
          <p className="text-sm" style={{ color: "#6B6F76" }}>Confirming your email…</p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav hideAuthLinks />
      <main className="px-6 py-16 max-w-sm mx-auto">
        <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Log in
        </h1>
        <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
          Sign in with the account you created, or <Link href="/signup" style={{ color: "#14213D", fontWeight: 500 }}>create one</Link>.
        </p>

        {justVerified && (
          <div className="flex items-start gap-2 p-3 rounded-md mb-5" style={{ background: "#EAF2EF", border: "1px solid #CFE4DE" }}>
            <CheckCircle2 size={15} color="#2F6F62" className="mt-0.5 shrink-0" />
            <p className="text-xs" style={{ color: "#2F6F62" }}>Email confirmed — log in below to continue.</p>
          </div>
        )}

        {justReset && (
          <div className="flex items-start gap-2 p-3 rounded-md mb-5" style={{ background: "#EAF2EF", border: "1px solid #CFE4DE" }}>
            <CheckCircle2 size={15} color="#2F6F62" className="mt-0.5 shrink-0" />
            <p className="text-xs" style={{ color: "#2F6F62" }}>Password updated — log in with your new password.</p>
          </div>
        )}

        {oauthError && (
          <div className="flex items-start gap-2 p-3 rounded-md mb-5" style={{ background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
            <p className="text-xs" style={{ color: "#B33A2E" }}>Google sign-in didn't go through — try again.</p>
          </div>
        )}

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={googleLoading}
          className="w-full py-3 rounded text-sm inline-flex items-center justify-center gap-2 mb-4"
          style={{ border: "1px solid #D8D5C9", background: "#FFFFFF", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
        >
          <GoogleIcon /> {googleLoading ? "Redirecting to Google…" : "Continue with Google"}
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div style={{ flex: 1, borderTop: "1px solid #D8D5C9" }} />
          <span className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>OR</span>
          <div style={{ flex: 1, borderTop: "1px solid #D8D5C9" }} />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2.5 rounded text-sm outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
              required
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs uppercase tracking-wide block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Password</label>
              <Link
                href="/forgot-password"
                className="text-xs inline-flex items-center gap-1"
                style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
              >
                <span
                  className="inline-flex items-center justify-center rounded-full"
                  style={{ width: 14, height: 14, background: "#D8D5C9", color: "#14213D", fontSize: 10, fontWeight: 700 }}
                >
                  ?
                </span>
                Forgot password
              </Link>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 rounded text-sm outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
              required
            />
          </div>

          {error && <p className="text-xs" style={{ color: "#B33A2E" }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded text-sm inline-flex items-center justify-center gap-2"
            style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            <LogIn size={15} /> {loading ? "Logging in..." : "Log in"}
          </button>
        </form>

        <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
          New here? <Link href="/signup" style={{ color: "#14213D", fontWeight: 500 }}>Create an account</Link>
        </p>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
