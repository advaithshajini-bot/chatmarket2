"use client";

import { useState } from "react";
import Link from "next/link";
import { Receipt, IndianRupee, Undo2, ChevronDown, ChevronUp, ExternalLink, Flag, Clock3 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function SummaryCard({ icon: Icon, label, value, hint, tint }) {
  return (
    <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <div className="flex items-center gap-2 mb-1" style={{ color: tint || "#6B6F76" }}>
        <Icon size={14} />
        <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{label}</span>
      </div>
      <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        ₹{value.toLocaleString("en-IN")}
      </p>
      {hint && <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p>}
    </div>
  );
}

function OrderStatusBadge({ status }) {
  const map = {
    paid: { bg: "#EAF2EF", color: "#2F6F62", label: "Paid" },
    refunded: { bg: "#FBEAE8", color: "#B33A2E", label: "Refunded" },
  };
  const s = map[status] || map.paid;
  return (
    <span className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide" style={{ background: s.bg, color: s.color, fontFamily: "'IBM Plex Mono', monospace" }}>
      {s.label}
    </span>
  );
}

function DisputeStatusBadge({ status }) {
  const map = {
    open: { bg: "#FBF1DD", color: "#8A6A18", label: "Dispute open" },
    resolved_refunded: { bg: "#EAF2EF", color: "#2F6F62", label: "Dispute resolved · refunded" },
    resolved_denied: { bg: "#E8E7E2", color: "#6B6F76", label: "Dispute resolved · not refunded" },
  };
  const s = map[status] || map.open;
  return (
    <span className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide" style={{ background: s.bg, color: s.color, fontFamily: "'IBM Plex Mono', monospace" }}>
      {s.label}
    </span>
  );
}

function DisputeSection({ order, onDisputeFiled }) {
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!reason.trim()) {
      setError("Give a quick description of what's wrong.");
      return;
    }
    setSubmitting(true);
    setError("");

    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    const { data, error: insertError } = await supabase
      .from("disputes")
      .insert({
        purchase_id: order.id,
        listing_id: order.listingId,
        buyer_id: userData.user.id,
        reason: reason.trim(),
      })
      .select()
      .single();

    setSubmitting(false);

    if (insertError) {
      setError(insertError.code === "23505" ? "You've already reported an issue on this order." : insertError.message);
      return;
    }

    setReporting(false);
    onDisputeFiled(order.id, data);
  };

  if (order.dispute) {
    return (
      <div className="mt-1 p-2.5 rounded" style={{ background: "#FAFAF8", border: "1px solid #EAE8DE" }}>
        <div className="flex items-center gap-2 mb-1.5">
          <DisputeStatusBadge status={order.dispute.status} />
        </div>
        <p className="text-xs mb-1" style={{ color: "#6B6F76" }}>
          <span style={{ color: "#14213D", fontWeight: 500 }}>Your report:</span> {order.dispute.reason}
        </p>
        {order.dispute.resolution_note && (
          <p className="text-xs" style={{ color: "#6B6F76" }}>
            <span style={{ color: "#14213D", fontWeight: 500 }}>Resolution:</span> {order.dispute.resolution_note}
          </p>
        )}
        {order.dispute.status === "open" && (
          <p className="text-xs mt-1 flex items-center gap-1" style={{ color: "#6B6F76" }}>
            <Clock3 size={11} /> Awaiting review by the chatmarket team
          </p>
        )}
      </div>
    );
  }

  if (order.status !== "paid") return null;

  return (
    <div>
      {reporting ? (
        <div className="p-2.5 rounded" style={{ background: "#FAFAF8", border: "1px solid #EAE8DE" }}>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What's wrong with this thread? e.g. doesn't match the description, cuts off early..."
            rows={3}
            className="w-full text-xs p-2 rounded outline-none resize-none mb-2"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
          />
          {error && <p className="text-xs mb-2" style={{ color: "#B33A2E" }}>{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="px-3 py-1.5 rounded text-xs"
              style={{ background: "#14213D", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              {submitting ? "Submitting…" : "Submit report"}
            </button>
            <button
              onClick={() => { setReporting(false); setError(""); }}
              disabled={submitting}
              className="px-3 py-1.5 rounded text-xs"
              style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setReporting(true)}
          className="px-3 py-1.5 rounded text-xs inline-flex items-center gap-1.5"
          style={{ border: "1px solid #D8D5C9", color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <Flag size={12} /> Report an issue
        </button>
      )}
    </div>
  );
}

function OrderRow({ order, onDisputeFiled }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ borderBottom: "1px solid #EAE8DE" }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3.5 text-left" style={{ background: "#FFFFFF" }}>
        <div className="flex items-center gap-3 min-w-0">
          <Receipt size={15} color="#6B6F76" className="shrink-0" />
          <div className="min-w-0">
            <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", fontWeight: 500 }}>
              {order.listingTitle}
            </p>
            <p className="text-xs" style={{ color: "#6B6F76" }}>
              {formatDate(order.date)} · {order.paymentMethod}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
            ₹{order.amount}
          </span>
          <OrderStatusBadge status={order.status} />
          {open ? <ChevronUp size={16} color="#6B6F76" /> : <ChevronDown size={16} color="#6B6F76" />}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4" style={{ background: "#FAFAF8" }}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 mb-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Purchase ID</p>
              <p className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#14213D" }}>{order.id.slice(0, 8)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Seller</p>
              <p className="text-xs" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{order.seller}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide mb-0.5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>Paid via</p>
              <p className="text-xs" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>{order.paymentMethod}</p>
            </div>
          </div>

          {order.status === "refunded" && !order.dispute && (
            <div className="flex items-start gap-2 p-2.5 rounded mb-3" style={{ background: "#FBEAE8" }}>
              <Undo2 size={13} color="#B33A2E" className="mt-0.5 shrink-0" />
              <p className="text-xs" style={{ color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                This order was refunded.
              </p>
            </div>
          )}

          <div className="mb-3">
            <DisputeSection order={order} onDisputeFiled={onDisputeFiled} />
          </div>

          {order.status === "paid" && (
            <Link
              href={`/library/${order.listingId}`}
              className="px-4 py-2 rounded text-xs inline-flex items-center gap-1.5"
              style={{ border: "1px solid #D8D5C9", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              <ExternalLink size={13} /> Open thread
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export default function PurchaseHistoryClient({ orders: initialOrders, totalSpent, totalRefunded }) {
  const [orders, setOrders] = useState(initialOrders);
  const [filter, setFilter] = useState("all");

  const handleDisputeFiled = (purchaseId, dispute) => {
    setOrders((prev) => prev.map((o) => (o.id === purchaseId ? { ...o, dispute } : o)));
  };

  const filtered = orders.filter((o) => filter === "all" || o.status === filter);

  return (
    <div>
      <h2 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        Purchase history
      </h2>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        Every order tied to your account.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryCard icon={IndianRupee} label="Total spent" value={totalSpent} hint={`${orders.filter((o) => o.status === "paid").length} purchases`} />
        <SummaryCard icon={Receipt} label="Orders placed" value={orders.length} hint="all-time" />
        <SummaryCard icon={Undo2} label="Refunded" value={totalRefunded} tint="#B33A2E" hint="from resolved disputes" />
      </div>

      <div className="flex items-center gap-2 mb-4">
        {["all", "paid", "refunded"].map((f) => (
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
            {orders.length === 0 ? "No orders yet." : "No orders in this filter."}
          </p>
        ) : (
          filtered.map((order) => <OrderRow key={order.id} order={order} onDisputeFiled={handleDisputeFiled} />)
        )}
      </div>
    </div>
  );
}
