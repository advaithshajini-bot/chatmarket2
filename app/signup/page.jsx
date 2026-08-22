"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const supabase = createClient();
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: name } },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    // If the Supabase project requires email confirmation, signUp succeeds
    // but returns no active session yet.
    if (!data.session) {
      setCheckEmail(true);
      setLoading(false);
      return;
    }

    router.push("/browse");
    router.refresh();
  };

  if (checkEmail) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-sm mx-auto text-center">
          <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            Check your email
          </h1>
          <p className="text-sm" style={{ color: "#6B6F76" }}>
            We sent a confirmation link to <strong>{email}</strong>. Click it, then{" "}
            <Link href="/login" style={{ color: "#14213D", fontWeight: 500 }}>log in</Link>.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-sm mx-auto">
        <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          Create an account
        </h1>
        <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
          One account works for both buying and selling threads.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 rounded text-sm outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
              required
            />
          </div>
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
            <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>At least 6 characters</p>
          </div>

          {error && <p className="text-xs" style={{ color: "#B33A2E" }}>{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded text-sm inline-flex items-center justify-center gap-2"
            style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            <UserPlus size={15} /> {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="text-xs mt-5" style={{ color: "#6B6F76" }}>
          Already have an account? <Link href="/login" style={{ color: "#14213D", fontWeight: 500 }}>Log in</Link>
        </p>
      </main>
    </div>
  );
}
