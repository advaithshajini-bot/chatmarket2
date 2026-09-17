"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import JSZip from "jszip";
import {
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
  FileArchive,
} from "lucide-react";
import TopNav from "@/components/TopNav";
import StatusPill from "@/components/StatusPill";
import ProductTypePicker from "@/components/ProductTypePicker";
import WorkflowAgentListingForm from "@/components/WorkflowAgentListingForm";
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

function CharCount({ value, max }) {
  const count = (value || "").length;
  const atLimit = count >= max;
  return (
    <div className="flex justify-end mt-1.5">
      <span
        className="text-[11px] px-2 py-0.5 rounded"
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          background: atLimit ? "#B33A2E" : "#14213D",
          color: "#F7F7F4",
        }}
      >
        {count} / {max}
      </span>
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
        <div className="flex items-center justify-end text-xs pt-3" style={{ borderTop: "1px dashed #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
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
    if (!/\.zip$/i.test(file.name)) {
      setParseError("This file isn't a zip. Upload a .zip containing your conversation export plus any generated outputs.");
      setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null, zipPath: "", otherFiles: [] }));
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setParseError("That zip is over the 50MB limit.");
      setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null, zipPath: "", otherFiles: [] }));
      return;
    }

    setParsing(true);
    setParseError("");
    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter((f) => !f.dir);

      if (entries.length === 0) {
        setParseError("That zip looks empty.");
        setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null, zipPath: "", otherFiles: [] }));
        setParsing(false);
        return;
      }

      // Try every .json/.txt entry (in the zip's own order) and use the
      // first one that actually parses into real conversation messages,
      // rather than just grabbing the first .json/.txt by name — a zip
      // can easily contain other .json/.txt files among the "outputs"
      // (config files, notes, etc.) that aren't the conversation itself.
      const candidates = entries.filter((f) => /\.(json|txt)$/i.test(f.name));
      let parsedResult = null;
      let convoEntry = null;
      for (const entry of candidates) {
        const text = await entry.async("text");
        const result = parseThreadExport(text, entry.name);
        if (result) {
          parsedResult = result;
          convoEntry = entry;
          break;
        }
      }

      if (!parsedResult) {
        setParseError("Couldn't find a conversation inside that zip. Make sure it includes a .json export or .txt transcript with real messages.");
        setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null, zipPath: "", otherFiles: [] }));
        setParsing(false);
        return;
      }

      const otherFiles = entries.filter((f) => f !== convoEntry).map((f) => f.name);

      // Uploaded now (not deferred to final submit), scoped under this
      // listing's own id — same pattern screenshots already use, so it's
      // sitting in storage ready to reference by the time the listing row
      // is actually inserted in step 3.
      const supabase = createClient();
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        setParseError("Your session expired — refresh the page and log back in.");
        setParsing(false);
        return;
      }
      const path = `${userData.user.id}/${form.listingId}/${file.name}`;
      const { error: uploadError } = await supabase.storage.from("listing-files").upload(path, file, { upsert: true });
      if (uploadError) {
        setParseError(`Couldn't upload the zip: ${uploadError.message}`);
        setParsing(false);
        return;
      }

      setForm((f) => ({
        ...f,
        fileAttached: true,
        fileName: file.name,
        model: parsedResult.model || f.model,
        messages: String(parsedResult.messageCount),
        parsedMessages: parsedResult.messages,
        zipPath: path,
        otherFiles,
      }));
    } catch {
      setParseError("Couldn't read that zip — make sure it's a valid .zip file, then try again.");
      setForm((f) => ({ ...f, fileAttached: false, fileName: "", model: "", messages: "", parsedMessages: null, zipPath: "", otherFiles: [] }));
    }
    setParsing(false);
  };

  // Continue now requires a real successful parse (parsedMessages present)
  // AND a successfully uploaded zip, not just a model + a typed-in count —
  // matches "don't let a bad or unparseable file continue" exactly.
  const canContinue =
    form.parsedMessages && form.parsedMessages.length > 0 && form.zipPath && form.model &&
    (form.model !== "Other" || form.modelOther.trim());

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
            accept=".zip"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          <FileArchive size={22} color="#6B6F76" />
          <p className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}>
            {parsing ? (
              <span style={{ color: "#6B6F76" }}>Reading zip…</span>
            ) : form.fileAttached ? (
              <span style={{ color: "#2F6F62", fontWeight: 500 }}>{form.fileName} attached</span>
            ) : (
              <>Drop a .zip with your conversation export and any generated outputs, or <span style={{ color: "#14213D", fontWeight: 500 }}>browse</span></>
            )}
          </p>
          <p className="text-xs" style={{ color: "#6B6F76" }}>We auto-detect the source model and message count from the conversation file inside · .zip only · max 50MB</p>
        </div>
        <p className="text-[11px]" style={{ color: "#8A6A18" }}>
          Note: only the conversation itself is automatically scanned for personal info before going live — not other files in the zip. Don't bundle in anything you wouldn't want a stranger to see.
        </p>
        {form.otherFiles && form.otherFiles.length > 0 && (
          <p className="text-xs" style={{ color: "#6B6F76" }}>
            Also bundled: {form.otherFiles.join(", ")}
          </p>
        )}

        {parseError && (
          <div className="flex items-start gap-2 p-3 rounded-md" style={{ background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
            <AlertCircle size={14} color="#B33A2E" className="mt-0.5 shrink-0" />
            <p className="text-xs" style={{ color: "#B33A2E" }}>{parseError}</p>
          </div>
        )}

        {form.fileAttached && !parseError && (
          <div className="flex items-center gap-2 text-xs" style={{ color: "#2F6F62" }}>
            <CheckCircle2 size={13} /> Detected {form.model || "an unknown model"}
          </div>
        )}

        <ScreenshotUploader form={form} setForm={setForm} />

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
          {form.model === "Other" && (
            <input
              value={form.modelOther}
              onChange={(e) => setForm({ ...form, modelOther: e.target.value })}
              placeholder="Name the source model"
              className="w-full px-3 py-2.5 rounded text-sm outline-none mt-2"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
            />
          )}
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
            onChange={(e) => setForm({ ...form, title: e.target.value.slice(0, 200) })}
            maxLength={200}
            placeholder="e.g. Next.js SaaS billing flow with Stripe"
            className="w-full px-3 py-2.5 rounded text-sm outline-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
          />
          <CharCount value={form.title} max={200} />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Description — what it is and what it includes</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value.slice(0, 2000) })}
            maxLength={2000}
            placeholder="e.g. A billing UI with Stripe checkout and webhook handling, generated end-to-end."
            rows={3}
            className="w-full px-3 py-2.5 rounded text-sm outline-none resize-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
          />
          <CharCount value={form.description} max={2000} />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1.5 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>What is in the zip?</label>
          <textarea
            value={form.zipContents}
            onChange={(e) => setForm({ ...form, zipContents: e.target.value.slice(0, 500) })}
            maxLength={500}
            placeholder="e.g. conversation.json, App.jsx, styles.css, a screenshot of the final result"
            rows={2}
            className="w-full px-3 py-2.5 rounded text-sm outline-none resize-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", background: "#FFFFFF" }}
          />
          <CharCount value={form.zipContents} max={500} />
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

