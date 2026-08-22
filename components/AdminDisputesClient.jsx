"use client";

import { useState, useMemo } from "react";
import { Flag, IndianRupee, User, Store, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function DisputeStatusPill({ status }) {
  const map = {
    open: { bg: "#FBF1DD", color: "#8A6A18", label: "Open" },
    resolved_refunded: { bg: "#EAF2EF", color: "#2F6F62", label: "Refunded" },
    resolved_denied: { bg: "#E8E7E2", color: "#6B6F76", label: "Denied" },
  };
  const s = map[status] || map.open;
  return (
    <span className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide" style={{ background: s.bg, color: s.color, fontFamily: "'IBM Plex Mono', monospace" }}>
      {s.label}
    </span>
  );
}

function DisputeRow({ dispute, onResolve, busy }) {
  const [open, setOpen] = useState(dispute.status === "open");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const handle = async (outcome) => {
    setError("");
    const result = await onResolve(dispute.id, outcome, note.trim() || null);
    if (result?.error) setError(result.error);
  };

  return (
    <div style={{ borderBottom: "1px solid #EAE8DE" }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3.5 text-left" style={{ background: "#FFFFFF" }}>
        <div className="flex items-center gap-3 min-w-0">
          <Flag size={15} color="#6B6F76" className="shrink-0" />
          <div className="min-w-0">
            <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", fontWeight: 500 }}>
              {dispute.listingTitle}
            </p>
            <p className="text-xs" style={{ color: "#6B6F76" }}>
              {formatDate(dispute.createdAt)} · {dispute.buyer} vs {dispute.seller}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {dispute.amount != null && (
            <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              ₹{dispute.amount}
            </span>
          )}
          <DisputeStatusPill status={dispute.status} />
          {open ? <ChevronUp size={16} color="#6B6F76" /> : <ChevronDown size={16} color="#6B6F76" />}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4" style={{ background: "#FAFAF8" }}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 mb-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5 flex items-center gap-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                <User size={10} /> Buyer
              </p>
              <p className="text-xs" style={{ color: "#14213D" }}>{dispute.buyer}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5 flex items-center gap-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                <Store size={10} /> Seller
              </p>
              <p className="text-xs" style={{ color: "#14213D" }}>{dispute.seller}</p>
            </div>
            {dispute.amount != null && (
              <div>
                <p className="text-[10px] uppercase tracking-wide mb-0.5 flex items-center gap-1" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                  <IndianRupee size={10} /> Amount
                </p>
                <p className="text-xs" style={{ color: "#14213D" }}>₹{dispute.amount}</p>
              </div>
            )}
          </div>

          <p className="text-xs mb-3 p-2.5 rounded" style={{ background: "#FFFFFF", border: "1px solid #EAE8DE", color: "#14213D" }}>
            "{dispute.reason}"
          </p>

          {dispute.status === "open" ? (
            <div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Resolution note for the buyer (optional)"
                rows={2}
                className="w-full text-xs p-2 rounded outline-none resize-none mb-2"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
              />
              {error && <p className="text-xs mb-2" style={{ color: "#B33A2E" }}>{error}</p>}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handle("resolved_refunded")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                  style={{ background: "#2F6F62", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
                >
                  <Check size={12} /> Refund buyer
                </button>
                <button
                  onClick={() => handle("resolved_denied")}
                  disabled={busy}
                  className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
                  style={{ border: "1.5px solid #B33A2E", color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
                >
                  <X size={12} /> Deny dispute
                </button>
              </div>
            </div>
          ) : (
            dispute.resolutionNote && (
              <p className="text-xs" style={{ color: "#6B6F76" }}>
                <span style={{ color: "#14213D", fontWeight: 500 }}>Resolution note:</span> {dispute.resolutionNote}
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminDisputesClient({ initialDisputes }) {
  const [disputes, setDisputes] = useState(initialDisputes);
  const [filter, setFilter] = useState("open");
  const [busyId, setBusyId] = useState(null);

  const filtered = useMemo(() => {
    if (filter === "all") return disputes;
    if (filter === "open") return disputes.filter((d) => d.status === "open");
    return disputes.filter((d) => d.status !== "open");
  }, [disputes, filter]);

  const handleResolve = async (id, outcome, note) => {
    setBusyId(id);
    const supabase = createClient();
    const { data, error } = await supabase.rpc("resolve_dispute", {
      p_dispute_id: id,
      p_outcome: outcome,
      p_note: note,
    });
    setBusyId(null);

    if (error) return { error: error.message };

    setDisputes((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: data.status, resolutionNote: data.resolution_note } : d))
    );
    return {};
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        {["open", "resolved", "all"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-4 py-2 rounded-full text-sm capitalize"
            style={{
              background: filter === f ? "#14213D" : "transparent",
              color: filter === f ? "#F7F7F4" : "#14213D",
              border: "1px solid #14213D",
              fontFamily: "'IBM Plex Sans', sans-serif",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
        {filtered.length === 0 ? (
          <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>
            {disputes.length === 0 ? "No disputes filed yet." : "Nothing in this filter."}
          </p>
        ) : (
          filtered.map((d) => <DisputeRow key={d.id} dispute={d} onResolve={handleResolve} busy={busyId === d.id} />)
        )}
      </div>
    </div>
  );
}
