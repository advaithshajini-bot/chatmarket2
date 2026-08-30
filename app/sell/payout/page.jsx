"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, ArrowLeft, CheckCircle2, Loader2, ShieldCheck, Info, Copy,
  AlertCircle,
} from "lucide-react";
import TopNav from "@/components/TopNav";
import DatePickerField from "@/components/DatePickerField";
import { COUNTRIES } from "@/lib/countries";
import { EDUCATION_QUALIFICATIONS, OCCUPATION_TYPES } from "@/lib/kyc-options";
import { createClient } from "@/lib/supabase/client";

const VERIFY_STEPS = ["Validating PAN details", "Confirming bank account (penny-drop)", "Creating your Razorpay linked account"];
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const OTP_COOLDOWN_SECONDS = 60;

const KYC_SECTION_BG = "#EAF1FB";
const KYC_BORDER = "#D7E3F5";

function Stepper({ step }) {
  const labels = ["Your details", "Bank account", "Verify"];
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

function Section({ children, className = "" }) {
  return (
    <div className={`rounded-md p-5 mb-4 ${className}`} style={{ background: KYC_SECTION_BG, border: `1px solid ${KYC_BORDER}` }}>
      {children}
    </div>
  );
}

function Label({ required, children }) {
  return (
    <label className="text-sm mb-1.5 block" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>
      {required && <span style={{ color: "#B33A2E" }}>*</span>}{children}
    </label>
  );
}

function TextField({ label, required, value, onChange, placeholder, mono, type = "text" }) {
  return (
    <div>
      <Label required={required}>{label}</Label>
      <input
        type={type}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || "Enter here"}
        className="w-full px-3 py-2.5 rounded text-sm outline-none"
        style={{ border: "1px solid #D8D5C9", fontFamily: mono ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
      />
    </div>
  );
}

function SelectField({ label, required, value, onChange, options, placeholder = "Select" }) {
  return (
    <div>
      <Label required={required}>{label}</Label>
      <select
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded text-sm outline-none"
        style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.id} value={o.id}>{o.label}</option>))}
      </select>
    </div>
  );
}

