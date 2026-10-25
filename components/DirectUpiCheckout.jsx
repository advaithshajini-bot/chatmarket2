"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Smartphone, Clock, CheckCircle2, AlertCircle, Copy } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { buildUpiUri, appLink, UPI_APPS, validateUtr, describeClaim, describeTargetReason, explainDirectError, getDirectTarget } from "@/lib/domain/direct-upi";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONE = { amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], grey: ["#E8E7E2", "#6B6F76"], green: ["#EAF2EF", "#2F6F62"] };

// Direct-to-seller checkout: the buyer pays the seller's UPI ID (QR or app button), then submits the 12-digit UTR.
// The platform never receives the money; the SELLER confirms and that unlocks the purchase.
export default function DirectUpiCheckout({ listing, onUnlocked }) {
  const supabase = createClient();
  const [target, setTarget] = useState(null);
  const [qr, setQr] = useState("");
  const [utr, setUtr] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function load() {
    const t = await getDirectTarget(supabase, listing.id);
    setTarget(t);
    if (t?.claim?.status === "confirmed") onUnlocked?.();
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [listing.id]);

  const uri = target?.available ? buildUpiUri({ vpa: target.vpa, payeeName: target.payee_name, amountPaise: target.amount_paise, listingId: listing.id }) : "";
  useEffect(() => {
    let live = true;
    if (!uri) { setQr(""); return undefined; }
    QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: "M" }).then((u) => { if (live) setQr(u); }).catch(() => { if (live) setQr(""); });
    return () => { live = false; };
  }, [uri]);

  const v = validateUtr(utr);
  const claim = target?.claim;
  const waiting = claim?.status === "pending" && !claim.overdue;

  async function submit(e) {
    e.preventDefault();
    setTouched(true);
    if (!v.ok || busy) return;
    setBusy(true); setError("");
    const { error: err } = await supabase.rpc("submit_direct_payment_claim", { p_listing_id: listing.id, p_utr: v.value });
    setBusy(false);
    if (err) { setError(explainDirectError(err)); return; }
    setUtr(""); setTouched(false);
    await load();
  }

  async function copyUpi() {
    try { await navigator.clipboard.writeText(target.vpa); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  }

  if (!target) return <div className="h-10 rounded animate-pulse" style={{ background: "#EDEEEA" }} />;
  if (target.error || target.enabled === false) return <p className="text-xs" style={{ color: "#B33A2E" }} role="alert">We couldn&apos;t load payment details. Please refresh.</p>;

  const state = claim && claim.status !== "confirmed" ? describeClaim(claim) : null;
  const [bg, fg] = TONE[state?.tone] || TONE.grey;

  return (
    <div>
      {state && (
        <div className="rounded-md px-3 py-2.5 mb-3 text-sm" role="status" style={{ background: bg, color: fg }}>
          <p className="flex items-center gap-2" style={{ fontWeight: 600 }}>{waiting ? <Clock size={14} /> : <AlertCircle size={14} />} {state.label}</p>
          <p className="text-xs mt-1">{state.detail}</p>
        </div>
      )}

      {!target.available ? (
        <p className="text-sm" style={{ color: "#3A3D42" }}>{describeTargetReason(target)}</p>
      ) : waiting ? null : (
        <>
          <p className="text-xs uppercase tracking-wide mb-2" style={{ ...MONO, color: "#6B6F76" }}>1. Pay the seller directly</p>
          <div className="rounded-md p-3 mb-3 text-center" style={{ border: "1px solid #D8D5C9", background: "#FFFFFF" }}>
            {qr ? <img src={qr} alt={`UPI QR code to pay ${target.payee_name}`} width={200} height={200} className="mx-auto" /> : <div className="h-[200px]" />}
            <p className="text-sm mt-2" style={{ color: "#14213D", fontWeight: 600 }}>₹{(target.amount_paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} to {target.payee_name}</p>
            <button type="button" onClick={copyUpi} className="text-xs mt-1 inline-flex items-center gap-1 underline" style={{ ...MONO, color: "#6B6F76" }}>
              {target.vpa} <Copy size={11} /> {copied ? "copied" : ""}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-1 sm:hidden">
            {UPI_APPS.map((a) => (
              <a key={a.id} href={appLink(a.id, uri)} className="flex items-center justify-center gap-1.5 py-2 rounded text-xs" style={{ border: "1px solid #D8D5C9", color: "#14213D" }}>
                <Smartphone size={13} /> {a.label}
              </a>
            ))}
          </div>
          <a href={uri} className="sm:hidden block text-center text-xs underline mb-3" style={{ color: "#6B6F76" }}>Other UPI app</a>

          <form onSubmit={submit} noValidate className="mt-3">
            <label htmlFor="utr" className="text-xs uppercase tracking-wide mb-1.5 block" style={{ ...MONO, color: "#6B6F76" }}>2. Enter the 12-digit UTR after paying</label>
            <input
              id="utr" inputMode="numeric" autoComplete="off" maxLength={14} value={utr} placeholder="e.g. 412345678901"
              onChange={(e) => { setUtr(e.target.value); setError(""); }} onBlur={() => setTouched(true)}
              aria-invalid={touched && v.error ? "true" : "false"}
              className="w-full px-3 py-2.5 rounded text-sm outline-none"
              style={{ border: `1px solid ${touched && v.error ? "#B33A2E" : v.ok ? "#2F6F62" : "#D8D5C9"}`, background: "#FFFFFF", ...MONO }}
            />
            <p className="text-[11px] mt-1 min-h-[1rem]" style={{ color: touched && v.error ? "#B33A2E" : "#6B6F76" }} role={touched && v.error ? "alert" : undefined}>
              {touched && v.error ? v.error : "Find it in your UPI app under the payment details (also called UPI Ref No. / Transaction ID)."}
            </p>
            {error && <p className="text-xs mt-1" style={{ color: "#B33A2E" }} role="alert">{error}</p>}
            <button type="submit" disabled={!v.ok || busy} className="w-full mt-2 py-3 rounded text-sm disabled:opacity-50" style={{ background: "#E2A83E", color: "#14213D", fontWeight: 600 }}>
              {busy ? "Submitting…" : "I've paid — submit for verification"}
            </button>
          </form>
        </>
      )}
      <p className="text-[11px] mt-3 text-center" style={{ color: "#6B6F76" }}>
        You pay the seller directly. chatmarket doesn&apos;t receive or hold your payment, so refunds are agreed between you and the seller. Your playbook unlocks when the seller confirms they received it.
      </p>
      {claim?.status === "confirmed" && <p className="text-xs mt-2 flex items-center justify-center gap-1" style={{ color: "#2F6F62" }}><CheckCircle2 size={12} /> Confirmed</p>}
    </div>
  );
}
