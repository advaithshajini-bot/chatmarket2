"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { getSellerDirectClaims, describeSellerClaim, explainDirectError } from "@/lib/domain/direct-upi";
import { formatPaise } from "@/lib/domain/paise";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONES = { green: ["#EAF2EF", "#2F6F62"], amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], grey: ["#E8E7E2", "#6B6F76"] };
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "");

// The seller's desk for direct payments: a buyer paid their UPI ID and submitted the UTR; the seller checks their bank/UPI app,
// then confirms (which unlocks the playbook) or rejects. Renders nothing when there are no claims at all.
export default function SellerClaimsPanel() {
  const supabase = createClient();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  async function load() { setData(await getSellerDirectClaims(supabase)); }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function act(kind, c) {
    if (busy) return;
    if (kind === "confirm" && !window.confirm(`Confirm that ${formatPaise(c.amount_paise)} with UTR ${c.utr} has reached your account? This unlocks the playbook for ${c.buyer_name}.`)) return;
    let reason = null;
    if (kind === "reject") {
      reason = window.prompt("Optional: tell the buyer why (for example, 'Amount didn't arrive'). Leave empty to skip.", "");
      if (reason === null) return;
    }
    setBusy(c.id); setError("");
    const { error: err } = kind === "confirm"
      ? await supabase.rpc("confirm_direct_payment_claim", { p_claim_id: c.id })
      : await supabase.rpc("reject_direct_payment_claim", { p_claim_id: c.id, p_reason: reason });
    setBusy(null);
    if (err) setError(explainDirectError(err));
    await load();
  }

  if (!data || data.claims.length === 0) return null;
  const pending = data.claims.filter((c) => c.status === "pending");
  const done = data.claims.filter((c) => c.status !== "pending").slice(0, 10);

  return (
    <section className="mb-8" aria-label="Payments to confirm">
      <h2 className="text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        Payments to confirm {pending.length > 0 && <span className="text-sm" style={{ ...MONO, color: "#8A6A18" }}>({pending.length})</span>}
      </h2>
      <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>
        Buyers pay your UPI ID directly. Match each amount and UTR in your UPI or bank app, then confirm. Only confirm money you have actually received.
      </p>
      {error && <p className="text-sm mb-3" role="alert" style={{ color: "#B33A2E" }}>{error}</p>}
      {pending.length === 0 ? (
        <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>Nothing waiting for you.</p>
      ) : (
        <div className="rounded-md overflow-hidden mb-4" style={{ border: "1px solid #D8D5C9" }}>
          {pending.map((c, n) => {
            const d = describeSellerClaim(c); const [bg, fg] = TONES[d.tone];
            return (
              <div key={c.id} className="px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: n === 0 ? "none" : "1px solid #EAE8DE" }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm truncate" style={{ color: "#14213D", fontWeight: 500 }}>{c.listing_title}</p>
                    <p className="text-xs" style={{ color: "#6B6F76" }}>{c.buyer_name} · {when(c.created_at)} · UTR <span style={MONO}>{c.utr}</span></p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{formatPaise(c.amount_paise)}</p>
                    <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: bg, color: fg, ...MONO }}>{d.label}</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <button onClick={() => act("confirm", c)} disabled={busy === c.id} className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5 disabled:opacity-50" style={{ background: "#2F6F62", color: "#FFFFFF" }}>
                    {busy === c.id ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />} Confirm payment
                  </button>
                  <button onClick={() => act("reject", c)} disabled={busy === c.id} className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5 disabled:opacity-50" style={{ border: "1px solid #D8D5C9", color: "#B33A2E" }}>
                    <XCircle size={12} /> Not received
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {done.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs" style={{ color: "#6B6F76" }}>Recent decisions ({done.length})</summary>
          <div className="mt-2 rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
            {done.map((c, n) => (
              <div key={c.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs" style={{ background: "#FFFFFF", borderTop: n === 0 ? "none" : "1px solid #EAE8DE", color: "#3A3D42" }}>
                <span className="truncate">{c.listing_title} · {c.buyer_name} · <span style={MONO}>{c.utr}</span></span>
                <span className="shrink-0">{formatPaise(c.amount_paise)} · {describeSellerClaim(c).label}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