function RadioGroup({ label, required, value, onChange, options }) {
  return (
    <div>
      <Label required={required}>{label}</Label>
      <div className="flex items-center gap-6 flex-wrap">
        {options.map((o) => {
          const optValue = typeof o === "string" ? o : o.id;
          const optLabel = typeof o === "string" ? o : o.label;
          return (
            <label key={optValue} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={value === optValue} onChange={() => onChange(optValue)} style={{ accentColor: "#14213D" }} />
              <span className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{optLabel}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function FileAttachment({ label, path, onChange, userId }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "application/pdf"].includes(file.type)) {
      setError("PNG, JPEG, or PDF only.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Max 10MB.");
      return;
    }
    setError("");
    setUploading(true);
    const supabase = createClient();
    const newPath = `${userId}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from("seller-kyc-documents").upload(newPath, file);
    setUploading(false);
    if (uploadError) {
      setError(uploadError.message);
      return;
    }
    if (path) await supabase.storage.from("seller-kyc-documents").remove([path]);
    onChange(newPath);
  };

  const handleRemove = async () => {
    if (!path) return;
    const supabase = createClient();
    await supabase.storage.from("seller-kyc-documents").remove([path]);
    onChange(null);
  };

  const handleDownload = async () => {
    if (!path) return;
    const supabase = createClient();
    const { data } = await supabase.storage.from("seller-kyc-documents").createSignedUrl(path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  return (
    <div>
      <p className="text-sm mb-1.5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{label}</p>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[100px] px-3 py-2 rounded text-xs" style={{ background: "#E4E9F2", border: "1px solid #D8D5C9", color: "#6B6F76" }}>
          {uploading ? "Uploading…" : path ? path.split("-").slice(1).join("-") : "No file chosen"}
        </div>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,application/pdf" className="hidden" onChange={(e) => handleFile(e.target.files?.[0])} />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="px-3 py-2 rounded text-xs font-medium" style={{ background: "#6E97C9", color: "#FFFFFF" }}>Choose File</button>
        <button type="button" onClick={handleRemove} disabled={!path} className="px-3 py-2 rounded text-xs font-medium disabled:opacity-50" style={{ background: "#6E97C9", color: "#FFFFFF" }}>Remove</button>
        <button type="button" onClick={handleDownload} disabled={!path} className="px-3 py-2 rounded text-xs font-medium disabled:opacity-50" style={{ background: "#6E97C9", color: "#FFFFFF" }}>Download</button>
      </div>
      {error && <p className="text-xs mt-1" style={{ color: "#B33A2E" }}>{error}</p>}
    </div>
  );
}

function OtpControl({ channel, canSend, verified, onVerified }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [devOtp, setDevOtp] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleSend = async () => {
    setSending(true);
    setError("");
    const res = await fetch("/api/kyc/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel }),
    });
    const data = await res.json();
    setSending(false);
    if (!res.ok) {
      setError(data.error || "Couldn't send OTP.");
      return;
    }
    setSent(true);
    setCooldown(OTP_COOLDOWN_SECONDS);
    setDevOtp(data.devOtp || "");
  };

  const handleVerify = async () => {
    setVerifying(true);
    setError("");
    const res = await fetch("/api/kyc/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, code }),
    });
    const data = await res.json();
    setVerifying(false);
    if (!res.ok) {
      setError(data.error || "Verification failed.");
      return;
    }
    onVerified();
  };

  if (verified) {
    return (
      <div className="flex items-center gap-2 text-sm mt-1" style={{ color: "#2F6F62" }}>
        <CheckCircle2 size={14} /> Verified
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap mt-2">
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend || sending || cooldown > 0}
          className="px-4 py-2 rounded text-xs font-medium disabled:opacity-50"
          style={{ background: "#6E97C9", color: "#FFFFFF" }}
        >
          {sending ? "Sending…" : "Send OTP"}
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={!sent || cooldown > 0}
          className="px-4 py-2 rounded text-xs font-medium disabled:opacity-50"
          style={{ background: "#9DB8DA", color: "#FFFFFF" }}
        >
          {cooldown > 0 ? `Resend OTP (${cooldown}s)` : "Resend OTP"}
        </button>
      </div>
      <p className="text-[11px] mt-1" style={{ color: "#6B6F76" }}>Re-send OTP button shall be enabled post expiry of one minute of clicking of 'Send OTP' button.</p>

      {devOtp && (
        <div className="flex items-start gap-2 p-2.5 rounded-md mt-2" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
          <AlertCircle size={13} color="#8A6A18" className="mt-0.5 shrink-0" />
          <p className="text-xs" style={{ color: "#6B6F76" }}>
            No SMS/email provider is connected yet, so here's the code directly: <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, color: "#14213D" }}>{devOtp}</span>
          </p>
        </div>
      )}

      {sent && (
        <div className="mt-3">
          <Label required>{`Enter OTP for ${channel === "mobile" ? "Mobile Number" : "E-mail ID"}`}</Label>
          <div className="flex items-center gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="px-3 py-2.5 rounded text-sm outline-none w-40"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
            />
            <button
              type="button"
              onClick={handleVerify}
              disabled={code.length !== 6 || verifying}
              className="px-4 py-2 rounded text-xs font-medium disabled:opacity-50"
              style={{ background: "#14213D", color: "#FFFFFF" }}
            >
              {verifying ? "Verifying…" : "Verify OTP"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs mt-1" style={{ color: "#B33A2E" }}>{error}</p>}
    </div>
  );
}

function AddressFields({ address, onChange }) {
  const set = (field) => (v) => onChange({ ...address, [field]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <TextField label="Address Line 1" required value={address.address_line1} onChange={set("address_line1")} />
      <TextField label="Address Line 2" value={address.address_line2} onChange={set("address_line2")} />
      <SelectField label="Country" required value={address.country} onChange={set("country")} options={COUNTRIES} />
      <TextField label="Pin Code/Zip Code" required value={address.pincode} onChange={set("pincode")} />
      <TextField label="Area/Locality" required value={address.area} onChange={set("area")} />
      <TextField label="City" required value={address.city} onChange={set("city")} />
      <TextField label="District" value={address.district} onChange={set("district")} />
      <TextField label="State/UT" required value={address.state} onChange={set("state")} />
      <TextField label="Jurisdiction of Police Station" required value={address.police_station} onChange={set("police_station")} />
      <TextField label="Phone" required value={address.phone} onChange={set("phone")} mono />
      <TextField label="Fax" value={address.fax} onChange={set("fax")} mono />
    </div>
  );
}

const EMPTY_ADDRESS = { address_line1: "", address_line2: "", country: "", pincode: "", area: "", city: "", district: "", state: "", police_station: "", phone: "", fax: "" };

function KycDetailsStep({ userId, onContinue }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [f, setF] = useState({
    citizen_of_india: null,
    first_name: "", middle_name: "", last_name: "",
    father_first_name: "", father_middle_name: "", father_last_name: "",
    nationality: "",
    resident_in_india: null,
    occupation_type: "",
    education_qualification: "",
    education_qualification_other: "",
    date_of_birth: "",
    gender: "",
    pan_number: "",
    pan_attachment_path: null,
    has_aadhaar: null,
    aadhaar_last4: "",
    aadhaar_attachment_path: null,
    mobile_country_code: "+91",
    mobile_number: "",
    mobile_verified: false,
    email: "",
    email_verified: false,
    permanent_address: EMPTY_ADDRESS,
    present_same_as_permanent: null,
    present_address: EMPTY_ADDRESS,
  });
  const [panVerifyMsg, setPanVerifyMsg] = useState("");

  useEffect(() => {
    const load = async () => {
      const supabase = createClient();
      const { data } = await supabase.from("seller_kyc").select("*").eq("user_id", userId).maybeSingle();
      if (data) {
        setF((prev) => ({
          ...prev,
          ...data,
          permanent_address: { ...EMPTY_ADDRESS, ...(data.permanent_address || {}) },
          present_address: { ...EMPTY_ADDRESS, ...(data.present_address || {}) },
        }));
      }
      setLoading(false);
    };
    load();
  }, [userId]);

  const set = (field) => (v) => setF((prev) => ({ ...prev, [field]: v }));
  const panValid = PAN_REGEX.test(f.pan_number || "");

  const handleSave = async (advance) => {
    setSaving(true);
    setError("");
    const supabase = createClient();
    const { error: upsertError } = await supabase.from("seller_kyc").upsert(
      {
        user_id: userId,
        citizen_of_india: f.citizen_of_india,
        first_name: f.first_name, middle_name: f.middle_name, last_name: f.last_name,
        father_first_name: f.father_first_name, father_middle_name: f.father_middle_name, father_last_name: f.father_last_name,
        nationality: f.nationality,
        resident_in_india: f.resident_in_india,
        occupation_type: f.occupation_type || null,
        education_qualification: f.education_qualification,
        education_qualification_other: f.education_qualification === "Others" ? f.education_qualification_other : null,
        date_of_birth: f.date_of_birth || null,
        pan_number: f.pan_number,
        pan_attachment_path: f.pan_attachment_path,
        has_aadhaar: f.has_aadhaar,
        aadhaar_last4: f.aadhaar_last4,
        aadhaar_attachment_path: f.aadhaar_attachment_path,
        permanent_address: f.permanent_address,
        present_same_as_permanent: f.present_same_as_permanent,
        present_address: f.present_same_as_permanent ? f.permanent_address : f.present_address,
      },
      { onConflict: "user_id" }
    );
    setSaving(false);
    if (upsertError) {
      setError(upsertError.message);
      return;
    }
    if (advance) onContinue();
  };

  if (loading) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>Loading…</p>;
  }

  const requiredFilled =
    f.citizen_of_india !== null &&
    f.first_name && f.last_name &&
    f.nationality &&
    f.resident_in_india !== null &&
    f.education_qualification &&
    f.date_of_birth &&
    f.gender &&
    f.mobile_verified &&
    f.email_verified &&
    f.permanent_address.address_line1 && f.permanent_address.country && f.permanent_address.pincode &&
    f.permanent_address.area && f.permanent_address.city && f.permanent_address.state &&
    f.permanent_address.police_station && f.permanent_address.phone &&
    f.present_same_as_permanent !== null &&
    (f.present_same_as_permanent || (f.present_address.address_line1 && f.present_address.country && f.present_address.pincode && f.present_address.area && f.present_address.city && f.present_address.state && f.present_address.police_station && f.present_address.phone));

  return (
    <div>
      <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Your details</h2>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>Applicant's name and date of birth should match your PAN card exactly.</p>

      <Section>
        <RadioGroup label="Whether a citizen of India" required value={f.citizen_of_india === null ? "" : f.citizen_of_india ? "Yes" : "No"} onChange={(v) => set("citizen_of_india")(v === "Yes")} options={["Yes", "No"]} />
      </Section>

      <Section>
        <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>Applicant's Name (Enter full name and do not use abbreviations)</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField label="First name" required value={f.first_name} onChange={set("first_name")} />
          <TextField label="Middle name" value={f.middle_name} onChange={set("middle_name")} />
          <TextField label="Last name" required value={f.last_name} onChange={set("last_name")} />
        </div>
      </Section>

      <Section>
        <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>Father's Name (Even married women must enter details of father's name)</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TextField label="First name" value={f.father_first_name} onChange={set("father_first_name")} />
          <TextField label="Middle name" value={f.father_middle_name} onChange={set("father_middle_name")} />
          <TextField label="Last name" value={f.father_last_name} onChange={set("father_last_name")} />
        </div>
      </Section>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <Section className="!mb-0"><SelectField label="Nationality" required value={f.nationality} onChange={set("nationality")} options={COUNTRIES} /></Section>
        <Section className="!mb-0"><RadioGroup label="Whether resident in India" required value={f.resident_in_india === null ? "" : f.resident_in_india ? "Yes" : "No"} onChange={(v) => set("resident_in_india")(v === "Yes")} options={["Yes", "No"]} /></Section>
      </div>

      <Section>
        <RadioGroup label="Occupation type" required value={f.occupation_type} onChange={set("occupation_type")} options={OCCUPATION_TYPES} />
      </Section>

      <Section>
        <SelectField label="Educational qualification" required value={f.education_qualification} onChange={set("education_qualification")} options={EDUCATION_QUALIFICATIONS} />
        {f.education_qualification === "Others" && (
          <div className="mt-3"><TextField label="Please specify" required value={f.education_qualification_other} onChange={set("education_qualification_other")} /></div>
        )}
      </Section>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <Section className="!mb-0">
          <Label required>Date of birth</Label>
          <DatePickerField value={f.date_of_birth} onChange={set("date_of_birth")} max={new Date().toISOString().slice(0, 10)} />
        </Section>
        <Section className="!mb-0"><RadioGroup label="Gender" required value={f.gender} onChange={set("gender")} options={["Male", "Female", "Transgender"]} /></Section>
      </div>

      <Section>
        <Label>Income-tax permanent account number</Label>
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <input
            value={f.pan_number}
            onChange={(e) => { set("pan_number")(e.target.value.toUpperCase().slice(0, 10)); setPanVerifyMsg(""); }}
            placeholder="ABCDE1234F"
            className="px-3 py-2.5 rounded text-sm outline-none flex-1 min-w-[180px]"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
          />
          <button
            type="button"
            disabled={!panValid}
            onClick={() => setPanVerifyMsg("PAN format looks valid. Full verification against government records happens during Route KYC review — not yet connected here.")}
            className="px-4 py-2.5 rounded text-xs font-medium disabled:opacity-50"
            style={{ background: "#6E97C9", color: "#FFFFFF" }}
          >
            Verify income tax PAN
          </button>
        </div>
        {panVerifyMsg && <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>{panVerifyMsg}</p>}
        <FileAttachment label="Income tax PAN attachment" path={f.pan_attachment_path} onChange={set("pan_attachment_path")} userId={userId} />
      </Section>

      <Section>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
          <RadioGroup label="Do you have Aadhaar?" required value={f.has_aadhaar === null ? "" : f.has_aadhaar ? "Yes" : "No"} onChange={(v) => set("has_aadhaar")(v === "Yes")} options={["Yes", "No"]} />
          {f.has_aadhaar && (
            <div>
              <Label>Aadhaar number</Label>
              <input
                value={f.aadhaar_last4}
                onChange={(e) => set("aadhaar_last4")(e.target.value.replace(/\D/g, "").slice(-4))}
                placeholder="Last 4 digits"
                maxLength={4}
                className="w-full px-3 py-2.5 rounded text-sm outline-none"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
              />
              <p className="text-[11px] mt-1" style={{ color: "#6B6F76" }}>Only the last 4 digits are stored — the uploaded document is what's used for verification.</p>
            </div>
          )}
        </div>
        {f.has_aadhaar && <FileAttachment label="Aadhaar number attachment" path={f.aadhaar_attachment_path} onChange={set("aadhaar_attachment_path")} userId={userId} />}
      </Section>

      <Section>
        <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>Permanent residential address</p>
        <AddressFields address={f.permanent_address} onChange={set("permanent_address")} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <Label required>Mobile (with country code)</Label>
            <div className="flex items-center gap-2">
              <input value={f.mobile_country_code} onChange={(e) => set("mobile_country_code")(e.target.value)} className="w-16 px-2 py-2.5 rounded text-sm outline-none" style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }} />
              <input value={f.mobile_number} onChange={(e) => set("mobile_number")(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="10-digit number" className="flex-1 px-3 py-2.5 rounded text-sm outline-none" style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }} />
            </div>
            <OtpControl
              channel="mobile"
              canSend={f.mobile_number.length === 10 && !!f.mobile_country_code}
              verified={f.mobile_verified}
              onVerified={() => set("mobile_verified")(true)}
            />
          </div>

          <div>
            <Label required>E-mail ID</Label>
            <input value={f.email} onChange={(e) => set("email")(e.target.value)} placeholder="Enter Here" className="w-full px-3 py-2.5 rounded text-sm outline-none" style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }} />
            <OtpControl
              channel="email"
              canSend={/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email || "")}
              verified={f.email_verified}
              onVerified={() => set("email_verified")(true)}
            />
          </div>
        </div>
      </Section>

      <Section>
        <RadioGroup
          label="Whether present residential address is same as permanent residential address"
          required
          value={f.present_same_as_permanent === null ? "" : f.present_same_as_permanent ? "Yes" : "No"}
          onChange={(v) => set("present_same_as_permanent")(v === "Yes")}
          options={["Yes", "No"]}
        />
      </Section>

      {f.present_same_as_permanent === false && (
        <Section>
          <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>Present residential address</p>
          <AddressFields address={f.present_address} onChange={set("present_address")} />
        </Section>
      )}

      {error && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{error}</p>}

      <div className="flex items-center justify-end gap-3 mt-6">
        <button
          type="button"
          onClick={() => handleSave(false)}
          disabled={saving}
          className="px-5 py-2.5 rounded text-sm"
          style={{ border: "1.5px solid #14213D", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => handleSave(true)}
          disabled={saving || !requiredFilled}
          className="px-6 py-2.5 rounded text-sm inline-flex items-center gap-2"
          style={{ background: requiredFilled ? "#14213D" : "#D8D5C9", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
        >
          {saving ? "Saving…" : "Next"} <ArrowRight size={15} />
        </button>
      </div>
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
  const [userId, setUserId] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [step, setStep] = useState(1);
  const [bank, setBank] = useState({ accountHolder: "", accountNumber: "", confirmAccount: "", ifsc: "" });
  const [complete, setComplete] = useState(false);

  const [checkedCount, setCheckedCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.push("/login?next=/sell/payout");
        return;
      }
      setUserId(data.user.id);
      setCheckingAuth(false);
    });
  }, [router]);

  useEffect(() => {
    if (step !== 3 || started.current) return;
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

  const bankValid = bank.accountNumber.length >= 9 && bank.accountNumber === bank.confirmAccount && bank.ifsc.length === 11 && bank.accountHolder;
  const ifscValid = bank.ifsc.length === 11;
  const progress = Math.min((checkedCount / VERIFY_STEPS.length) * 100, 100);

  if (checkingAuth) {
    return (
      <div style={{ minHeight: "100vh" }}>
        <TopNav />
        <main className="px-6 py-16 max-w-sm mx-auto text-center">
          <p className="text-sm" style={{ color: "#6B6F76" }}>Checking your session…</p>
        </main>
      </div>
    );
  }

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
            Your listings stay live either way, but earnings can't be paid out until this is complete.
          </p>
        </div>

        <Stepper step={step} />

        {step === 1 && <KycDetailsStep userId={userId} onContinue={() => setStep(2)} />}

        {step === 2 && (
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
              <button onClick={() => setStep(1)} className="px-5 py-3 rounded text-sm inline-flex items-center gap-2" style={{ border: "1.5px solid #14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}><ArrowLeft size={15} /> Back</button>
              <button onClick={() => setStep(3)} disabled={!bankValid} className="px-6 py-3 rounded text-sm inline-flex items-center gap-2" style={{ background: bankValid ? "#E2A83E" : "#D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}>Submit for verification <ArrowRight size={15} /></button>
            </div>
          </div>
        )}

        {step === 3 && (
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
