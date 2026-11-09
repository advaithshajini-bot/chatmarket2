"use client";

import { useState } from "react";

const ROLES = [
  { id: "buyer", label: "Buyer" },
  { id: "seller", label: "Creator" },
  { id: "both", label: "Both" },
];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const FONT = "'IBM Plex Sans', sans-serif";

/** Waitlist capture. POSTs to /api/waitlist. `source` is only a label (landing, ig, yt...) so you can see which channel brings sign-ups. */
export default function WaitlistForm({ source = "site" }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("buyer");
  const [website, setWebsite] = useState(""); // honeypot: hidden from people, bots fill it
  const [state, setState] = useState({ status: "idle", message: "" });

  async function submit(e) {
    e.preventDefault();
    const clean = email.trim();
    if (!EMAIL_RE.test(clean) || clean.length > 254) {
      setState({ status: "error", message: "Please enter a valid email address." });
      return;
    }
    setState({ status: "loading", message: "" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: clean, role_interest: role, source, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ status: "error", message: data.error || "Something went wrong. Please try again." });
        return;
      }
      setState({ status: "done", message: "" });
    } catch {
      setState({ status: "error", message: "Network problem. Please check your connection and try again." });
    }
  }

  if (state.status === "done") {
    return (
      <div role="status" aria-live="polite" style={{ textAlign: "center", padding: "8px 0" }}>
        <p style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 22, color: "#14213D", marginBottom: 8 }}>You're on the list.</p>
        <p style={{ fontFamily: FONT, fontSize: 14.5, lineHeight: 1.6, color: "#3A3D42" }}>
          ChatMarket opens in <strong>January 2027</strong>. We'll email you once, on the day the doors open. Nothing else in between.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: "grid", gap: 16, fontFamily: FONT }}>
      <div style={{ display: "grid", gap: 6 }}>
        <label htmlFor="wl-email" style={{ fontSize: 13, fontWeight: 600, color: "#14213D" }}>Email address</label>
        <input
          id="wl-email" type="email" inputMode="email" autoComplete="email" required value={email}
          onChange={(e) => { setEmail(e.target.value); if (state.status === "error") setState({ status: "idle", message: "" }); }}
          placeholder="you@example.com"
          aria-invalid={state.status === "error"} aria-describedby={state.status === "error" ? "wl-error" : undefined}
          style={{ border: "1px solid #14213D", background: "#fff", padding: "12px 14px", fontSize: 16, borderRadius: 6, width: "100%", color: "#14213D" }}
        />
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, color: "#14213D", marginBottom: 8 }}>I'm joining as a</legend>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {ROLES.map((r) => (
            <label key={r.id} style={{ flex: "1 1 0", minWidth: 90, cursor: "pointer" }}>
              <input type="radio" name="role_interest" value={r.id} checked={role === r.id} onChange={() => setRole(r.id)} style={{ position: "absolute", opacity: 0, pointerEvents: "none" }} />
              <span style={{
                display: "block", textAlign: "center", padding: "10px 12px", borderRadius: 6, fontSize: 14,
                border: role === r.id ? "1px solid #14213D" : "1px solid #D8D5C9",
                background: role === r.id ? "#14213D" : "#fff", color: role === r.id ? "#F7F7F4" : "#14213D",
              }}>{r.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", height: 0, overflow: "hidden" }}>
        <label>Leave this empty<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
      </div>

      <button type="submit" disabled={state.status === "loading"} className="lbtn-primary" style={{ justifyContent: "center", border: 0, cursor: "pointer", opacity: state.status === "loading" ? 0.7 : 1, width: "100%" }}>
        {state.status === "loading" ? "Joining…" : "Join the January 2027 Waitlist"}
      </button>
      {state.status === "error" && <p id="wl-error" role="alert" style={{ color: "#B3261E", fontSize: 13.5 }}>{state.message}</p>}
      <p style={{ fontSize: 12, color: "#6B6F76", textAlign: "center" }}>We use your email only to tell you when ChatMarket launches.</p>
    </form>
  );
}
