"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, ShieldCheck, Lock, Info } from "lucide-react";
import TopNav from "@/components/TopNav";
import { createClient } from "@/lib/supabase/client";
import { ID_TYPES, validateIdentity, explainDirectError, getMyDirectSellerStatus } from "@/lib/domain/direct-upi";

// Step 1 of seller onboarding (flag `direct_upi_checkout`): identity and tax details, saved BEFORE the UPI ID (step 2 at /sell/payout).
// The database function set_seller_identity_details validates everything again. The government-ID NUMBER is checked and then discarded:
// only its type and last 4 characters are stored.
const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const EMPTY = { first: "", last: "", email: "", phone: "", address: "", pan: "", idType: "aadhaar", idNumber: "" };

function Field({ id, label, error, children, hint }) {
  return (
    <div>
      <label htmlFor={id} className="text-xs uppercase tracking-wide mb-1.5 block" style={{ ...MONO, color: "#6B6F76" }}>{label}</label>
      {children}
      <p className="text-[11px] mt-1 min-h-[1rem]" style={{ color: error ? "#B33A2E" : "#6B6F76" }} role={error ? "alert" : undefined}>{error || hint || ""}</p>
    </div>
  );
}
const inputStyle = (bad) => ({ border: `1px solid ${bad ? "#B33A2E" : "#D8D5C9"}`, background: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif" });

export default function SellerProfilePage() {
  const supabase = createClient();
  const router = useRouter();
  const params = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [saved, setSaved] = useState(null);       // existing row (masked on screen) | null
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [flagOn, setFlagOn] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!live) return;
        setUserId(user?.id ?? null);
        if (user) {
          const st = await getMyDirectSellerStatus(supabase);
          if (live) setFlagOn(st.flag_on);
          const { data } = await supabase.from("seller_identity_details").select("*").eq("user_id", user.id).maybeSingle();
          if (live && data) {
            setSaved(data);
            setForm({ first: data.legal_first_name, last: data.legal_last_name, email: data.contact_email, phone: data.phone_number, address: data.street_address, pan: data.pan_number, idType: data.govt_id_type, idNumber: "" });
          }
        }
      } catch { /* shows the empty form */ }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const v = validateIdentity(form);
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setMessage(null); };
  const touch = (k) => () => setTouched((t) => ({ ...t, [k]: true }));
  const err = (k) => (touched[k] || touched.all ? v.errors[k] : null);

  async function save(e) {
    e.preventDefault();
    setTouched({ all: true });
    if (!v.ok || saving) return;
    setSaving(true); setMessage(null);
    const x = v.values;
    const { error } = await supabase.rpc("set_seller_identity_details", {
      p_first: x.first, p_last: x.last, p_email: x.email, p_phone: x.phone, p_address: x.address, p_country: x.country, p_pan: x.pan, p_id_type: x.idType, p_id_number: x.idNumber,
    });
    setSaving(false);
    if (error) { setMessage({ tone: "err", text: explainDirectError(error) }); return; }
    router.push("/sell/payout");
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-10 max-w-xl mx-auto">
        <p className="text-xs uppercase tracking-wide mb-2" style={{ ...MONO, color: "#6B6F76" }}>Step 1 of 2</p>
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Your identity &amp; tax details</h1>
        <p className="text-sm mb-6" style={{ color: "#3A3D42" }}>
          Buyers pay you directly, so we ask who you are before you list. This is kept private: buyers never see it. Next, you&apos;ll add the UPI ID buyers pay.
        </p>

        {params.get("notice") === "identity" && (
          <p className="text-sm mb-5 rounded-md px-3 py-2.5" role="status" style={{ background: "#FBF1DD", border: "1px solid #E9D9AA", color: "#3A3D42" }}>
            Please complete your identity &amp; tax details before setting up your UPI payout ID.
          </p>
        )}
        {!loading && userId && !flagOn && (
          <p className="text-sm mb-5 rounded-md px-3 py-2.5" role="status" style={{ background: "#EDEEEA", border: "1px solid #D8D5C9", color: "#3A3D42" }}>
            Direct payments aren&apos;t switched on yet, so this step isn&apos;t required right now. You can still save your details.
          </p>
        )}

        {loading ? (
          <p className="text-sm" style={{ color: "#6B6F76" }}><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</p>
        ) : !userId ? (
          <div className="rounded-md p-5 text-center" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
            <Lock size={20} color="#6B6F76" className="mx-auto mb-2" />
            <p className="text-sm mb-3" style={{ color: "#6B6F76" }}>Log in to continue.</p>
            <Link href="/login?next=/sell/profile" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
          </div>
        ) : (
          <form onSubmit={save} noValidate>
            {saved && (
              <p className="text-sm mb-4 flex items-center gap-2" style={{ color: "#2F6F62" }}>
                <CheckCircle2 size={15} /> Saved · PAN {saved.pan_number.slice(0, 2)}******{saved.pan_number.slice(-2)} · {ID_TYPES.find((t) => t.value === saved.govt_id_type)?.label} ending {saved.govt_id_last4}
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
              <Field id="first" label="Legal first name" error={err("first")}><input id="first" autoComplete="given-name" value={form.first} onChange={set("first")} onBlur={touch("first")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("first"))} /></Field>
              <Field id="last" label="Legal last name" error={err("last")}><input id="last" autoComplete="family-name" value={form.last} onChange={set("last")} onBlur={touch("last")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("last"))} /></Field>
              <Field id="email" label="Contact e-mail" error={err("email")}><input id="email" type="email" autoComplete="email" value={form.email} onChange={set("email")} onBlur={touch("email")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("email"))} /></Field>
              <Field id="phone" label="Mobile number" error={err("phone")} hint="10 digits, +91 optional"><input id="phone" type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} onBlur={touch("phone")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("phone"))} /></Field>
            </div>
            <Field id="address" label="Street address" error={err("address")}><input id="address" autoComplete="street-address" value={form.address} onChange={set("address")} onBlur={touch("address")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("address"))} /></Field>
            <Field id="country" label="Country"><input id="country" value="India" disabled className="w-full px-3 py-2.5 rounded text-sm outline-none" style={{ ...inputStyle(false), background: "#EDEEEA" }} /></Field>
            <Field id="pan" label="PAN" error={err("pan")} hint="10 characters, like ABCDE1234F"><input id="pan" autoCapitalize="characters" autoComplete="off" maxLength={10} value={form.pan} onChange={(e) => { setForm({ ...form, pan: e.target.value.toUpperCase() }); setMessage(null); }} onBlur={touch("pan")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={{ ...inputStyle(err("pan")), ...MONO }} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
              <Field id="idType" label="Government ID type" error={err("idType")}>
                <select id="idType" value={form.idType} onChange={set("idType")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={inputStyle(err("idType"))}>
                  {ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </Field>
              <Field id="idNumber" label="ID number" error={err("idNumber")} hint={saved ? "Re-enter it to update your details. We don't keep the full number." : "We check it, then keep only the last 4 characters."}>
                <input id="idNumber" autoComplete="off" value={form.idNumber} onChange={set("idNumber")} onBlur={touch("idNumber")} className="w-full px-3 py-2.5 rounded text-sm outline-none" style={{ ...inputStyle(err("idNumber")), ...MONO }} />
              </Field>
            </div>

            <button type="submit" disabled={saving} className="mt-2 px-5 py-2.5 rounded-md text-sm inline-flex items-center gap-2 disabled:opacity-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} {saved ? "Update and continue" : "Save and continue"}
            </button>
            {message && <p className="text-sm mt-4" role={message.tone === "err" ? "alert" : "status"} style={{ color: message.tone === "err" ? "#B33A2E" : "#2F6F62" }}>{message.text}</p>}
          </form>
        )}

        <div className="rounded-md p-4 mt-8 flex gap-3" style={{ background: "#FBF1DD", border: "1px solid #E9D9AA" }}>
          <Info size={16} color="#8A6A18" className="shrink-0 mt-0.5" />
          <p className="text-sm" style={{ color: "#3A3D42" }}>Only you and an authorised administrator can see these details. Your government-ID number is never stored in full.</p>
        </div>
      </main>
    </div>
  );
}
