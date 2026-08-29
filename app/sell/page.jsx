"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  ArrowRight,
  BarChart3,
  Clock,
  AlertCircle,
  MessageSquare,
  Star,
  TrendingUp,
  Image as ImageIcon,
} from "lucide-react";
import TopNav from "@/components/TopNav";
import StatusPill from "@/components/StatusPill";
import { CATEGORIES, MODELS } from "@/lib/categories";
import { parseThreadExport } from "@/lib/parse-thread-export";
import { redactListing } from "@/lib/redact-pii";
import { createClient } from "@/lib/supabase/client";
import { PLATFORM_FEE_PCT } from "@/lib/constants";

const SCAN_CHECKS = [
  "Scanning for email addresses & phone numbers",
  "Scanning for API keys & credentials",
  "Checking for names, companies & addresses",
  "Confirming thread completeness",
];

function Stepper({ step }) {
  const steps = ["List your thread", "Screening", "Dashboard"];
  return (
    <div className="flex items-center gap-3 mb-8">
      {steps.map((label, i) => {
        const idx = i + 1;
        const active = step === idx;
        const done = step > idx;
        return (
          <div key={label} className="flex items-center gap-3 flex-1">
            <div className="flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0"
                style={{
                  background: done ? "#2F6F62" : active ? "#14213D" : "#FFFFFF",
                  color: done || active ? "#FFFFFF" : "#6B6F76",
                  border: done || active ? "none" : "1px solid #D8D5C9",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {done ? <CheckCircle2 size={13} /> : idx}
              </div>
              <span
                className="text-sm hidden sm:inline"
                style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: active ? "#14213D" : "#6B6F76", fontWeight: active ? 600 : 400 }}
              >
                {label}
              </span>
            </div>
            {idx < steps.length && <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />}
          </div>
        );
      })}
    </div>
  );
}

