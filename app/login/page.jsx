"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { LogIn, CheckCircle2 } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/browse";
  const justVerified = searchParams.get("verified") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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
            <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Password</label>
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