function KycGate({ status, note }) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-md mx-auto text-center">
        {status === "submitted" ? (
          <>
            <Clock size={28} color="#8A6A18" className="mx-auto mb-4" />
            <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Verification submitted
            </h1>
            <p className="text-sm" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
              Your identity verification is awaiting admin review. Once it's approved, you'll be able to list threads for sale.
            </p>
          </>
        ) : status === "needs_changes" || status === "rejected" ? (
          <>
            <AlertCircle size={28} color="#B33A2E" className="mx-auto mb-4" />
            <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {status === "rejected" ? "Verification rejected" : "Changes needed"}
            </h1>
            {note && (
              <p className="text-sm mb-4 text-left rounded-md p-3" style={{ color: "#8A342B", background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
                <span style={{ fontWeight: 500 }}>Admin note:</span> {note}
              </p>
            )}
            <p className="text-sm mb-6" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
              Review and resubmit your details to continue.
            </p>
            <Link
              href="/sell/payout"
              className="inline-flex items-center gap-2 px-6 py-3 rounded text-sm"
              style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              Review and resubmit <ArrowRight size={15} />
            </Link>
          </>
        ) : (
          <>
            <ShieldCheck size={28} color="#14213D" className="mx-auto mb-4" />
            <h1 className="text-2xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              Verify your identity to start selling
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
              Before you can list a thread, we need to verify who you are and where to pay you — a one-time step
              that an admin then reviews.
            </p>
            <Link
              href="/sell/payout"
              className="inline-flex items-center gap-2 px-6 py-3 rounded text-sm"
              style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              Start verification <ArrowRight size={15} />
            </Link>
          </>
        )}
      </main>
    </div>
  );
}

