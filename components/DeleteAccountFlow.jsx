"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DELETE_REASONS } from "@/lib/domain/username";

const NAVY = "#14213D";
const RED = "#B33A2E";

// Four screens in one modal: 1 reason (Keep account / Next) -> 2 warning with a "type DELETE" box (the red DELETE button appears only when it matches
// exactly, in capitals) -> 3 "Account deleted" (OK goes to the login page).
export default function DeleteAccountFlow({ onClose }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const doDelete = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed, reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || "We couldn't delete your account."); setBusy(false); return; }
      setStep(3);
    } catch { setError("Network problem. Please try again."); }
    setBusy(false);
  };

  const finish = async () => {
    try { await createClient().auth.signOut(); } catch { /* already signed out by the server */ }
    router.push("/login");
    router.refresh();
  };

  const btn = { fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 };
  return (
    <div role="dialog" aria-modal="true" aria-label="Delete account" className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(10,16,30,0.6)" }}
         onClick={(e) => { if (e.target === e.currentTarget && step !== 3 && !busy) onClose(); }}>
      <div className="w-full max-w-md rounded-lg p-6" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: NAVY }}>
        {step === 1 && (
          <>
            <h2 className="text-xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>Delete account</h2>
            <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>We're sorry to see you go. Why are you deleting your account?</p>
            <div className="space-y-2 mb-5" role="radiogroup" aria-label="Reason for deleting">
              {DELETE_REASONS.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="delete-reason" value={r} checked={reason === r} onChange={() => setReason(r)} /> {r}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded text-sm" style={{ ...btn, background: NAVY, color: "#F7F7F4" }}>Keep account</button>
              <button type="button" onClick={() => setStep(2)} disabled={!reason} className="px-4 py-2 rounded text-sm" style={{ ...btn, border: `1px solid ${NAVY}`, color: NAVY, opacity: reason ? 1 : 0.45 }}>Next</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2 className="text-xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: RED }}>Delete account warning</h2>
            <ul className="text-sm mb-4 space-y-1.5 list-disc pl-5" style={{ color: "#3A3D42" }}>
              <li>Your profile, username and saved payout details will be removed.</li>
              <li>Your listings will be taken down.</li>
              <li>You will lose access to your library and purchases.</li>
              <li>This can't be undone. All sales are final; payment records are kept as the law requires.</li>
            </ul>
            <label htmlFor="delete-confirm" className="block text-sm mb-1">Type <strong>DELETE</strong> in capital letters to confirm.</label>
            <input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
                   className="w-full px-3 py-2 rounded text-sm mb-3" style={{ border: "1px solid #D8D5C9" }} />
            {error && <p role="alert" className="text-xs mb-3" style={{ color: RED }}>{error}</p>}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 rounded text-sm" style={{ ...btn, background: NAVY, color: "#F7F7F4" }}>Keep account</button>
              {typed === "DELETE" && (
                <button type="button" onClick={doDelete} disabled={busy} className="px-4 py-2 rounded text-sm" style={{ ...btn, background: RED, color: "#FFFFFF" }}>{busy ? "Deleting…" : "DELETE"}</button>
              )}
            </div>
          </>
        )}
        {step === 3 && (
          <div className="text-center">
            <h2 className="text-xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>Account deleted</h2>
            <p className="text-sm mb-5" style={{ color: "#6B6F76" }}>Your account has been deleted. Thank you for being part of chatmarket.</p>
            <button type="button" onClick={finish} className="px-6 py-2 rounded text-sm" style={{ ...btn, background: NAVY, color: "#F7F7F4" }}>OK</button>
          </div>
        )}
      </div>
    </div>
  );
}
