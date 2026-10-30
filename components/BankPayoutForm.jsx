"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { validateBankPayoutForm, maskBankAccount, describeBankPayout, IFSC_RE } from "@/lib/domain/bank-payout";
import { describeBankCooldown } from "@/lib/domain/seller-settlement";

// The ONLY payout screen: permanent bank account details for manual monthly payouts. No UPI ID, no payment-partner onboarding.
// Posts to /api/sell/payout-bank (which calls the database function set_my_bank_payout). The full account number is never read back:
// after saving we only show ****1234, the IFSC and the green "Bank Account Configured for Payouts" badge.
const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const EMPTY = { beneficiaryName: "", accountNumber: "", confirmAccountNumber: "", ifsc: "", accountType: "savings" };

function Field({ id, label, value, onChange, error, placeholder, inputMode, mono, type = "text", hint, right }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="text-sm mb-1.5 block" style={{ color: "#14213D" }}>{label}</label>
      <div className="relative">
        <input id={id} name={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode}
          autoComplete="off" spellCheck={false} aria-invalid={error ? "true" : "false"} className="w-full px-3 py-2.5 rounded-md text-sm outline-none"
          style={{ background: "#FFFFFF", border: `1px solid ${error ? "#B33A2E" : "#D8D5C9"}`, color: "#14213D", paddingRight: right ? 40 : undefined, ...(mono ? MONO : {}) }} />
        {right}
      </div>
      {error ? <p className="text-xs mt-1" style={{ color: "#B33A2E" }} role="alert">{error}</p> : hint ? <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p> : null}
    </div>
  );
}

export default function BankPayoutForm({ saved, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [bank, setBank] = useState(null);
  const [editing, setEditing] = useState(!saved?.configured);
  const [message, setMessage] = useState(null);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMessage(null); };
  const badge = describeBankPayout(saved);
  const cooldownNote = describeBankCooldown(saved?.bank_unlocks_at);

  useEffect(() => { setEditing(!saved?.configured); }, [saved?.configured]);

  useEffect(() => {
    setBank(null);
    const code = form.ifsc.trim().toUpperCase();
    if (!IFSC_RE.test(code)) return;
    let live = true;
    fetch(`/api/ifsc/${code}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d?.found) setBank(d); }).catch(() => {});
    return () => { live = false; };
  }, [form.ifsc]);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const v = validateBankPayoutForm(form);
    setErrors(v.errors);
    if (!v.ok) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/sell/payout-bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.fields) setErrors(data.fields);
        setMessage({ tone: "err", text: data?.error || "We couldn't save that just now. Please try again." });
      } else {
        setForm(EMPTY); setErrors({}); setEditing(false);
        setMessage({ tone: "ok", text: "Bank details saved. Your earnings will be paid to this account in the monthly payout." });
        onSaved?.();
      }
    } catch {
      setMessage({ tone: "err", text: "We couldn't reach the server. Please try again." });
    }
    setBusy(false);
  }

  return (
    <div>
      {saved?.configured && (
        <div className="rounded-md p-4 mb-6" style={{ background: "#EEF6F3", border: "1px solid #BFDDD3" }}>
          <p className="text-sm flex items-center gap-2 mb-2" style={{ color: "#2F6F62", fontWeight: 600 }} role="status"><CheckCircle2 size={16} /> {badge.label}</p>
          <p className="text-sm" style={{ color: "#3A3D42" }}>
            <span style={MONO}>{maskBankAccount(saved.last4)}</span> · IFSC <span style={MONO}>{saved.ifsc}</span>
            {saved.beneficiary_name ? <> · {saved.beneficiary_name}</> : null}{saved.account_type ? <> · {saved.account_type === "current" ? "Current" : "Savings"}</> : null}
          </p>
          {cooldownNote && <p className="text-xs mt-2" style={{ color: "#8A6A18" }}>{cooldownNote}</p>}
          {!editing && <button type="button" onClick={() => setEditing(true)} className="mt-3 text-sm underline" style={{ color: "#14213D" }}>Change bank details</button>}
        </div>
      )}

      {editing && (
        <form onSubmit={submit} noValidate>
          <h2 className="text-sm uppercase tracking-wide mb-4" style={{ ...MONO, color: "#6B6F76" }}>Bank settlement details</h2>
          <Field id="beneficiaryName" label="Beneficiary name" value={form.beneficiaryName} onChange={set("beneficiaryName")} error={errors.beneficiaryName} hint="The account holder's name exactly as the bank has it." />
          <Field id="accountNumber" label="Bank account number" value={form.accountNumber} onChange={set("accountNumber")} error={errors.accountNumber} inputMode="numeric" mono type={show ? "text" : "password"}
            right={<button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide account number" : "Show account number"} className="absolute right-3 top-1/2 -translate-y-1/2">{show ? <EyeOff size={16} color="#6B6F76" /> : <Eye size={16} color="#6B6F76" />}</button>} />
          <Field id="confirmAccountNumber" label="Confirm account number" value={form.confirmAccountNumber} onChange={set("confirmAccountNumber")} error={errors.confirmAccountNumber} inputMode="numeric" mono type={show ? "text" : "password"} />
          <Field id="ifsc" label="IFSC code" value={form.ifsc} onChange={(v) => set("ifsc")(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11))} error={errors.ifsc} placeholder="HDFC0001234" mono
            hint={bank ? `${bank.bank ?? ""}${bank.branch ? `, ${bank.branch}` : ""}${bank.city ? `, ${bank.city}` : ""}` : "11 characters. We show the bank and branch once it's recognised."} />
          <p className="text-sm mb-1.5" style={{ color: "#14213D" }}>Account type</p>
          <div className="flex gap-2 mb-4" role="radiogroup" aria-label="Account type">
            {[{ value: "savings", label: "Savings" }, { value: "current", label: "Current" }].map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={form.accountType === o.value} onClick={() => set("accountType")(o.value)} className="px-4 py-2 rounded-md text-sm"
                style={{ border: `1px solid ${form.accountType === o.value ? "#14213D" : "#D8D5C9"}`, background: form.accountType === o.value ? "#14213D" : "#FFFFFF", color: form.accountType === o.value ? "#F7F7F4" : "#14213D" }}>{o.label}</button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-md text-sm inline-flex items-center gap-2 disabled:opacity-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
              {busy && <Loader2 size={14} className="animate-spin" />} {saved?.configured ? "Update bank details" : "Save bank details"}
            </button>
            {saved?.configured && <button type="button" onClick={() => { setEditing(false); setErrors({}); setForm(EMPTY); }} className="text-sm underline" style={{ color: "#14213D" }}>Cancel</button>}
          </div>
        </form>
      )}
      {message && <p className="text-sm mt-4" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "#B33A2E" : "#2F6F62" }}>{message.text}</p>}
    </div>
  );
}
