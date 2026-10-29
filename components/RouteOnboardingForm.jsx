"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { validateRouteStep, validateRouteForm, describeRouteStatus, explainRouteError, maskAccount, IFSC_RE } from "@/lib/domain/route";

// Seller payment-account onboarding, in 2 steps:
//   Step 1  Basic & identity details  (legal name as per PAN, PAN, phone, email, address, individual / proprietor)
//   Step 2  Bank settlement details   (beneficiary, account number + confirm, IFSC with bank lookup, account type)
// The form talks to OUR server (/api/razorpay/route-onboard). PAN and the full account number go to the payment partner and are never stored by
// chatmarket: we keep only the account id, its status, and the last 4 digits / IFSC / account type for display. There is no separate UPI step.
const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONES = { green: "#2F6F62", amber: "#8A6A18", red: "#B33A2E", gray: "#6B6F76" };
const EMPTY = { legalName: "", email: "", phone: "", pan: "", businessType: "individual", street: "", city: "", state: "", postalCode: "",
  beneficiaryName: "", accountNumber: "", confirmAccountNumber: "", ifsc: "", accountType: "savings" };

function Field({ id, label, value, onChange, error, placeholder, inputMode, mono, type = "text", autoComplete = "off", hint, right }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="text-sm mb-1.5 block" style={{ color: "#14213D" }}>{label}</label>
      <div className="relative">
        <input
          id={id} name={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode}
          autoComplete={autoComplete} spellCheck={false} aria-invalid={error ? "true" : "false"}
          className="w-full px-3 py-2.5 rounded-md text-sm outline-none"
          style={{ background: "#FFFFFF", border: `1px solid ${error ? "#B33A2E" : "#D8D5C9"}`, color: "#14213D", paddingRight: right ? 40 : undefined, ...(mono ? MONO : {}) }}
        />
        {right}
      </div>
      {error ? <p className="text-xs mt-1" style={{ color: "#B33A2E" }} role="alert">{error}</p> : hint ? <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p> : null}
    </div>
  );
}

