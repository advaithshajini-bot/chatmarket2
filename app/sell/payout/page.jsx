"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowLeft, Building2, User, CheckCircle2, Loader2, ShieldCheck, Info, Copy } from "lucide-react";
import TopNav from "@/components/TopNav";

const ACCOUNT_TYPES = [
  { id: "individual", label: "Individual", desc: "Selling on your own, no registered business", icon: User },
  { id: "proprietorship", label: "Proprietorship", desc: "Sole proprietor with GST/business registration", icon: Building2 },
  { id: "partnership", label: "Partnership", desc: "Registered partnership firm", icon: Building2 },
  { id: "pvt_ltd", label: "Private Limited", desc: "Registered company", icon: Building2 },
];

const VERIFY_STEPS = ["Validating PAN details", "Confirming bank account (penny-drop)", "Creating your Razorpay linked account"];

function Stepper({ step }) {
  const labels = ["Account type", "Your details", "Bank account", "Verify"];
  return (
    <div className="flex items-center gap-2 mb-8">
      {labels.map((label, i) => {
        const idx = i + 1;
        const active = step === idx;
        const done = step > idx;
        return (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0"
                style={{ background: done ? "#2F6F62" : active ? "#14213D" : "#FFFFFF", color: done || active ? "#FFFFFF" : "#6B6F76", border: done || active ? "none" : "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace" }}
              >
                {done ? <CheckCircle2 size={13} /> : idx}
              </div>
              <span className="text-sm hidden sm:inline" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: active ? "#14213D" : "#6B6F76", fontWeight: active ? 600 : 400 }}>{label}</span>
            </div>
            {idx < labels.length && <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, hint, mono }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 rounded text-sm outline-none"
        style={{ border: "1px solid #D8D5C9", fontFamily: mono ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
      />
      {hint && <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p>}
    </div>
  );
}

export default function PayoutOnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [accountType, setAccountType] = useState("");
  const [details, setDetails] = useState({ legalName: "", pan: "", email: "", phone: "" });
  const [bank, setBank] = useState({ accountHolder: "", accountNumber: "", confirmAccount: "", ifsc: "" });
  const [complete, setComplete] = useState(false);

  const [checkedCount, setCheckedCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (step !== 4 || started.current) return;
    started.current = true;
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setCheckedCount(i);
      if (i >= VERIFY_STEPS.length) {
        clearInterval(interval);
        setTimeout(() => setFinished(true), 500);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  const detailsValid = details.legalName && details.pan.length === 10 && details.email && details.phone.length === 10;
  const bankValid = bank.accountNumber.length >= 9 && bank.accountNumber === bank.confirmAccount && bank.ifsc.length === 11 && bank.accountHolder;
  const ifscValid = bank.ifsc.length === 11;
  const progress = Math.min((checkedCount / VERIFY_STEPS.length) * 100, 100);

  if (complete) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <div style={{ maxWidth: 640, margin: "60px auto" }} className="text-center px-6">
          <ShieldCheck size={32} color="#2F6F62" className="mx-auto mb-4" />
          <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>You're all set to get paid</h2>
          <p className="text-sm mb-6" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>Payout setup complete.</p>
          <button
            onClick={() => router.push("/sell")}
            className="px-6 py-3 rounded text-sm inline-flex items-center gap-2"
            style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
          >
            Back to dashboard <ArrowRight size={15} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-3xl mx-auto">
        <div className="flex items-start gap-2 mb-6 p-3 rounded-md" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
          <Info size={15} color="#8A6A18" className="mt-0.5 shrink-0" />
          <p className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            Your listings stay live either way, but earnings can't be paid out until this is complete. Takes about 3 minutes.
          </p>
        </div>

        <Stepper step={step} />

        {step === 1 && (
          <div>
            <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>How do you want to receive payouts?</h2>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>This determines what verification documents Razorpay needs from you.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
              {ACCOUNT_TYPES.map((t) => {
                const Icon = t.icon;
                const active = accountType === t.id;
                return (
                  <button key={t.id} onClick={() => setAccountType(t.id)} className="text-left p-4 rounded-md transition-colors" style={{ border: active ? "1.5px solid #14213D" : "1px solid #D8D5C9", background: active ? "#EDEEEA" : "#FFFFFF" }}>
                    <Icon size={18} color="#14213D" className="mb-2" />
                    <p className="text-sm mb-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>{t.label}</p>
                    <p className="text-xs" style={{ color: "#6B6F76" }}>{t.desc}</p>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setStep(2)} disabled={!accountType} className="px-6 py-3 rounded text-sm inline-flex items-center gap-2" style={{ background: accountType ? "#E2A83E" : "#D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}>
              Continue <ArrowRight size={15} />
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Your details</h2>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>Must match your PAN card exactly.</p>
            <div className="space-y-4 max-w-md mb-8">
              <Field label="Legal name" value={details.legalName} onChange={(v) => setDetails({ ...details, legalName: v })} placeholder="As printed on PAN card" />
              <Field label="PAN number" value={details.pan} onChange={(v) => setDetails({ ...details, pan: v.toUpperCase() })} placeholder="ABCDE1234F" mono hint="10 characters, no spaces" />
              <Field label="Email" value={details.email} onChange={(v) => setDetails({ ...details, email: v })} placeholder="you@example.com" />
              <Field label="Phone number" value={details.phone} onChange={(v) => setDetails({ ...details, phone: v.replace(/\D/g, "") })} placeholder="10-digit mobile number" mono />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => setStep(1)} className="px-5 py-3 rounded text-sm inline-flex items-center gap-2" style={{ border: "1.5px solid #14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}><ArrowLeft size={15} /> Back</button>
              <button onClick={() => setStep(3)} disabled={!detailsValid} className="px-6 py-3 rounded text-sm inline-flex items-center gap-2" style={{ background: detailsValid ? "#E2A83E" : "#D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}>Continue <ArrowRight size={15} /></button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Where should we send your earnings?</h2>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>We'll verify this with a ₹1 penny-drop before it's saved.</p>
            <div className="space-y-4 max-w-md mb-2">
              <Field label="Account holder name" value={bank.accountHolder} onChange={(v) => setBank({ ...bank, accountHolder: v })} placeholder="Exactly as it appears on your bank account" />
              <Field label="Account number" value={bank.accountNumber} onChange={(v) => setBank({ ...bank, accountNumber: v.replace(/\D/g, "") })} placeholder="0000000000" mono />
              <Field label="Confirm account number" value={bank.confirmAccount} onChange={(v) => setBank({ ...bank, confirmAccount: v.replace(/\D/g, "") })} placeholder="Re-enter account number" mono />
              <div>
                <Field label="IFSC code" value={bank.ifsc} onChange={(v) => setBank({ ...bank, ifsc: v.toUpperCase() })} placeholder="HDFC0001234" mono />
                {ifscValid && <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#2F6F62" }}><CheckCircle2 size={12} /> HDFC Bank, Koramangala Branch</p>}
              </div>
            </div>
            {bank.confirmAccount && bank.accountNumber !== bank.confirmAccount && <p className="text-xs mb-4" style={{ color: "#B33A2E" }}>Account numbers don't match</p>}
            <div className="flex items-center gap-3 mt-6">
              <button onClick={() => setStep(2)} className="px-5 py-3 rounded text-sm inline-flex items-center gap-2" style={{ border: "1.5px solid #14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}><ArrowLeft size={15} /> Back</button>
              <button onClick={() => setStep(4)} disabled={!bankValid} className="px-6 py-3 rounded text-sm inline-flex items-center gap-2" style={{ background: bankValid ? "#E2A83E" : "#D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}>Submit for verification <ArrowRight size={15} /></button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg mx-auto text-center py-8">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: finished ? "#EAF2EF" : "#FBF1DD" }}>
              {finished ? <ShieldCheck size={24} color="#2F6F62" /> : <Loader2 size={22} color="#8A6A18" className="animate-spin" />}
            </div>
            <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{finished ? "Payouts are enabled" : "Verifying your details"}</h2>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>{finished ? "Earnings from unlocked threads will now settle to this account automatically." : "This usually takes under a minute."}</p>
            <div className="w-full h-1.5 rounded-full mb-6" style={{ background: "#D8D5C9" }}>
              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: finished ? "#2F6F62" : "#E2A83E" }} />
            </div>
            <div className="text-left space-y-2.5 mb-8">
              {VERIFY_STEPS.map((check, i) => {
                const done = i < checkedCount;
                return (
                  <div key={check} className="flex items-center gap-2.5 text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: done ? "#14213D" : "#6B6F76" }}>
                    {done ? <CheckCircle2 size={16} color="#2F6F62" /> : <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1.5px solid #D8D5C9" }} />}
                    {check}
                  </div>
                );
              })}
            </div>
            {finished && (
              <>
                <div className="text-left rounded-md p-4 mb-6" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
                  <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Linked account ID</p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#14213D" }}>acc_LiNkEd9xQ2m</span>
                    <Copy size={14} color="#6B6F76" style={{ cursor: "pointer" }} />
                  </div>
                </div>
                <button onClick={() => setComplete(true)} className="px-6 py-3 rounded text-sm inline-flex items-center gap-2" style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}>
                  Continue <ArrowRight size={15} />
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
