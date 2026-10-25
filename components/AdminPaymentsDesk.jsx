"use client";

import { useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ATTENTION_LABELS, BUCKET_LABELS, LEDGER_FILTERS, DISPUTE_FILTERS, PAYOUT_FILTERS, RETRYABLE_PAYOUT_STATUSES,
  formatPaise, formatAge, getAttention, getLedger, getDisputes, getTimeline,
  clearTransferReview, getPayouts, retryPayout,
} from "@/lib/domain/admin-payments";
import AdminSettlementTab from "@/components/AdminSettlementTab";
import AdminDirectPaymentsTab from "@/components/AdminDirectPaymentsTab";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const card = { background: "#F7F7F4", border: "1px solid #D8D5C9" };
// 5.5: payouts are a manual monthly settlement. The two retired automatic flows (instant UPI, Route) only show a tab when they hold history.
const TABS = [["settlement", "Monthly settlement"], ["attention", "Needs attention"], ["disputes", "Disputes (support tickets)"], ["direct", "Direct payments"]];
const LEGACY_TABS = [["payouts", "UPI payouts (retired)"], ["transfers", "Route transfers (retired)"]];
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");

function Pill({ children, tone = "grey" }) {
  const t = { grey: ["#E8E7E2", "#6B6F76"], amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], green: ["#EAF2EF", "#2F6F62"] }[tone];
  return <span className="text-[11px] px-2 py-0.5 rounded-full uppercase tracking-wide whitespace-nowrap" style={{ background: t[0], color: t[1], ...MONO }}>{children}</span>;
}
const payoutTone = { creating: "amber", queued: "amber", processing: "amber", processed: "green", failed: "red", reversed: "red", cancelled: "red" };
const bucketTone = { held: "amber", releasing: "amber", settled: "green", reversed: "grey", failed: "red", parked: "red", creating: "amber" };

function Filters({ options, value, onChange, label }) {
  return (
    <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} aria-pressed={value === o} className="text-xs px-3 py-1.5 rounded-full"
          style={{ border: "1px solid #D8D5C9", background: value === o ? "#14213D" : "#FFFFFF", color: value === o ? "#FFFFFF" : "#6B6F76" }}>
          {(BUCKET_LABELS[o] || o.replace("resolved_", "").replace("_", " "))}
        </button>
      ))}
    </div>
  );
}

function Timeline({ data }) {
  if (!data) return null;
  if (data.found === false) return <p className="text-sm" style={{ color: "#6B6F76" }}>Purchase not found.</p>;
  const steps = [];
  const p = data.purchase;
  steps.push([p.purchased_at, `Payment ${p.status} — ${formatPaise(p.amount_paise)} (fee ${formatPaise(p.platform_fee_paise)}) · ${p.listing_title || ""} · ${p.buyer_name || "?"} → ${p.seller_name || "?"}`]);
  if (data.transfer) {
    const t = data.transfer;
    steps.push([t.created_at, `Transfer ${t.status}${t.on_hold ? " (on hold" + (t.hold_until ? " until " + when(t.hold_until) : " indefinitely") + ")" : ""} — seller share ${formatPaise(t.amount_paise)}${t.amount_reversed_paise ? `, reversed ${formatPaise(t.amount_reversed_paise)}` : ""}${t.settlement_status ? ", settlement " + t.settlement_status : ""}${t.review_reason ? " · PARKED: " + t.review_reason : ""}${t.error ? " · error: " + t.error : ""}`]);
  }
  if (data.dispute) steps.push([data.dispute.created_at, `Dispute ${data.dispute.status}: ${data.dispute.reason}${data.dispute.resolved_at ? " (resolved " + when(data.dispute.resolved_at) + ")" : ""}`]);
  if (data.refund) steps.push([data.refund.created_at, `Refund ${data.refund.status} — ${formatPaise(data.refund.amount_paise)}${data.refund.error ? " · " + data.refund.error : ""}`]);
  for (const w of data.webhook_events || []) steps.push([w.received_at, `Event ${w.event_type} → ${w.status}${w.outcome ? " (" + w.outcome + ")" : ""}${w.error ? " · " + w.error : ""}`]);
  for (const a of data.audit || []) steps.push([a.created_at, `Admin: ${a.action}`]);
  steps.sort((x, y) => new Date(x[0]) - new Date(y[0]));
  return (
    <ol className="text-xs space-y-1.5 mt-2" style={{ color: "#3A3D42" }}>
      {steps.map(([at, text], i) => <li key={i}><span style={{ ...MONO, color: "#6B6F76" }}>{when(at)}</span> — {text}</li>)}
    </ol>
  );
}

