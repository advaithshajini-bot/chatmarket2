"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { validateRouteForm, describeRouteStatus, explainRouteError } from "@/lib/domain/route";

// Razorpay Route linked-account onboarding (test mode first). The form talks to OUR server (/api/razorpay/route-onboard); the server talks to
// Razorpay. PAN and bank details are sent to Razorpay and are never stored by chatmarket: we keep only the account id and its status.
const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONES = { green: "#2F6F62", amber: "#8A6A18", red: "#B33A2E", gray: "#6B6F76" };
const EMPTY = { legalName: "", email: "", phone: "", pan: "", beneficiaryName: "", accountNumber: "", ifsc: "", street: "", city: "", state: "", postalCode: "" };

function Field({ id, label, value, onChange, error, placeholder, inputMode, mono, autoComplete = "off", hint }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="text-sm mb-1.5 block" style={{ color: "#14213D" }}>{label}</label>
      <input
        id={id} name={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode}
        autoComplete={autoComplete} spellCheck={false} aria-invalid={error ? "true" : "false"}
        className="w-full px-3 py-2.5 rounded-md text-sm outline-none"
        style={{ background: "#FFFFFF", border: `1px solid ${error ? "#B33A2E" : "#D8D5C9"}`, color: "#14213D", ...(mono ? MONO : {}) }}
      />
      {error ? <p className="text-xs mt-1" style={{ color: "#B33A2E" }} role="alert">{error}</p> : hint ? <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p> : null}
    </div>
  );
}

export default function RouteOnboardingForm({ status, onChanged }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setMessage(null); };
  const info = describeRouteStatus(status?.route_status);
  const active = status?.ready === true;

  async function call(payload) {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/razorpay/route-onboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data?.fields) setErrors(data.fields);
        setMessage({ tone: "err", text: explainRouteError(data) });
      } else {
        setForm(EMPTY); setErrors({});
        setMessage({ tone: "ok", text: data.ready ? "You're all set. You can list your playbooks now." : "Details sent. Razorpay is checking them; this page updates when your account is active." });
        onChanged?.();
      }
    } catch {
      setMessage({ tone: "err", text: "We couldn't reach the server. Please try again." });
    }
    setBusy(false);
  }

  function submit(e) {
    e.preventDefault();
    if (busy) return;
    const v = validateRouteForm(form);
    setErrors(v.errors);
    if (!v.ok) return;
    call({ action: "submit", ...form });
  }

  return (
    <div>
      <p className="text-sm mb-4 flex items-center gap-2" style={{ color: TONES[info.tone] }} role="status">
        {active ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />} <span style={{ fontWeight: 600 }}>{info.label}</span> <span style={{ color: "#3A3D42" }}>{info.detail}</span>
      </p>
      {status?.has_account && !active && (
        <button type="button" onClick={() => call({ action: "refresh" })} disabled={busy} className="mb-6 text-sm inline-flex items-center gap-2 underline disabled:opacity-50" style={{ color: "#14213D" }}>
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Check status
        </button>
      )}

      {!active && (
        <form onSubmit={submit} noValidate>
          <Field id="legalName" label="Legal name (as per PAN)" value={form.legalName} onChange={set("legalName")} error={errors.legalName} autoComplete="name" />
          <Field id="email" label="Contact email" value={form.email} onChange={set("email")} error={errors.email} inputMode="email" autoComplete="email" />
          <Field id="phone" label="Mobile number" value={form.phone} onChange={set("phone")} error={errors.phone} inputMode="tel" placeholder="10-digit mobile" autoComplete="tel" />
          <Field id="pan" label="PAN" value={form.pan} onChange={set("pan")} error={errors.pan} placeholder="ABCDE1234F" mono />
          <Field id="street" label="Street address" value={form.street} onChange={set("street")} error={errors.street} autoComplete="street-address" />
          <div className="grid grid-cols-2 gap-3">
            <Field id="city" label="City" value={form.city} onChange={set("city")} error={errors.city} />
            <Field id="state" label="State" value={form.state} onChange={set("state")} error={errors.state} />
          </div>
          <Field id="postalCode" label="PIN code" value={form.postalCode} onChange={set("postalCode")} error={errors.postalCode} inputMode="numeric" mono />
          <p className="text-xs uppercase tracking-wide mt-6 mb-3" style={{ ...MONO, color: "#6B6F76" }}>Where your money is settled</p>
          <Field id="beneficiaryName" label="Account holder name" value={form.beneficiaryName} onChange={set("beneficiaryName")} error={errors.beneficiaryName} />
          <Field id="accountNumber" label="Bank account number" value={form.accountNumber} onChange={set("accountNumber")} error={errors.accountNumber} inputMode="numeric" mono />
          <Field id="ifsc" label="IFSC" value={form.ifsc} onChange={set("ifsc")} error={errors.ifsc} placeholder="HDFC0001234" mono hint="Your PAN and bank details are sent to Razorpay to verify you. chatmarket doesn't keep them." />
          <button type="submit" disabled={busy} className="mt-2 px-5 py-2.5 rounded-md text-sm inline-flex items-center gap-2 disabled:opacity-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
            {busy && <Loader2 size={14} className="animate-spin" />} {status?.has_account ? "Submit again" : "Create payment account"}
          </button>
        </form>
      )}
      {message && <p className="text-sm mt-4" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "#B33A2E" : "#2F6F62" }}>{message.text}</p>}
    </div>
  );
}
