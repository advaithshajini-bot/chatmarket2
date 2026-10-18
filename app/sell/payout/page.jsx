"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Zap, Info, Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";
import { validateUpi, maskUpi } from "@/lib/domain/upi";

// 5.4: sellers add ONE thing -- a UPI ID. No documents, no bank details, no business verification.
// Everything is validated again by the database function set_my_payout_vpa (the same rule), so this form is only the friendly layer.
const MONO = { fontFamily: "'IBM Plex Mono', monospace" };

function explain(error) {
  const m = error?.message || "";
  if (/too_many_changes/.test(m)) return "You've changed your UPI ID several times today. Please try again tomorrow.";
  if (/invalid_vpa/.test(m) || error?.code === "CM075") return "That doesn't look like a valid UPI ID.";
  if (error?.code === "42501") return "Please log in again to save your UPI ID.";
  return "We couldn't save that just now. Please try again in a moment.";
}

export default function PayoutPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [saved, setSaved] = useState(null);       // { vpa_address, status } | null
  const [input, setInput] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);   // { tone: "ok" | "err", text }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!live) return;
        setUserId(user?.id ?? null);
        if (user) {
          const { data } = await supabase.from("seller_payout_accounts").select("vpa_address, status").eq("user_id", user.id).maybeSingle();
          if (live && data) { setSaved(data); setInput(data.vpa_address ?? ""); }
        }
      } catch { /* shows the empty form */ }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const v = validateUpi(input);
  const unchanged = saved?.vpa_address && v.value === saved.vpa_address;
  const showError = touched && v.error;

  async function save(e) {
    e.preventDefault();
    setTouched(true);
    if (!v.ok || saving) return;
    setSaving(true); setMessage(null);
    const { data, error } = await supabase.rpc("set_my_payout_vpa", { p_vpa: v.value });
    setSaving(false);
    if (error) { setMessage({ tone: "err", text: explain(error) }); return; }
    setSaved({ vpa_address: v.value, status: saved?.status ?? "active" });
    setInput(v.value);
    setMessage({ tone: "ok", text: data?.outcome === "unchanged" ? "That UPI ID is already saved." : "UPI ID saved. Your sales will be paid to it instantly." });
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-10 max-w-xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Get paid instantly</h1>
        <p className="text-sm mb-6" style={{ color: "#3A3D42" }}>
          Add your UPI ID and we&apos;ll send your share of every sale straight to it, as soon as the sale is complete. No documents, no bank details, no waiting period.
        </p>

        {loading ? (
          <p className="text-sm" style={{ color: "#6B6F76" }}><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</p>
        ) : !userId ? (
          <div className="rounded-md p-5 text-center" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
            <Lock size={20} color="#6B6F76" className="mx-auto mb-2" />
            <p className="text-sm mb-3" style={{ color: "#6B6F76" }}>Log in to add your UPI ID.</p>
            <Link href="/login?next=/sell/payout" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
          </div>
        ) : (
          <form onSubmit={save} noValidate>
            {saved?.vpa_address && (
              <p className="text-sm mb-4 flex items-center gap-2" style={{ color: "#2F6F62" }}>
                <CheckCircle2 size={15} /> Payouts go to <span style={MONO}>{maskUpi(saved.vpa_address)}</span>
              </p>
            )}
            {saved?.status === "suspended" && (
              <p className="text-sm mb-4" style={{ color: "#B33A2E" }} role="alert">Payouts to your account are paused. Please contact support.</p>
            )}

            <label htmlFor="upi" className="text-sm mb-1.5 block" style={{ color: "#14213D" }}>Your UPI ID</label>
            <input
              id="upi" name="upi" type="text" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
              value={input} onChange={(e) => { setInput(e.target.value); setMessage(null); }} onBlur={() => setTouched(true)}
              placeholder="name@okhdfcbank"
              aria-invalid={showError ? "true" : "false"} aria-describedby="upi-help"
              className="w-full px-3 py-2.5 rounded-md text-sm outline-none"
              style={{ background: "#FFFFFF", border: `1px solid ${showError ? "#B33A2E" : v.ok ? "#2F6F62" : "#D8D5C9"}`, color: "#14213D", ...MONO }}
            />
            <p id="upi-help" className="text-xs mt-1.5 min-h-[1.25rem]" style={{ color: showError ? "#B33A2E" : v.ok ? "#2F6F62" : "#6B6F76" }} role={showError ? "alert" : undefined}>
              {showError ? v.error : v.ok ? "Looks good." : "Find it in your UPI app (Google Pay, PhonePe, Paytm…) under your profile."}
            </p>

            <button
              type="submit" disabled={!v.ok || saving || unchanged}
              className="mt-4 px-5 py-2.5 rounded-md text-sm inline-flex items-center gap-2 disabled:opacity-50"
              style={{ background: "#14213D", color: "#F7F7F4" }}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} {saved?.vpa_address ? "Update UPI ID" : "Save UPI ID"}
            </button>

            {message && (
              <p className="text-sm mt-4" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "#B33A2E" : "#2F6F62" }}>{message.text}</p>
            )}
          </form>
        )}

        <div className="rounded-md p-4 mt-8 flex gap-3" style={{ background: "#FBF1DD", border: "1px solid #E9D9AA" }}>
          <Info size={16} color="#8A6A18" className="shrink-0 mt-0.5" />
          <div className="text-sm" style={{ color: "#3A3D42" }}>
            <p className="mb-1" style={{ fontWeight: 600, color: "#14213D" }}>All sales are final.</p>
            <p>Payouts are sent the moment a sale is complete and can&apos;t be recalled. Please double-check your UPI ID: money sent to a wrong ID can&apos;t be brought back. We never take a payout back from you.</p>
          </div>
        </div>
        <p className="text-sm mt-6"><Link href="/sell/earnings" className="underline" style={{ color: "#14213D" }}>See your earnings and payout status →</Link></p>
      </main>
    </div>
  );
}