function Segmented({ name, value, options, onChange }) {
  return (
    <div className="flex gap-2 mb-4" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className="px-4 py-2 rounded-md text-sm"
          style={{ border: `1px solid ${value === o.value ? "#14213D" : "#D8D5C9"}`, background: value === o.value ? "#14213D" : "#FFFFFF", color: value === o.value ? "#F7F7F4" : "#14213D" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function RouteOnboardingForm({ status, onChanged }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [show, setShow] = useState(false);
  const [bank, setBank] = useState(null);           // { bank, branch, city } from the IFSC lookup
  const [beneficiaryTouched, setBeneficiaryTouched] = useState(false);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMessage(null); if (k === "beneficiaryName") setBeneficiaryTouched(true); };
  const info = describeRouteStatus(status?.route_status);
  const active = status?.ready === true;

  // IFSC lookup: bank name and branch, shown under the field. Fails soft (no name shown).
  useEffect(() => {
    setBank(null);
    const code = form.ifsc.trim().toUpperCase();
    if (!IFSC_RE.test(code)) return;
    let live = true;
    fetch(`/api/ifsc/${code}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d?.found) setBank(d); }).catch(() => {});
    return () => { live = false; };
  }, [form.ifsc]);

  async function call(payload) {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/razorpay/route-onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.fields) { setErrors(data.fields); if (Object.keys(data.fields).some((k) => ["legalName", "email", "phone", "pan", "street", "city", "state", "postalCode"].includes(k))) setStep(1); }
        setMessage({ tone: "err", text: explainRouteError(data) });
      } else {
        setForm(EMPTY); setErrors({}); setStep(1); setBeneficiaryTouched(false);
        setMessage({ tone: "ok", text: data.ready ? "You're all set. You can list your playbooks now." : "Details sent for verification. This page updates when your account is active." });
        onChanged?.();
      }
    } catch {
      setMessage({ tone: "err", text: "We couldn't reach the server. Please try again." });
    }
    setBusy(false);
  }

  function next(e) {
    e.preventDefault();
    const v = validateRouteStep(form, 1);
    setErrors(v.errors);
    if (!v.ok) return;
    // Step 2's beneficiary name starts as the legal name from step 1 (editable if the bank records differ)
    if (!beneficiaryTouched && !form.beneficiaryName) setForm((f) => ({ ...f, beneficiaryName: v.value.legalName }));
    setStep(2);
  }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    const v = validateRouteForm(form);
    setErrors(v.errors);
    if (!v.ok) { if (Object.keys(validateRouteStep(form, 1).errors).length) setStep(1); return; }
    call({ action: "submit", ...form, bankName: bank?.bank ?? null });
  }

  const savedBank = status?.bank_account_last4 ? `${maskAccount(status.bank_account_last4)} · ${status.bank_ifsc ?? ""}${status.bank_name ? ` · ${status.bank_name}` : ""}${status.bank_account_type ? ` · ${status.bank_account_type}` : ""}` : null;

  return (
    <div>
      <p className="text-sm mb-2 flex items-center gap-2" style={{ color: TONES[info.tone] }} role="status">
        {active ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />} <span style={{ fontWeight: 600 }}>{info.label}</span> <span style={{ color: "#3A3D42" }}>{info.detail}</span>
      </p>
      {savedBank && <p className="text-sm mb-4" style={{ color: "#3A3D42" }}>Settlement account: <span style={MONO}>{savedBank}</span></p>}
      {status?.has_account && !active && (
        <button type="button" onClick={() => call({ action: "refresh" })} disabled={busy} className="mb-6 text-sm inline-flex items-center gap-2 underline disabled:opacity-50" style={{ color: "#14213D" }}>
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Check status
        </button>
      )}

      {!active && (
        <>
          <p className="text-xs uppercase tracking-wide mb-4" style={{ ...MONO, color: "#6B6F76" }}>Step {step} of 2 · {step === 1 ? "Basic & identity details" : "Bank settlement details"}</p>

          {step === 1 ? (
            <form onSubmit={next} noValidate>
              <Field id="legalName" label="Legal name (as per PAN)" value={form.legalName} onChange={set("legalName")} error={errors.legalName} autoComplete="name" />
              <p className="text-sm mb-1.5" style={{ color: "#14213D" }}>You sell as</p>
              <Segmented name="You sell as" value={form.businessType} onChange={set("businessType")} options={[{ value: "individual", label: "Individual" }, { value: "proprietorship", label: "Proprietor" }]} />
              <Field id="pan" label="PAN" value={form.pan} onChange={set("pan")} error={errors.pan} placeholder="ABCDE1234F" mono />
              <Field id="email" label="Contact email" value={form.email} onChange={set("email")} error={errors.email} inputMode="email" autoComplete="email" />
              <Field id="phone" label="Mobile number" value={form.phone} onChange={set("phone")} error={errors.phone} inputMode="tel" placeholder="10-digit mobile" autoComplete="tel" />
              <Field id="street" label="Street address" value={form.street} onChange={set("street")} error={errors.street} autoComplete="street-address" />
              <div className="grid grid-cols-2 gap-3">
                <Field id="city" label="City" value={form.city} onChange={set("city")} error={errors.city} />
                <Field id="state" label="State" value={form.state} onChange={set("state")} error={errors.state} />
              </div>
              <Field id="postalCode" label="PIN code" value={form.postalCode} onChange={set("postalCode")} error={errors.postalCode} inputMode="numeric" mono />
              <button type="submit" className="mt-2 px-5 py-2.5 rounded-md text-sm" style={{ background: "#14213D", color: "#F7F7F4" }}>Continue to bank details</button>
            </form>
          ) : (
            <form onSubmit={submit} noValidate>
              <Field id="beneficiaryName" label="Beneficiary name" value={form.beneficiaryName} onChange={set("beneficiaryName")} error={errors.beneficiaryName} hint="Pre-filled from your legal name. Change it only if your bank records show a different name." />
              <Field id="accountNumber" label="Account number" value={form.accountNumber} onChange={set("accountNumber")} error={errors.accountNumber} inputMode="numeric" mono type={show ? "text" : "password"}
                right={<button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide account number" : "Show account number"} className="absolute right-3 top-1/2 -translate-y-1/2">{show ? <EyeOff size={16} color="#6B6F76" /> : <Eye size={16} color="#6B6F76" />}</button>} />
              <Field id="confirmAccountNumber" label="Confirm account number" value={form.confirmAccountNumber} onChange={set("confirmAccountNumber")} error={errors.confirmAccountNumber} inputMode="numeric" mono type={show ? "text" : "password"} />
              <Field id="ifsc" label="IFSC code" value={form.ifsc} onChange={(v) => set("ifsc")(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 11))} error={errors.ifsc} placeholder="HDFC0001234" mono
                hint={bank ? `${bank.bank ?? ""}${bank.branch ? `, ${bank.branch}` : ""}${bank.city ? `, ${bank.city}` : ""}` : "11 characters. We show the bank and branch once it's recognised."} />
              <p className="text-sm mb-1.5" style={{ color: "#14213D" }}>Account type</p>
              <Segmented name="Account type" value={form.accountType} onChange={set("accountType")} options={[{ value: "savings", label: "Savings" }, { value: "current", label: "Current" }]} />
              <p className="text-xs mb-4" style={{ color: "#3A3D42", lineHeight: 1.6 }}>
                Razorpay will verify your bank details via an automated ₹1 penny-drop. Payouts from thread sales settle automatically to this account. Your PAN and account number are sent to Razorpay to verify you; chatmarket keeps only the last 4 digits for display.
              </p>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => { setStep(1); setErrors({}); }} disabled={busy} className="px-4 py-2.5 rounded-md text-sm" style={{ border: "1px solid #D8D5C9", color: "#14213D" }}>Back</button>
                <button type="submit" disabled={busy} className="px-5 py-2.5 rounded-md text-sm inline-flex items-center gap-2 disabled:opacity-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
                  {busy && <Loader2 size={14} className="animate-spin" />} {status?.has_account ? "Submit again" : "Create payment account"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {message && <p className="text-sm mt-4" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "#B33A2E" : "#2F6F62" }}>{message.text}</p>}
    </div>
  );
}