export default function AdminPaymentsDesk({ initialAttention, initialLedger, initialDisputes, initialPayouts = { total: 0, items: [] }, initialSettlement = { pending: { totals: {}, payable: [], blocked: [] }, batches: { items: [] } } }) {
  const supabase = createClient();
  const [tab, setTab] = useState("settlement");
  const [attention, setAttention] = useState(initialAttention);
  const [ledger, setLedger] = useState(initialLedger);
  const [ledgerFilter, setLedgerFilter] = useState("all");
  const [disputes, setDisputes] = useState(initialDisputes);
  const [disputeFilter, setDisputeFilter] = useState("all");
  const [payouts, setPayouts] = useState(initialPayouts);
  const [payoutFilter, setPayoutFilter] = useState("all");
  const [timelines, setTimelines] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refreshAll = useCallback(async () => {
    const [a, l, d, po] = await Promise.all([getAttention(supabase), getLedger(supabase, ledgerFilter, 0), getDisputes(supabase, disputeFilter, 0), getPayouts(supabase, payoutFilter, 0)]);
    setAttention(a); setLedger(l); setDisputes(d); setPayouts(po);
  }, [supabase, ledgerFilter, disputeFilter, payoutFilter]);

  const toggleTimeline = async (pid) => {
    if (!pid) return;
    if (timelines[pid]) { setTimelines((t) => { const n = { ...t }; delete n[pid]; return n; }); return; }
    setTimelines((t) => ({ ...t, [pid]: { loading: true } }));
    const data = await getTimeline(supabase, pid);
    setTimelines((t) => ({ ...t, [pid]: data }));
  };

  const clearReview = async (pid) => {
    if (busy) return;
    setBusy(true); setMsg("");
    const r = await clearTransferReview(supabase, pid);
    setMsg(r.error ? r.error : "Review cleared. The sweep will pick the transfer up again.");
    if (!r.error) await refreshAll();
    setBusy(false);
  };

  const doRetry = async (pid) => {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm("Retry this payout? Check the RazorpayX dashboard first: only retry if the money did NOT leave.")) return;
    setBusy(true); setMsg("");
    const r = await retryPayout(supabase, pid);
    setMsg(r.error ? r.error : "Payout re-queued. The next sweep sends it.");
    if (!r.error) await refreshAll();
    setBusy(false);
  };

  const changePayouts = async (f) => { setPayoutFilter(f); setPayouts(await getPayouts(supabase, f, 0)); };
  const changeLedger = async (f) => { setLedgerFilter(f); setLedger(await getLedger(supabase, f, 0)); };
  const changeDisputes = async (f) => { setDisputeFilter(f); setDisputes(await getDisputes(supabase, f, 0)); };

  const Expand = ({ pid }) => (
    <>
      <button onClick={() => toggleTimeline(pid)} className="text-xs underline" style={{ color: "#14213D" }}>{timelines[pid] ? "Hide timeline" : "Timeline"}</button>
      {timelines[pid] && (timelines[pid].loading ? <p className="text-xs mt-2" style={{ color: "#6B6F76" }}>Loading…</p> : <Timeline data={timelines[pid]} />)}
    </>
  );

  const failed = attention?.error || ledger?.error || disputes?.error || payouts?.error;
  const tabs = [...TABS, ...LEGACY_TABS.filter(([k]) => (k === "payouts" ? payouts?.total > 0 : ledger?.total > 0))];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Payments desk</h1>
        <button onClick={refreshAll} className="text-xs px-3 py-1.5 rounded-full" style={{ border: "1px solid #D8D5C9", color: "#6B6F76" }}>Refresh</button>
      </div>
      <p className="text-xs mb-6" style={{ color: "#6B6F76" }}>
        Figures come from the local ledger (payment webhooks and your own settlement records), not from the bank. They are not reconciled against Razorpay or your bank statement.
      </p>
      {failed && <p className="text-sm mb-4" style={{ color: "#B33A2E" }} role="alert">Some data could not be loaded. Check your MFA session and refresh.</p>}
      {msg && <p className="text-sm mb-4" style={{ color: "#3A3D42" }} role="status">{msg}</p>}

      <div className="flex gap-1 mb-6" role="tablist" style={{ borderBottom: "1px solid #D8D5C9" }}>
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="px-4 py-2 text-sm"
            style={{ color: tab === k ? "#14213D" : "#6B6F76", fontWeight: tab === k ? 600 : 400, borderBottom: tab === k ? "2px solid #14213D" : "2px solid transparent" }}>
            {label}{k === "attention" && attention?.total > 0 ? ` (${attention.total})` : ""}
          </button>
        ))}
      </div>

      {tab === "settlement" && (
        <AdminSettlementTab supabase={supabase} initialPending={initialSettlement.pending} initialBatches={initialSettlement.batches} />
      )}

      {tab === "direct" && <AdminDirectPaymentsTab supabase={supabase} />}

      {tab === "attention" && (
        <div>
          {attention.items.length === 0 && <p className="text-sm" style={{ color: "#6B6F76" }}>Nothing needs attention.</p>}
          <div className="space-y-3">
            {attention.items.map((i, n) => (
              <div key={`${i.kind}-${i.purchase_id || i.event_id}-${n}`} className="rounded-md p-4" style={card}>
                <div className="flex flex-wrap items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <Pill tone={i.kind === "parked_transfer" || i.kind.endsWith("failed") || i.kind === "payout_parked" || i.kind === "payout_returned" ? "red" : "amber"}>{ATTENTION_LABELS[i.kind] || i.kind}</Pill>
                    <span className="text-xs" style={{ color: "#6B6F76", ...MONO }}>{formatAge(i.age_seconds)} ago</span>
                  </div>
                  <span className="text-sm" style={{ color: "#14213D", fontWeight: 500 }}>{i.amount_paise != null ? formatPaise(i.amount_paise) : ""}</span>
                </div>
                <p className="text-xs mt-2" style={{ color: "#3A3D42" }}>
                  {i.seller_name ? `Seller ${i.seller_name}` : ""}{i.buyer_name ? ` · Buyer ${i.buyer_name}` : ""}
                </p>
                {i.detail && <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{i.detail}</p>}
                <div className="flex items-center gap-4 mt-3">
                  {i.kind === "parked_transfer" && (
                    <button disabled={busy} onClick={() => clearReview(i.purchase_id)} className="text-xs px-3 py-1.5 rounded-md" style={{ background: "#14213D", color: "#fff", opacity: busy ? 0.6 : 1 }}>Clear review</button>
                  )}
                  {["payout_failed", "payout_parked", "payout_returned"].includes(i.kind) && (
                    <button disabled={busy} onClick={() => doRetry(i.purchase_id)} className="text-xs px-3 py-1.5 rounded-md" style={{ background: "#14213D", color: "#fff", opacity: busy ? 0.6 : 1 }}>Retry payout</button>
                  )}
                  {i.purchase_id && <Expand pid={i.purchase_id} />}
                </div>
              </div>
            ))}
          </div>
          {attention.total > attention.items.length && <p className="text-xs mt-3" style={{ color: "#6B6F76" }}>Showing the oldest {attention.items.length} of {attention.total}.</p>}
        </div>
      )}

      {tab === "payouts" && (
        <div>
          <Filters options={PAYOUT_FILTERS} value={payoutFilter} onChange={changePayouts} label="Filter UPI payouts" />
          {payouts.items.length === 0 && <p className="text-sm" style={{ color: "#6B6F76" }}>No UPI payouts.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "#6B6F76", ...MONO }}>
                  <th className="py-2 pr-3">When</th><th className="pr-3">Seller</th><th className="pr-3">UPI ID</th><th className="pr-3">Status</th><th className="pr-3 text-right">Paid out</th><th className="pr-3 text-right">Fee</th><th className="pr-3">UTR</th><th></th>
                </tr>
              </thead>
              <tbody>
                {payouts.items.map((t) => (
                  <tr key={t.purchase_id} style={{ borderTop: "1px solid #EAE8DE", verticalAlign: "top" }}>
                    <td className="py-2 pr-3 text-xs">{when(t.created_at)}</td>
                    <td className="pr-3">{t.seller_name || "—"}</td>
                    <td className="pr-3 text-xs" style={MONO}>{t.vpa_address}</td>
                    <td className="pr-3"><Pill tone={payoutTone[t.status]}>{t.status}</Pill>{t.review_reason && <div className="text-xs mt-1" style={{ color: "#B33A2E" }}>{t.review_reason}</div>}{t.error && <div className="text-xs mt-1" style={{ color: "#B33A2E" }}>{t.error}</div>}</td>
                    <td className="pr-3 text-right">{formatPaise(t.amount_paise)}</td>
                    <td className="pr-3 text-right">{formatPaise(t.platform_fee_paise)}</td>
                    <td className="pr-3 text-xs" style={MONO}>{t.utr || "—"}</td>
                    <td className="py-2">
                      {RETRYABLE_PAYOUT_STATUSES.includes(t.status) && <button disabled={busy} onClick={() => doRetry(t.purchase_id)} className="text-xs px-3 py-1.5 rounded-md mr-2" style={{ background: "#14213D", color: "#fff", opacity: busy ? 0.6 : 1 }}>Retry</button>}
                      <Expand pid={t.purchase_id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-3" style={{ color: "#6B6F76" }}>{payouts.total} payout{payouts.total === 1 ? "" : "s"}{payouts.total > payouts.items.length ? ` · showing the newest ${payouts.items.length}` : ""}. Payouts are final once processed; a retry is only for payouts that failed or were returned.</p>
        </div>
      )}

      {tab === "transfers" && (
        <div>
          <Filters options={LEDGER_FILTERS} value={ledgerFilter} onChange={changeLedger} label="Filter transfers" />
          {ledger.items.length === 0 && <p className="text-sm" style={{ color: "#6B6F76" }}>No transfers.</p>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "#6B6F76", ...MONO }}>
                  <th className="py-2 pr-3">When</th><th className="pr-3">Seller</th><th className="pr-3">Status</th><th className="pr-3 text-right">Seller share</th><th className="pr-3 text-right">Fee</th><th className="pr-3">Hold until</th><th></th>
                </tr>
              </thead>
              <tbody>
                {ledger.items.map((t) => (
                  <tr key={t.purchase_id} style={{ borderTop: "1px solid #EAE8DE", verticalAlign: "top" }}>
                    <td className="py-2 pr-3 text-xs">{when(t.created_at)}</td>
                    <td className="pr-3">{t.seller_name || "—"}</td>
                    <td className="pr-3"><Pill tone={bucketTone[t.bucket]}>{t.bucket}</Pill>{t.dispute_status === "open" && <> <Pill tone="amber">dispute</Pill></>}</td>
                    <td className="pr-3 text-right">{formatPaise(t.amount_paise)}</td>
                    <td className="pr-3 text-right">{formatPaise(t.platform_fee_paise)}</td>
                    <td className="pr-3 text-xs">{t.on_hold ? (t.hold_until ? when(t.hold_until) : "indefinite") : "—"}</td>
                    <td className="py-2"><Expand pid={t.purchase_id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-3" style={{ color: "#6B6F76" }}>{ledger.total} transfer{ledger.total === 1 ? "" : "s"}{ledger.total > ledger.items.length ? ` · showing the newest ${ledger.items.length}` : ""}</p>
        </div>
      )}

      {tab === "disputes" && (
        <div>
          <Filters options={DISPUTE_FILTERS} value={disputeFilter} onChange={changeDisputes} label="Filter disputes" />
          <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>Disputes are customer-support tickets. They never move money and are never charged to a seller.</p>
          {disputes.items.length === 0 && <p className="text-sm" style={{ color: "#6B6F76" }}>No disputes.</p>}
          <div className="space-y-3">
            {disputes.items.map((d) => (
              <div key={d.purchase_id} className="rounded-md p-4" style={card}>
                <div className="flex flex-wrap items-center gap-2 justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={d.dispute_status === "open" ? "amber" : d.dispute_status === "resolved_refunded" ? "green" : "grey"}>{d.dispute_status.replace("resolved_", "")}</Pill>
                    {d.transfer_bucket && <Pill tone={bucketTone[d.transfer_bucket]}>transfer {d.transfer_bucket}</Pill>}
                    {d.refund_status && <Pill tone={d.refund_status === "failed" ? "red" : d.refund_status === "processed" ? "green" : "amber"}>refund {d.refund_status}</Pill>}
                  </div>
                  <span className="text-sm" style={{ fontWeight: 500, color: "#14213D" }}>{formatPaise(d.amount_paise)}</span>
                </div>
                <p className="text-xs mt-2" style={{ color: "#3A3D42" }}>{d.buyer_name || "?"} vs {d.seller_name || "?"} · opened {when(d.created_at)}</p>
                <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{d.reason}</p>
                {d.refund_error && <p className="text-xs mt-1" style={{ color: "#B33A2E" }}>Refund error: {d.refund_error}</p>}
                {d.transfer_review_reason && <p className="text-xs mt-1" style={{ color: "#B33A2E" }}>Parked: {d.transfer_review_reason}</p>}
                <div className="mt-3"><Expand pid={d.purchase_id} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