function MiniStepper({ step }) {
  const labels = ["Upload", "Details", "Price"];
  return (
    <div className="flex items-center gap-2 mb-6">
      {labels.map((label, i) => {
        const idx = i + 1;
        const active = step === idx;
        const done = step > idx;
        return (
          <div key={label} className="flex items-center gap-2 flex-1">
            <span
              className="text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5"
              style={{
                background: done ? "#EAF2EF" : active ? "#14213D" : "#F7F7F4",
                color: done ? "#2F6F62" : active ? "#F7F7F4" : "#6B6F76",
                border: done || active ? "none" : "1px solid #D8D5C9",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {done ? <CheckCircle2 size={11} /> : idx} {label}
            </span>
            {idx < labels.length && <div className="flex-1 h-px" style={{ background: "#D8D5C9" }} />}
          </div>
        );
      })}
    </div>
  );
}

function BuyerPreviewCard({ form }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Buyer preview</p>
      <div className="rounded-md p-4 sticky top-20" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
        <div className="flex items-center justify-between mb-3">
          {form.model ? (
            <span className="text-[11px] uppercase px-2 py-0.5 rounded-sm" style={{ fontFamily: "'IBM Plex Mono', monospace", background: "#EDEEEA", border: "1px solid #D8D5C9" }}>{form.model}</span>
          ) : <span className="text-xs" style={{ color: "#6B6F76" }}>Model not set</span>}
          <span className="flex items-center gap-1 text-xs" style={{ color: "#6B6F76" }}>
            <Star size={11} fill="#D8D5C9" color="#D8D5C9" /> New listing
          </span>
        </div>
        <h3 className="text-[16px] mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: form.title ? "#14213D" : "#B7BAC0" }}>
          {form.title || "Your listing title will appear here"}
        </h3>
        <p className="text-xs mb-4" style={{ color: "#6B6F76" }}>
          {form.description || "A short note on progress helps buyers trust the listing."}
        </p>
        <div className="flex items-center justify-between text-xs pt-3" style={{ borderTop: "1px dashed #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
          <span>{form.messages || "—"} msgs · {form.completion}% done</span>
          <span className="text-base" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{form.price ? `₹${form.price}` : "₹—"}</span>
        </div>
      </div>
    </div>
  );
}

// Step 1 of 3 — upload. Reads the dropped file client-side and runs it
// through parseThreadExport() for a real (best-effort) auto-detect of the
// source model and message count, per the PDF's "we auto-detect" note.
// Detection isn't an oracle for arbitrary export formats, so both fields
// stay editable — the seller can always override what was detected.
// Screenshots upload straight to the listing-screenshots bucket under
// <seller_id>/<listingId>/<file>, scoped by form.listingId (generated
// client-side before the listing row itself exists — see SellPage). RLS on
// the bucket checks that path prefix against auth.uid(), independent of the
// listings table, since there's no listing row to check ownership against yet.
function ScreenshotUploader({ form, setForm }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);
  const MAX_SHOTS = 4;

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, MAX_SHOTS - form.screenshots.length);
    if (!files.length) return;

    setError("");
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      setError("Log in to attach screenshots — you can still continue without them.");
      return;
    }

    setUploading(true);
    const uploaded = [];
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        setError(`${file.name} isn't a supported image type (PNG, JPEG, or WebP).`);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError(`${file.name} is over the 5MB limit.`);
        continue;
      }
      const path = `${userData.user.id}/${form.listingId}/${crypto.randomUUID()}-${file.name}`;
      const { error: uploadError } = await supabase.storage.from("listing-screenshots").upload(path, file);
      if (uploadError) {
        setError(uploadError.message);
        continue;
      }
      const { data: publicUrlData } = supabase.storage.from("listing-screenshots").getPublicUrl(path);
      uploaded.push({ path, url: publicUrlData.publicUrl, name: file.name });
    }

    if (uploaded.length) {
      setForm((f) => ({ ...f, screenshots: [...f.screenshots, ...uploaded] }));
    }
    setUploading(false);
  };

  const handleRemove = async (path) => {
    const supabase = createClient();
    setForm((f) => ({ ...f, screenshots: f.screenshots.filter((s) => s.path !== path) }));
    await supabase.storage.from("listing-screenshots").remove([path]);
  };

  return (
    <div>
      <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        Output screenshots (optional, up to {MAX_SHOTS})
      </label>

      {form.screenshots.length > 0 && (
        <div className="grid grid-cols-4 gap-2 mb-2">
          {form.screenshots.map((s) => (
            <div key={s.path} className="relative rounded overflow-hidden" style={{ border: "1px solid #D8D5C9", aspectRatio: "1" }}>
              <img src={s.url} alt={s.name} className="w-full h-full object-cover" />
              <button
                onClick={() => handleRemove(s.path)}
                className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs"
                style={{ background: "rgba(20,33,61,0.75)", color: "#FFFFFF" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {form.screenshots.length < MAX_SHOTS && (
        <div
          className="rounded-md p-4 flex items-center justify-center gap-2 cursor-pointer text-center"
          style={{ border: "1.5px dashed #D8D5C9", background: "#F7F7F4" }}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <ImageIcon size={16} color="#6B6F76" />
          <p className="text-xs" style={{ color: "#6B6F76" }}>
            {uploading ? "Uploading…" : "Drop screenshots, or browse — appear in the gallery buyers swipe through"}
          </p>
        </div>
      )}

      {error && <p className="text-xs mt-1.5" style={{ color: "#B33A2E" }}>{error}</p>}
    </div>
  );
}

function UploadSubStep({ form, setForm, onContinue }) {
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const fileInputRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;

    // Checked before ever reading the file: a wrong-format upload gets its
    // own distinct message rather than being funneled into "no messages
    // found" further down.
    if (!/\.(json|txt)$/i.test(file.name)) {
      setParseError("This file isn't in a supported format. Upload a .json export or a .txt transcript.");
      setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null }));
      return;
    }

    setParsing(true);
    setParseError("");
    try {
      const text = await file.text();
      const result = parseThreadExport(text, file.name);
      if (!result) {
        // No manual-entry escape hatch here on purpose: a failed parse
        // means there's no real thread content to sell, so it shouldn't be
        // possible to type in a fake model/count and continue anyway.
        setParseError("Couldn't find any messages in that file. Double-check it's a real export or transcript, then try again.");
        setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null }));
      } else {
        setForm((f) => ({
          ...f,
          fileAttached: true,
          fileName: file.name,
          model: result.model || f.model,
          messages: String(result.messageCount),
          parsedMessages: result.messages,
        }));
      }
    } catch {
      setParseError("Couldn't read that file — try a .json export or a .txt transcript.");
      setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null }));
    }
    setParsing(false);
  };

  // Continue now requires a real successful parse (parsedMessages present),
  // not just a model + a typed-in count — matches "don't let a bad or
  // unparseable file continue" exactly.
  const canContinue = form.parsedMessages && form.parsedMessages.length > 0 && form.model;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 space-y-5">
        <div
          className="rounded-md p-8 flex flex-col items-center justify-center text-center gap-2 cursor-pointer"
          style={{ border: "1.5px dashed #D8D5C9", background: "#F7F7F4" }}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.txt"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <Upload size={22} color="#6B6F76" />
          <p className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            {parsing ? (
              <span style={{ color: "#6B6F76" }}>Reading file…</span>
            ) : form.fileAttached ? (
              <span style={{ color: "#2F6F62", fontWeight: 500 }}>{form.fileName} attached</span>
            ) : (
              <>Drop your .json export from Claude, ChatGPT, or Gemini, or <span style={{ color: "#14213D", fontWeight: 500 }}>browse</span></>
            )}
          </p>
          <p className="text-xs" style={{ color: "#6B6F76" }}>We auto-detect the source model and message count · .json or .txt only · max 20MB</p>
        </div>

        {parseError && (
          <div className="flex items-start gap-2 p-3 rounded-md" style={{ background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
            <AlertCircle size={14} color="#B33A2E" className="mt-0.5 shrink-0" />
            <p className="text-xs" style={{ color: "#B33A2E" }}>{parseError}</p>
          </div>
        )}

        {form.fileAttached && !parseError && (
          <div className="flex items-center gap-2 text-xs" style={{ color: "#2F6F62" }}>
            <CheckCircle2 size={13} /> Detected {form.model || "an unknown model"} · {form.messages} messages
          </div>
        )}

        <ScreenshotUploader form={form} setForm={setForm} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Source model</label>
            <select
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              disabled={!form.fileAttached}
              className="w-full px-3 py-2.5 rounded text-sm outline-none disabled:opacity-50"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
            >
              <option value="">Select model</option>
              {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            {form.fileAttached && <p className="text-[11px] mt-1" style={{ color: "#6B6F76" }}>Auto-detected — correct it here if it's wrong</p>}
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Message count</label>
            <input
              type="number"
              value={form.messages}
              readOnly
              disabled
              className="w-full px-3 py-2.5 rounded text-sm outline-none opacity-50"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#F7F7F4" }}
            />
            <p className="text-[11px] mt-1" style={{ color: "#6B6F76" }}>Counted from the file — not editable</p>
          </div>
        </div>

        <button
          onClick={onContinue}
          disabled={!canContinue}
          className="w-full py-3 rounded text-sm flex items-center justify-center gap-2"
          style={{ background: canContinue ? "#14213D" : "#D8D5C9", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
        >
          Continue <ArrowRight size={15} />
        </button>
      </div>

      <BuyerPreviewCard form={form} />
    </div>
  );
}

// Step 2 of 3 — details.
function DetailsSubStep({ form, setForm, onContinue, onBack }) {
  const canContinue = form.title.trim() && (form.category !== "Other" ? form.category : form.categoryOther.trim());

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 space-y-5">
        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Title</label>
          <input
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="e.g. Next.js SaaS billing flow with Stripe"
            className="w-full px-3 py-2.5 rounded text-sm outline-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Description — what's done, what's left</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="e.g. Billing UI and webhook handling are done. Still needs the trial-cancellation flow."
            rows={3}
            className="w-full px-3 py-2.5 rounded text-sm outline-none resize-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>How far did you get?</label>
            <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{form.completion}%</span>
          </div>
          <input
            type="range"
            min="5"
            max="100"
            step="5"
            value={form.completion}
            onChange={(e) => setForm({ ...form, completion: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: "#E2A83E" }}
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Category</label>
          <div className="flex flex-wrap gap-2">
            {[...CATEGORIES, "Other"].map((c) => {
              const active = form.category === c;
              return (
                <button
                  key={c}
                  onClick={() => setForm({ ...form, category: c })}
                  className="px-3 py-1.5 rounded-full text-xs"
                  style={{
                    background: active ? "#14213D" : "#FFFFFF",
                    color: active ? "#FFFFFF" : "#14213D",
                    border: active ? "none" : "1px solid #D8D5C9",
                    fontFamily: "'IBM Plex Sans', sans-serif",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
          {form.category === "Other" && (
            <input
              value={form.categoryOther}
              onChange={(e) => setForm({ ...form, categoryOther: e.target.value })}
              placeholder="Type your category…"
              className="w-full mt-2 px-3 py-2.5 rounded text-sm outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
            />
          )}
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="px-5 py-3 rounded text-sm"
            style={{ border: "1px solid #D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
          >
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!canContinue}
            className="flex-1 py-3 rounded text-sm flex items-center justify-center gap-2"
            style={{ background: canContinue ? "#14213D" : "#D8D5C9", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            Continue <ArrowRight size={15} />
          </button>
        </div>
      </div>

      <BuyerPreviewCard form={form} />
    </div>
  );
}

// Step 3 of 3 — price & submit.
function PriceSubStep({ form, setForm, onSubmit, onBack, submitting, submitError }) {
  const price = Number(form.price) || 0;
  const youReceive = price * (1 - PLATFORM_FEE_PCT);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <div className="lg:col-span-2 space-y-5">
        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Your price</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: "#6B6F76" }}>₹</span>
            <input
              type="number"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="499"
              className="w-full pl-7 pr-3 py-2.5 rounded text-sm outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
            />
          </div>
        </div>

        <div className="rounded-md p-4 flex items-center justify-between" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <span className="text-sm" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            You receive (after {Math.round(PLATFORM_FEE_PCT * 100)}% platform fee)
          </span>
          <span className="text-xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            ₹{price ? Math.round(youReceive) : "—"}
          </span>
        </div>

        <p className="text-xs" style={{ color: "#6B6F76" }}>
          Submitted listings enter automated screening before going live — see the next step.
        </p>

        {submitError && <p className="text-xs" style={{ color: "#B33A2E" }}>{submitError}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            disabled={submitting}
            className="px-5 py-3 rounded text-sm"
            style={{ border: "1px solid #D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
          >
            Back
          </button>
          <button
            onClick={onSubmit}
            disabled={!price || submitting}
            className="flex-1 py-3 rounded text-sm flex items-center justify-center gap-2"
            style={{ background: (!price || submitting) ? "#D8D5C9" : "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            {submitting ? "Submitting…" : "Submit for screening"} <ArrowRight size={15} />
          </button>
        </div>
      </div>

      <BuyerPreviewCard form={form} />
    </div>
  );
}

function ReviewStep({ onDone, findings }) {
  const [checkedCount, setCheckedCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);
  const hasFindings = findings && findings.length > 0;
  const totalRedacted = hasFindings ? findings.reduce((sum, f) => sum + f.count, 0) : 0;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setCheckedCount(i);
      if (i >= SCAN_CHECKS.length) {
        clearInterval(interval);
        setTimeout(() => setFinished(true), 500);
      }
    }, 900);
    return () => clearInterval(interval);
  }, []);

  const progress = Math.min((checkedCount / SCAN_CHECKS.length) * 100, 100);

  return (
    <div className="max-w-lg mx-auto text-center py-8">
      <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: finished ? "#EAF2EF" : "#FBF1DD" }}>
        {finished ? <ShieldCheck size={24} color="#2F6F62" /> : <Loader2 size={22} color="#8A6A18" className="animate-spin" />}
      </div>
      <h2 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        {finished ? "Submitted for review" : "Screening your thread"}
      </h2>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        {finished
          ? hasFindings
            ? `We auto-redacted ${totalRedacted} personal detail${totalRedacted === 1 ? "" : "s"} before saving your listing. It's now awaiting a quick human check before it goes live.`
            : "No personal details or credentials matched our scan. Your listing is now awaiting a quick human check before it goes live."
          : "We check every thread for personal details and credentials before it goes live."}
      </p>
      <div className="w-full h-1.5 rounded-full mb-6" style={{ background: "#D8D5C9" }}>
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progress}%`, background: finished ? "#2F6F62" : "#E2A83E" }} />
      </div>
      <div className="text-left space-y-2.5 mb-8">
        {SCAN_CHECKS.map((check, i) => {
          const done = i < checkedCount;
          return (
            <div key={check} className="flex items-center gap-2.5 text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: done ? "#14213D" : "#6B6F76" }}>
              {done ? <CheckCircle2 size={16} color="#2F6F62" /> : <div className="w-4 h-4 rounded-full shrink-0" style={{ border: "1.5px solid #D8D5C9" }} />}
              {check}
            </div>
          );
        })}
      </div>
      {finished && hasFindings && (
        <div className="text-left rounded-md p-4 mb-6" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
          <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#8A6A18" }}>
            What we redacted
          </p>
          {findings.map((f) => (
            <p key={f.type} className="text-sm" style={{ color: "#14213D" }}>
              {f.count}× {f.type}{f.count === 1 ? "" : "s"}
            </p>
          ))}
        </div>
      )}
      {finished && (
        <button
          onClick={onDone}
          className="px-6 py-3 rounded text-sm inline-flex items-center gap-2"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
        >
          Go to dashboard <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

function DashboardStep({ refreshKey }) {
  const [loading, setLoading] = useState(true);
  const [listings, setListings] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError("");
      const supabase = createClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        if (!cancelled) setLoading(false);
        return;
      }

      const { data: myListings, error: listingsError } = await supabase
        .from("listings")
        .select("id, title, price, status")
        .eq("seller_id", userData.user.id)
        .order("created_at", { ascending: false });

      if (listingsError) {
        if (!cancelled) {
          setError(listingsError.message);
          setLoading(false);
        }
        return;
      }

      const ids = (myListings || []).map((l) => l.id);
      let salesByListing = {};
      if (ids.length > 0) {
        const { data: purchases } = await supabase
          .from("purchases")
          .select("listing_id, amount")
          .eq("status", "paid")
          .in("listing_id", ids);

        (purchases || []).forEach((p) => {
          if (!salesByListing[p.listing_id]) salesByListing[p.listing_id] = { count: 0, revenue: 0 };
          salesByListing[p.listing_id].count += 1;
          salesByListing[p.listing_id].revenue += Number(p.amount);
        });
      }

      const withSales = (myListings || []).map((l) => ({
        ...l,
        price: Number(l.price),
        sales: salesByListing[l.id]?.count || 0,
        revenue: salesByListing[l.id]?.revenue || 0,
      }));

      if (!cancelled) {
        setListings(withSales);
        setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const totalGross = listings.reduce((sum, l) => sum + l.revenue, 0);
  const totalNet = totalGross * (1 - PLATFORM_FEE_PCT);
  const liveCount = listings.filter((l) => l.status === "live").length;

  if (loading) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>Loading your dashboard...</p>;
  }

  return (
    <div>
      {error && <p className="text-xs mb-4" style={{ color: "#B33A2E" }}>Couldn't load listings: {error}</p>}

      <div className="rounded-md p-3 mb-6 flex items-center justify-between" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
        <p className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Payout setup isn't complete — earnings can't be paid out yet.
        </p>
        <Link href="/sell/payout" className="text-xs font-medium" style={{ color: "#14213D" }}>Set up payouts →</Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Link href="/sell/earnings" className="rounded-md p-4 block transition-transform hover:-translate-y-0.5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-1" style={{ color: "#6B6F76" }}>
            <TrendingUp size={14} /> <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Earnings</span>
          </div>
          <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>₹{Math.round(totalNet).toLocaleString("en-IN")}</p>
          <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>after platform fee · view details →</p>
        </Link>
        <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-1" style={{ color: "#6B6F76" }}>
            <BarChart3 size={14} /> <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Live listings</span>
          </div>
          <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{liveCount}</p>
          <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>visible to buyers</p>
        </div>
        <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-1" style={{ color: "#6B6F76" }}>
            <Clock size={14} /> <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Total listings</span>
          </div>
          <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{listings.length}</p>
          <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>across every status</p>
        </div>
      </div>

      <p className="text-xs uppercase tracking-wide mb-3" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Your listings</p>
      {listings.length === 0 ? (
        <p className="text-sm text-center py-10 rounded-md" style={{ color: "#6B6F76", border: "1px solid #D8D5C9" }}>
          You haven't listed anything yet.
        </p>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
          {listings.map((l, i) => (
            <div key={l.id} className="flex items-center justify-between px-4 py-3.5 gap-4" style={{ background: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
              <div className="flex items-center gap-3 min-w-0">
                <MessageSquare size={15} color="#6B6F76" className="shrink-0" />
                <span className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{l.title}</span>
              </div>
              <div className="flex items-center gap-5 shrink-0">
                {l.status === "flagged" && (
                  <span className="flex items-center gap-1 text-xs" style={{ color: "#B33A2E" }}>
                    <AlertCircle size={13} /> needs edits
                  </span>
                )}
                <span className="text-xs hidden sm:inline" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>{l.sales} sold</span>
                <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>₹{l.price}</span>
                <StatusPill status={l.status} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SellPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [wizardStep, setWizardStep] = useState(1);
  const [form, setForm] = useState({
    listingId: "",
    title: "",
    category: "",
    categoryOther: "",
    model: "",
    description: "",
    messages: "",
    price: "",
    completion: 80,
    fileAttached: false,
    fileName: "",
    parsedMessages: null,
    screenshots: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0);
  const [hasExistingListings, setHasExistingListings] = useState(false);
  const [screeningFindings, setScreeningFindings] = useState([]);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    // Generated up front (not at final submit) so screenshots can be
    // uploaded to storage — scoped under this listing's own id — during
    // step 1, before the listing row itself exists. Passed through as the
    // explicit id on the final insert in step 3 so the two line up.
    setForm((f) => (f.listingId ? f : { ...f, listingId: crypto.randomUUID() }));
  }, []);

  useEffect(() => {
    // Gates the whole wizard on being logged in -- clicking "Sell" with no
    // session should land straight on /login, not let someone browse the
    // upload UI first and only find out at the final submit step.
    const checkAuth = async () => {
      const supabase = createClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        router.push("/login?next=/sell");
        return;
      }
      setCheckingAuth(false);

      const { count } = await supabase
        .from("listings")
        .select("id", { count: "exact", head: true })
        .eq("seller_id", userData.user.id);
      setHasExistingListings((count || 0) > 0);
    };
    checkAuth();
  }, [router]);

  const handleFinalSubmit = async () => {
    setSubmitError("");
    setSubmitting(true);
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();

    if (!userData.user) {
      setSubmitting(false);
      router.push("/login?next=/sell");
      return;
    }

    const sellerName = userData.user.user_metadata?.display_name || userData.user.email;
    const category = form.category === "Other" ? form.categoryOther.trim() : form.category;

    // Real redaction, not a simulation -- strips emails, phone numbers, card
    // numbers, and common API-key/token shapes from everything the buyer
    // would eventually see, before any of it reaches the database. Nothing
    // unredacted is ever written.
    const redacted = redactListing({
      title: form.title,
      description: form.description || "",
      messages: form.parsedMessages || [],
    });
    setScreeningFindings(redacted.findings);

    const { error: insertError } = await supabase.from("listings").insert({
      id: form.listingId,
      title: redacted.title,
      category,
      model: form.model,
      description: redacted.description,
      messages: Number(form.messages) || 0,
      completion: form.completion,
      price: Number(form.price),
      seller_id: userData.user.id,
      seller_name: sellerName,
      preview: redacted.messages.slice(0, 2),
      thread: redacted.messages,
      screenshots: form.screenshots.map((s) => s.url),
      screening_findings: redacted.findings,
      // Anything the scanner actually caught gets routed into the same
      // "flagged" bucket the admin queue already shows alongside
      // pending_review listings -- so a real finding is consequential, not
      // just informational text.
      status: redacted.findings.length > 0 ? "flagged" : "pending_review",
    });

    setSubmitting(false);

    if (insertError) {
      setSubmitError(insertError.message);
      return;
    }

    setStep(2);
  };

  const handleReviewDone = () => {
    setDashboardRefreshKey((k) => k + 1);
    setStep(3);
  };

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

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-4xl mx-auto">
        {step === 1 && hasExistingListings && (
          <button
            onClick={() => setStep(3)}
            className="text-sm mb-4 inline-block"
            style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
          >
            Already listing threads? <span style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>View your dashboard →</span>
          </button>
        )}
        <Stepper step={step} />
        {step === 1 && (
          <>
            <MiniStepper step={wizardStep} />
            {wizardStep === 1 && (
              <UploadSubStep form={form} setForm={setForm} onContinue={() => setWizardStep(2)} />
            )}
            {wizardStep === 2 && (
              <DetailsSubStep form={form} setForm={setForm} onContinue={() => setWizardStep(3)} onBack={() => setWizardStep(1)} />
            )}
            {wizardStep === 3 && (
              <PriceSubStep
                form={form}
                setForm={setForm}
                onSubmit={handleFinalSubmit}
                onBack={() => setWizardStep(2)}
                submitting={submitting}
                submitError={submitError}
              />
            )}
          </>
        )}
        {step === 2 && <ReviewStep onDone={handleReviewDone} findings={screeningFindings} />}
        {step === 3 && <DashboardStep refreshKey={dashboardRefreshKey} />}
      </main>
    </div>
  );
}
