"use client";

import { useState } from "react";
import { CheckCircle2, XCircle, PenLine, ChevronDown, ChevronUp, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const STATUS_LABEL = {
  submitted: { label: "Awaiting review", bg: "#FBF1DD", color: "#8A6A18" },
  approved: { label: "Approved", bg: "#EAF2EF", color: "#2F6F62" },
  rejected: { label: "Rejected", bg: "#FBEAE8", color: "#B33A2E" },
  needs_changes: { label: "Needs changes", bg: "#FBEAE8", color: "#B33A2E" },
};

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function fullName(k) {
  return [k.first_name, k.middle_name, k.last_name].filter(Boolean).join(" ") || "—";
}

function fatherName(k) {
  return [k.father_first_name, k.father_middle_name, k.father_last_name].filter(Boolean).join(" ") || "—";
}

function formatAddress(addr) {
  if (!addr) return "—";
  const line = [addr.address_line1, addr.address_line2, addr.area, addr.city, addr.district, addr.state]
    .filter(Boolean)
    .join(", ");
  return line ? `${line}${addr.pincode ? " - " + addr.pincode : ""}${addr.country ? ", " + addr.country : ""}` : "—";
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        {label}
      </p>
      <p className="text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}>
        {value || "—"}
      </p>
    </div>
  );
}

