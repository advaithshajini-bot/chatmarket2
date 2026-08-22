"use client";

import { useState } from "react";
import { Wallet, TrendingDown, TrendingUp, Info } from "lucide-react";

function formatDate(iso) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function SummaryCard({ icon: Icon, label, value, hint, tint }) {
  return (
    <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <div className="flex items-center gap-2 mb-1" style={{ color: tint || "#6B6F76" }}>
        <Icon size={14} />
        <span className="text-xs uppercase tracking-wide" style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{label}</span>
      </div>
      <p className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        ₹{Math.round(value).toLocaleString("en-IN")}
      </p>
      {hint && <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p>}
    </div>
  );
}

function TxnStatusBadge({ status }) {
  const map = {
    paid: { bg: "#EAF2EF", color: "#2F6F62", label: "Paid" },
    refunded: { bg: "#FBEAE8", color: "#B33A2E", label: "Refunded" },
  };
  const s = map[status] || map.paid;
  return (
    <span className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide whitespace-nowrap" style={{ background: s.bg, color: s.color, fontFamily: "'IBM Plex Mono', monospace" }}>
      {s.label}
    </span>
  );
}

function WeeklyChart({ data }) {
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className="rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <p className="text-xs uppercase tracking-wide mb-4" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        Net earnings, last 8 weeks
      </p>
      <div className="flex items-end gap-3" style={{ height: 120 }}>
        {data.map((d, i) => (
          <div key={d.week} className="flex-1 flex flex-col items-center justify-end h-full">
            <div
              className="w-full rounded-sm"
              style={{
                height: `${Math.max((d.amount / max) * 100, 3)}%`,
                background: i === data.length - 1 ? "#E2A83E" : "#D8D5C9",
                transition: "height .4s ease",
              }}
              title={`₹${d.amount}`}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-2">
        {data.map((d) => (
          <div key={d.week} className="flex-1 text-center text-[10px]" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            {d.week}
          </div>
        ))}
      </div>
    </div>
  );
}

function TransactionsTab({ transactions }) {
  if (transactions.length === 0) {
    return <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>No sales yet.</p>;
  }
  return (
    <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
      {transactions.map((t, i) => (
        <div
          key={t.id}
          className="flex items-center justify-between px-4 py-3.5 gap-4"
          style={{ background: "#FFFFFF", borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}
        >
          <div className="min-w-0">
            <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", fontWeight: 500 }}>
              {t.listing}
            </p>
            <p className="text-xs" style={{ color: "#6B6F76" }}>
              bought by {t.buyer} · {formatDate(t.date)} · {t.paymentMethod}
            </p>
          </div>
          <div className="flex items-center gap-5 shrink-0">
            <div className="text-right hidden sm:block">
              <p className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                ₹{t.amount} − ₹{t.platformFee} fee
              </p>
            </div>
            <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              ₹{t.net}
            </span>
            <TxnStatusBadge status={t.status} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PayoutsPlaceholder() {
  return (
    <div className="rounded-md p-8 text-center" style={{ border: "1px dashed #D8D5C9" }}>
      <Info size={18} color="#6B6F76" className="mx-auto mb-2" />
      <p className="text-sm mb-1" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}>
        No real payouts yet
      </p>
      <p className="text-xs max-w-sm mx-auto" style={{ color: "#6B6F76" }}>
        This section will show real bank settlements once Razorpay Route is connected —
        see docs/razorpay-integration.md for the intended flow. Sale transactions above
        are real; batched payouts to your bank aren't wired up yet.
      </p>
    </div>
  );
}

export default function SellerEarningsClient({ grossEarnings, netEarnings, refundedTotal, weeklyEarnings, transactions }) {
  const [tab, setTab] = useState("transactions");

  return (
    <div>
      <h2 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        Earnings & payouts
      </h2>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
        Figures reflect an 18% platform fee, applied here for display — no real payment has moved yet.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryCard icon={Wallet} label="Net earnings" value={netEarnings} hint="after 18% platform fee" />
        <SummaryCard icon={TrendingUp} label="Gross sales" value={grossEarnings} hint="before fee" />
        <SummaryCard icon={TrendingDown} label="Refunded" value={refundedTotal} tint="#B33A2E" />
      </div>

      <div className="mb-6">
        <WeeklyChart data={weeklyEarnings} />
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setTab("transactions")}
          className="px-4 py-2 rounded-full text-sm"
          style={{
            background: tab === "transactions" ? "#14213D" : "transparent",
            color: tab === "transactions" ? "#F7F7F4" : "#14213D",
            border: "1px solid #14213D",
            fontFamily: "'IBM Plex Sans', sans-serif",
          }}
        >
          Sale transactions
        </button>
        <button
          onClick={() => setTab("payouts")}
          className="px-4 py-2 rounded-full text-sm"
          style={{
            background: tab === "payouts" ? "#14213D" : "transparent",
            color: tab === "payouts" ? "#F7F7F4" : "#14213D",
            border: "1px solid #14213D",
            fontFamily: "'IBM Plex Sans', sans-serif",
          }}
        >
          Payout history
        </button>
      </div>

      {tab === "transactions" ? <TransactionsTab transactions={transactions} /> : <PayoutsPlaceholder />}
    </div>
  );
}
