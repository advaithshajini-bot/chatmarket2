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

    router.push(next);
    router.refresh();
  };

  if (checkingSession) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-sm mx-auto text-center">
          <p className="text-sm" style={{ color: "#6B6F76" }}>Confirming your email…</p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
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