function KycRow({ record, onDecision, busy }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState(null); // "reject" | "needs_changes" | null
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const status = STATUS_LABEL[record.status] || STATUS_LABEL.submitted;

  const handleApprove = () => onDecision(record.id, "approved", null, () => {});

  const handleSubmitNote = (targetStatus) => {
    if (!note.trim()) {
      setError("Add a note explaining what needs to change.");
      return;
    }
    onDecision(record.id, targetStatus, note.trim(), () => {
      setAction(null);
      setNote("");
      setError("");
    });
  };

  return (
    <div className="rounded-md" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between gap-3 p-3 text-left">
        <div className="min-w-0">
          <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
            {record.sellerName} — {fullName(record)}
          </p>
          <p className="text-xs" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Mono', monospace" }}>
            PAN {record.pan_number || "—"} · submitted {formatDate(record.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide" style={{ background: status.bg, color: status.color, fontFamily: "'IBM Plex Mono', monospace" }}>
            {status.label}
          </span>
          {open ? <ChevronUp size={14} color="#6B6F76" /> : <ChevronDown size={14} color="#6B6F76" />}
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3 mb-4" style={{ borderTop: "1px solid #E4E2D8" }}>
            <Field label="Full name" value={fullName(record)} />
            <Field label="Father's name" value={fatherName(record)} />
            <Field label="Date of birth" value={formatDate(record.date_of_birth)} />
            <Field label="Nationality" value={record.nationality} />
            <Field label="Citizen of India" value={record.citizen_of_india ? "Yes" : "No"} />
            <Field label="Resident in India" value={record.resident_in_india ? "Yes" : "No"} />
            <Field label="Occupation" value={record.occupation_type === "other" ? record.education_qualification_other : record.occupation_type} />
            <Field label="Education" value={record.education_qualification === "other" ? record.education_qualification_other : record.education_qualification} />
            <Field label="PAN number" value={record.pan_number} />
            <Field
              label="PAN document"
              value={record.panAttachmentUrl ? (
                <a href={record.panAttachmentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
                  <FileText size={13} /> View
                </a>
              ) : "Not uploaded"}
            />
            <Field label="Aadhaar" value={record.has_aadhaar ? `•••• •••• ${record.aadhaar_last4 || "----"}` : "Not provided"} />
            <Field
              label="Aadhaar document"
              value={record.aadhaarAttachmentUrl ? (
                <a href={record.aadhaarAttachmentUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1" style={{ color: "#14213D", fontWeight: 500, textDecoration: "underline" }}>
                  <FileText size={13} /> View
                </a>
              ) : "Not uploaded"}
            />
            <Field label="Mobile" value={record.mobile_number ? `${record.mobile_country_code || ""} ${record.mobile_number} ${record.mobile_verified ? "(verified)" : "(unverified)"}` : "—"} />
            <Field label="Email" value={record.email ? `${record.email} ${record.email_verified ? "(verified)" : "(unverified)"}` : "—"} />
            <div className="col-span-2">
              <Field label="Permanent address" value={formatAddress(record.permanent_address)} />
            </div>
            <div className="col-span-2">
              <Field label="Present address" value={record.present_same_as_permanent ? "Same as permanent" : formatAddress(record.present_address)} />
            </div>
          </div>

          <div className="rounded-md p-2.5 mb-3" style={{ background: "#FBEAE8", border: "1px solid #F0C4BE" }}>
            <p className="text-[11px]" style={{ color: "#8A342B", fontFamily: "'IBM Plex Sans', sans-serif" }}>
              Bank account details aren't collected or stored anywhere in the app yet, so there's nothing to review
              here for that — only the identity information above.
            </p>
          </div>

          {record.admin_note && (
            <div className="rounded-md p-2.5 mb-3" style={{ background: "#FFFFFF", border: "1px solid #E4E2D8" }}>
              <p className="text-[10px] uppercase tracking-wide mb-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                Note to seller
              </p>
              <p className="text-xs" style={{ color: "#3A3D42" }}>{record.admin_note}</p>
            </div>
          )}

          {action ? (
            <div className="rounded-md p-2.5" style={{ background: "#FFFFFF", border: "1px solid #E4E2D8" }}>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={action === "needs_changes" ? "What does the seller need to fix or clarify?" : "Why is this being rejected?"}
                rows={3}
                className="w-full text-xs p-2 rounded outline-none resize-none mb-2"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
              />
              {error && <p className="text-xs mb-2" style={{ color: "#B33A2E" }}>{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleSubmitNote(action)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs"
                  style={{ background: "#14213D", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
                >
                  {busy ? "Submitting..." : action === "needs_changes" ? "Send back for changes" : "Confirm rejection"}
                </button>
                <button onClick={() => { setAction(null); setError(""); }} disabled={busy} className="px-3 py-1.5 rounded text-xs" style={{ color: "#6B6F76" }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            record.status !== "approved" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleApprove}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                  style={{ background: "#2F6F62", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
                >
                  <CheckCircle2 size={12} /> Approve
                </button>
                <button
                  onClick={() => setAction("needs_changes")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                  style={{ border: "1px solid #D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
                >
                  <PenLine size={12} /> Modify
                </button>
                <button
                  onClick={() => setAction("rejected")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                  style={{ border: "1px solid #F0C4BE", color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif" }}
                >
                  <XCircle size={12} /> Reject
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminKycReviewClient({ initialRecords }) {
  const [records, setRecords] = useState(initialRecords);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2500);
  };

  const handleDecision = async (id, status, note, onDone) => {
    setBusyId(id);
    const supabase = createClient();
    const { data: updated, error } = await supabase
      .from("seller_kyc")
      .update({ status, admin_note: note, reviewed_at: new Date().toISOString() })
      .eq("id", id)
      .select("*");

    setBusyId(null);

    if (error) {
      showToast(error.message);
      return;
    }
    if (!updated || updated.length === 0) {
      showToast("That change didn't go through — check that your admin session is verified and try again.");
      return;
    }

    setRecords((prev) => prev.map((r) => (r.id === id ? { ...r, status, admin_note: note, reviewed_at: updated[0].reviewed_at } : r)));
    onDone();
    showToast(status === "approved" ? "KYC approved — seller can now be paid out" : status === "rejected" ? "KYC rejected — seller notified" : "Sent back to seller for changes");
  };

  if (records.length === 0) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>No KYC submissions yet.</p>;
  }

  return (
    <div className="space-y-2 relative">
      {toast && (
        <div className="fixed bottom-6 right-6 px-4 py-2.5 rounded-md text-sm z-50" style={{ background: "#14213D", color: "#F7F7F4" }}>
          {toast}
        </div>
      )}
      {records.map((r) => (
        <KycRow key={r.id} record={r} onDecision={handleDecision} busy={busyId === r.id} />
      ))}
    </div>
  );
}
