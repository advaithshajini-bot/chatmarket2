"use client";

import { useEffect, useState } from "react";
import { getAdminDirectClaims, explainDirectError } from "@/lib/domain/direct-upi";
import { formatPaise } from "@/lib/domain/paise";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
const FILTERS = [["disputed", "Reported by sellers"], ["revoked", "Access removed"], ["confirmed", "All unlocked"]];

// Admin (with MFA) decides reported direct payments: "payment verified" keeps the buyer's access, "not verified" removes it.
// The admin checks the seller's UPI ID / UTR against whatever evidence the seller and buyer give; the platform never holds the money.
export default function AdminDirectPaymentsTab({ supabase }) {
  const [filter, setFilter] = useState("disputed");
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");

  async function load(f = filter) { setData(null); setData(await getAdminDirectClaims(supabase, f)); }
  useEffect(() => { load(filter); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  async function decide(c, decision) {
    if (busy) return;
    const note = window.prompt(decision === "revoked"
      ? `Remove ${c.buyer_name}'s access to "${c.listing_title}"? Optional note for the record:`
      : `Mark the payment as verified (the buyer keeps access)? Optional note for the record:`, "");
    if (note === null) return;
    setBusy(c.id); setError("");
    const { error: err } = await supabase.rpc("admin_resolve_direct_dispute", { p_claim_id: c.id, p_decision: decision, p_note: note });
    setBusy(null);
    if (err) setError(explainDirectError(err));
    await load();
  }

  return (
    <div>
      <p className="text-sm mb-4" style={{ color: "#3A3D42" }}>
        Buyers pay the seller directly and are unlocked instantly. Sellers report payments they never received. Compare the UTR with the seller&apos;s evidence, then decide.
      </p>
      <div className="flex gap-2 mb-4">
        {FILTERS.map(([k, label]) => (
          <button key={k} onClick={() => setFilter(k)} className="px-3 py-1.5 rounded-full text-xs" style={{ background: filter === k ? "#14213D" : "#FFFFFF", color: filter === k ? "#FFFFFF" : "#14213D", border: "1px solid #D8D5C9" }}>
            {label}{k === "disputed" && data?.disputed_count > 0 ? ` (${data.disputed_count})` : ""}
          </button>
        ))}
      </div>
      {error && <p className="text-sm mb-3" role="alert" style={{ color: "#B33A2E" }}>{error}</p>}
      {!data ? <p className="text-sm" style={{ color: "#6B6F76" }}>Loading…</p>
        : data.error ? <p className="text-sm" role="alert" style={{ color: "#B33A2E" }}>Couldn&apos;t load. Admin sign-in with the second factor is required.</p>
        : data.claims.length === 0 ? <p className="text-sm py-8 text-center" style={{ color: "#6B6F76" }}>Nothing here.</p>
        : (
          <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
            {data.claims.map((c, n) => (
              <div key={c.id} className="px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: n === 0 ? "none" : "1px solid #EAE8DE" }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 text-sm" style={{ color: "#14213D" }}>
                    <p style={{ fontWeight: 600 }}>{c.listing_title} · {formatPaise(c.amount_paise)}</p>
                    <p className="text-xs" style={{ color: "#3A3D42" }}>Seller {c.seller_name} (<span style={MONO}>{c.seller_vpa}</span>) · Buyer {c.buyer_name} · {when(c.created_at)}</p>
                    <p className="text-xs" style={{ color: "#3A3D42" }}>UTR <span style={MONO}>{c.utr}</span></p>
                    {c.dispute_reason && <p className="text-xs mt-1" style={{ color: "#8A6A18" }}>Seller report ({when(c.disputed_at)}): {c.dispute_reason}</p>}
                    {c.resolution && <p className="text-xs mt-1" style={{ color: "#3A3D42" }}>Decided {when(c.resolved_at)}: {c.resolution === "upheld" ? "payment verified" : "payment not verified, access removed"}{c.resolution_note ? ` — ${c.resolution_note}` : ""}</p>}
                  </div>
                  <span className="text-[11px] px-2 py-0.5 rounded-full uppercase" style={{ background: "#E8E7E2", color: "#6B6F76", ...MONO }}>{c.status}</span>
                </div>
                {c.status === "disputed" && (
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => decide(c, "upheld")} disabled={busy === c.id} className="px-3 py-1.5 rounded text-xs disabled:opacity-50" style={{ background: "#2F6F62", color: "#FFFFFF" }}>Payment verified — keep access</button>
                    <button onClick={() => decide(c, "revoked")} disabled={busy === c.id} className="px-3 py-1.5 rounded text-xs disabled:opacity-50" style={{ border: "1px solid #B33A2E", color: "#B33A2E" }}>Not verified — remove access</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