function AwaitingApprovalStep({ listings, onAddAnother }) {
  return (
    <div>
      <div className="rounded-md p-5 mb-6 text-center" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
        <Clock size={22} color="#8A6A18" className="mx-auto mb-2" />
        <p className="text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}>
          Your submission is awaiting admin review
        </p>
        <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>
          Your full seller dashboard — purchases, reviews, reported issues — unlocks once a listing goes live.
        </p>
      </div>

      <div className="flex items-center justify-between mb-3">
        <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Your listings</p>
        <button onClick={onAddAnother} className="text-xs font-medium" style={{ color: "#14213D" }}>+ List another thread</button>
      </div>
      <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
        {listings.map((l, i) => (
          <div key={l.id} className="px-4 py-3.5 flex items-center justify-between gap-4" style={{ background: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
            <div className="flex items-center gap-3 min-w-0">
              <MessageSquare size={15} color="#6B6F76" className="shrink-0" />
              <span className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{l.title}</span>
            </div>
            <StatusPill status={l.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardStep({ refreshKey, onAddAnother }) {
  const [loading, setLoading] = useState(true);
  const [listings, setListings] = useState([]);
  const [error, setError] = useState("");
  const [reviews, setReviews] = useState([]);
  const [disputes, setDisputes] = useState([]);

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
      const uid = userData.user.id;

      const { data: myListings, error: listingsError } = await supabase
        .from("listings")
        .select("id, title, price, status, removal_reason")
        .eq("seller_id", uid)
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

      // Review analysis and reported issues across every listing this
      // seller owns -- both already allowed by RLS (owns_listing() for
      // disputes; reviews on live listings are publicly readable, which
      // covers the seller's own).
      const { data: reviewRows } = await supabase
        .from("reviews")
        .select("id, rating, comment, created_at, listings!inner(id, title, seller_id)")
        .eq("listings.seller_id", uid)
        .order("created_at", { ascending: false });

      const { data: disputeRows } = await supabase
        .from("disputes")
        .select("id, reason, status, resolution_note, created_at, listings!inner(id, title, seller_id)")
        .eq("listings.seller_id", uid)
        .order("created_at", { ascending: false });

      if (!cancelled) {
        setListings(withSales);
        setReviews(reviewRows || []);
        setDisputes(disputeRows || []);
        setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  const totalGross = listings.reduce((sum, l) => sum + l.revenue, 0);
  const totalNet = totalGross * (1 - PLATFORM_FEE_PCT);
  const liveCount = listings.filter((l) => l.status === "live").length;
  const totalSales = listings.reduce((sum, l) => sum + l.sales, 0);
  const avgRating = reviews.length > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null;
  const openDisputes = disputes.filter((d) => d.status === "open").length;

  if (loading) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>Loading your dashboard...</p>;
  }

  return (
    <div>
      {error && <p className="text-xs mb-4" style={{ color: "#B33A2E" }}>Couldn't load listings: {error}</p>}

      <div className="rounded-md p-3 mb-6 flex items-center gap-2" style={{ background: "#EAF2EF", border: "1px solid #CFE3DC" }}>
        <CheckCircle2 size={14} color="#2F6F62" />
        <p className="text-xs" style={{ color: "#2F6F62", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Payout setup completed
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
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
        <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
          <div className="flex items-center gap-2 mb-1" style={{ color: "#6B6F76" }}>
            <Star size={14} /> <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>Purchases</span>
          </div>
          <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{totalSales}</p>
          <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>threads sold, all time</p>
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <p className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Your listings</p>
        <button onClick={onAddAnother} className="text-xs font-medium" style={{ color: "#14213D" }}>+ List another thread</button>
      </div>
      {listings.length === 0 ? (
        <p className="text-sm text-center py-10 rounded-md" style={{ color: "#6B6F76", border: "1px solid #D8D5C9" }}>
          You haven't listed anything yet.
        </p>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
          {listings.map((l, i) => (
            <div key={l.id} className="px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
              <div className="flex items-center justify-between gap-4">
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
              {l.status === "removed" && l.removal_reason && (
                <p className="text-xs mt-2 pl-7" style={{ color: "#B33A2E" }}>
                  <span style={{ fontWeight: 500 }}>Removed by admin:</span> {l.removal_reason}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs uppercase tracking-wide mb-3 mt-8" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Review analysis</p>
      <div className="rounded-md p-4 mb-8" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
        {reviews.length === 0 ? (
          <p className="text-sm" style={{ color: "#6B6F76" }}>No reviews yet.</p>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-4">
              <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{avgRating.toFixed(1)}</p>
              <div>
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Star key={n} size={14} fill={n <= Math.round(avgRating) ? "#E2A83E" : "none"} color={n <= Math.round(avgRating) ? "#E2A83E" : "#D8D5C9"} />
                  ))}
                </div>
                <p className="text-xs" style={{ color: "#6B6F76" }}>{reviews.length} review{reviews.length === 1 ? "" : "s"}</p>
              </div>
            </div>
            <div className="space-y-3">
              {reviews.slice(0, 5).map((r) => (
                <div key={r.id} className="pt-3" style={{ borderTop: "1px solid #E4E2D8" }}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star key={n} size={11} fill={n <= r.rating ? "#E2A83E" : "none"} color={n <= r.rating ? "#E2A83E" : "#D8D5C9"} />
                      ))}
                    </div>
                    <span className="text-xs truncate max-w-[50%]" style={{ color: "#6B6F76" }}>{r.listings?.title}</span>
                  </div>
                  {r.comment && <p className="text-xs" style={{ color: "#3A3D42" }}>{r.comment}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="text-xs uppercase tracking-wide mb-3" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        Reported issues {openDisputes > 0 && `— ${openDisputes} open`}
      </p>
      {disputes.length === 0 ? (
        <p className="text-sm text-center py-8 rounded-md" style={{ color: "#6B6F76", border: "1px solid #D8D5C9" }}>
          No issues reported on your listings.
        </p>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
          {disputes.map((d, i) => (
            <div key={d.id} className="px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, color: "#14213D" }}>{d.listings?.title}</span>
                <span
                  className="text-[11px] px-2 py-0.5 rounded-full uppercase tracking-wide shrink-0"
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    background: d.status === "open" ? "#FBF1DD" : d.status === "resolved_refunded" ? "#EAF2EF" : "#E8E7E2",
                    color: d.status === "open" ? "#8A6A18" : d.status === "resolved_refunded" ? "#2F6F62" : "#6B6F76",
                  }}
                >
                  {d.status === "open" ? "Open" : d.status === "resolved_refunded" ? "Refunded" : "Denied"}
                </span>
              </div>
              <p className="text-xs" style={{ color: "#6B6F76" }}>{d.reason}</p>
              {d.resolution_note && (
                <p className="text-xs mt-1" style={{ color: "#8A6A18" }}>
                  <span style={{ fontWeight: 500 }}>Resolution:</span> {d.resolution_note}
                </p>
              )}
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
  const [productType, setProductType] = useState(null);
  const [form, setForm] = useState({
    listingId: "",
    title: "",
    category: "",
    categoryOther: "",
    model: "",
    modelOther: "",
    description: "",
    zipContents: "",
    messages: "",
    price: "",
    completion: 100,
    fileAttached: false,
    fileName: "",
    parsedMessages: null,
    zipPath: "",
    otherFiles: [],
    screenshots: [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0);
  const [hasExistingListings, setHasExistingListings] = useState(false);
  const [hasLiveListing, setHasLiveListing] = useState(false);
  const [screeningFindings, setScreeningFindings] = useState([]);
  const [statusListings, setStatusListings] = useState([]);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [kycStatus, setKycStatus] = useState(null);
  const [kycNote, setKycNote] = useState(null);

  useEffect(() => {
    // Generated up front (not at final submit) so screenshots can be
    // uploaded to storage — scoped under this listing's own id — during
    // step 1, before the listing row itself exists. Passed through as the
    // explicit id on the final insert in step 3 so the two line up.
    setForm((f) => (f.listingId ? f : { ...f, listingId: crypto.randomUUID() }));
  }, []);

  const refreshSellerState = async (supabase, userId) => {
    const { data: kyc } = await supabase
      .from("seller_kyc")
      .select("status, admin_note")
      .eq("user_id", userId)
      .maybeSingle();
    setKycStatus(kyc?.status || null);
    setKycNote(kyc?.admin_note || null);

    const { data: myListings } = await supabase
      .from("listings")
      .select("id, title, status")
      .eq("seller_id", userId)
      .order("created_at", { ascending: false });

    const listings = myListings || [];
    setHasExistingListings(listings.length > 0);
    setHasLiveListing(listings.some((l) => l.status === "live"));
    setStatusListings(listings);
    return listings;
  };

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
      const listings = await refreshSellerState(supabase, userData.user.id);
      // Land existing sellers on their dashboard/status view by default;
      // only force the upload wizard for someone with nothing listed yet.
      if (listings.length > 0) setStep(3);
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
    const model = form.model === "Other" ? form.modelOther.trim() : form.model;

    // Real redaction, not a simulation -- strips emails, phone numbers, card
    // numbers, and common API-key/token shapes from everything the buyer
    // would eventually see, before any of it reaches the database. Nothing
    // unredacted is ever written.
    const redacted = redactListing({
      title: form.title,
      description: form.description || "",
      zipContents: form.zipContents || "",
      messages: form.parsedMessages || [],
    });
    setScreeningFindings(redacted.findings);

    const { error: insertError } = await supabase.from("listings").insert({
      id: form.listingId,
      title: redacted.title,
      category,
      model,
      description: redacted.description,
      zip_contents: redacted.zipContents,
      messages: Number(form.messages) || 0,
      completion: 100,
      price: Number(form.price),
      seller_id: userData.user.id,
      seller_name: sellerName,
      preview: redacted.messages.slice(0, 2),
      thread: redacted.messages,
      screenshots: form.screenshots.map((s) => s.url),
      output_zip_path: form.zipPath,
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

  const handleReviewDone = async () => {
    setDashboardRefreshKey((k) => k + 1);
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    if (userData.user) await refreshSellerState(supabase, userData.user.id);
    setStep(3);
  };

  // Workflow/Agent listings skip ReviewStep entirely (that step is a PII
  // scan over conversation content, which doesn't apply here -- there's no
  // conversation) and go straight to the same pending_review lifecycle
  // every listing already goes through, shown via the existing dashboard/
  // awaiting-approval views.
  const handleWorkflowAgentSubmitted = async () => {
    setDashboardRefreshKey((k) => k + 1);
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    if (userData.user) await refreshSellerState(supabase, userData.user.id);
    setStep(3);
  };

  const startNewListing = () => {
    // Without this, "List another thread" would reopen the wizard still
    // holding the previous listing's title/description/price/screenshots
    // -- and, critically, the same listingId, which would collide with the
    // row already inserted for it.
    setForm({
      listingId: crypto.randomUUID(),
      title: "",
      category: "",
      categoryOther: "",
      model: "",
      modelOther: "",
      description: "",
      zipContents: "",
      messages: "",
      price: "",
      completion: 100,
      fileAttached: false,
      fileName: "",
      parsedMessages: null,
      zipPath: "",
      otherFiles: [],
      screenshots: [],
    });
    setSubmitError("");
    setWizardStep(1);
    setProductType(null);
    setStep(1);
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

  // Selling is gated on identity verification being admin-approved first --
  // no access to the upload wizard or the dashboard until then.
  if (kycStatus !== "approved") {
    return <KycGate status={kycStatus} note={kycNote} />;
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
        {step === 1 && !productType && (
          <ProductTypePicker onSelect={setProductType} />
        )}
        {step === 1 && productType === "playbook" && (
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
        {step === 1 && (productType === "workflow" || productType === "agent") && (
          <WorkflowAgentListingForm
            type={productType}
            onBack={() => setProductType(null)}
            onSubmitted={handleWorkflowAgentSubmitted}
          />
        )}
        {step === 2 && <ReviewStep onDone={handleReviewDone} findings={screeningFindings} />}
        {step === 3 && (
          hasLiveListing ? (
            <DashboardStep refreshKey={dashboardRefreshKey} onAddAnother={startNewListing} />
          ) : (
            <AwaitingApprovalStep listings={statusListings} onAddAnother={startNewListing} />
          )
        )}
      </main>
    </div>
  );
}
