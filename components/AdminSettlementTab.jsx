"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatPaise, getSettlementPending, getSettlementBatches, getSettlementBatch, createSettlementBatch, settleItems, releaseSettlementItem,
  cancelSettlementBatch, buildSettlementCsv, csvFilename, defaultSettlementPeriod, istDateToIso, isValidReference, BLOCKED_LABELS,
} from "@/lib/domain/admin-settlement";
import { setSellerPayoutStatus } from "@/lib/domain/admin-payments";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const card = { background: "#F7F7F4", border: "1px solid #D8D5C9" };
const btn = (busy, primary = true) => ({ background: primary ? "#14213D" : "#FFFFFF", color: primary ? "#FFFFFF" : "#14213D", border: "1px solid #14213D", opacity: busy ? 0.6 : 1 });
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

function Pill({ children, tone = "grey" }) {
  const t = { grey: ["#E8E7E2", "#6B6F76"], amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], green: ["#EAF2EF", "#2F6F62"] }[tone];
  return <span className="text-[11px] px-2 py-0.5 rounded-full uppercase tracking-wide whitespace-nowrap" style={{ background: t[0], color: t[1], ...MONO }}>{children}</span>;
}
const itemTone = { pending: "amber", paid: "green", released: "grey" };

// Plain browser download: the CSV is built in the page from the admin-only RPC result; nothing is uploaded anywhere.
function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AdminSettlementTab({ supabase, initialPending, initialBatches }) {
  const period = useMemo(() => defaultSettlementPeriod(), []);
  const [pending, setPending] = useState(initialPending);
  const [batches, setBatches] = useState(initialBatches);
  const [cutoff, setCutoff] = useState(period.cutoffDate);
  const [label, setLabel] = useState(period.label);
  const [viewId, setViewId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ tone: "ok", text: "" });

  const openBatch = (batches?.items || []).find((b) => b.status === "open") || null;
  const shownId = openBatch?.batch_id || viewId;

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    setDetail(await getSettlementBatch(supabase, id));
    setSelected(new Set());
  }, [supabase]);
  useEffect(() => { loadDetail(shownId); }, [shownId, loadDetail]);

  const refresh = useCallback(async (iso) => {
    const [p, b] = await Promise.all([getSettlementPending(supabase, iso ?? istDateToIso(cutoff)), getSettlementBatches(supabase)]);
    setPending(p); setBatches(b);
  }, [supabase, cutoff]);

  const say = (tone, text) => setMsg({ tone, text });
  const guard = async (fn) => { if (busy) return; setBusy(true); say("ok", ""); try { await fn(); } finally { setBusy(false); } };

  const preview = () => guard(async () => {
    const iso = istDateToIso(cutoff);
    if (!iso) return say("err", "Pick a valid cut-off date.");
    setPending(await getSettlementPending(supabase, iso));
  });

  const create = () => guard(async () => {
    const iso = istDateToIso(cutoff);
    if (!iso) return say("err", "Pick a valid cut-off date.");
    if (!label.trim()) return say("err", "Give the batch a label, for example 2026-10.");
    const t = pending?.totals || {};
    if (typeof window !== "undefined" && !window.confirm(`Freeze batch "${label.trim()}"?\n\n${formatPaise(t.payable_paise)} to ${t.payable_sellers} seller(s), for sales before ${cutoff} (IST).\nThe amounts and UPI IDs are locked in; you then pay them by hand.`)) return;
    const r = await createSettlementBatch(supabase, { label: label.trim(), periodEndIso: iso });
    if (r.error) return say("err", r.error);
    say("ok", `Batch created: ${formatPaise(r.data.total_paise)} to ${r.data.seller_count} seller(s). Export the CSV, pay by UPI, then record the bank reference below.`);
    await refresh(iso);
  });

  const toggleSeller = (userId, status) => guard(async () => {
    const r = await setSellerPayoutStatus(supabase, userId, status);
    if (r.error) return say("err", r.error);
    say("ok", status === "suspended" ? "Payouts to this seller are paused: they will be left out of batches." : "Payouts to this seller are on again.");
    await refresh();
  });

  const items = detail?.items || [];
  const batch = detail?.batch;
  const pendingItems = items.filter((i) => i.status === "pending");
  const hasPaid = items.some((i) => i.status === "paid");
  const isOpen = batch?.status === "open";
  const pendingTotal = pendingItems.reduce((n, i) => n + (i.amount_paise || 0), 0);
  const chosen = pendingItems.filter((i) => selected.has(i.item_id));
  const chosenTotal = chosen.reduce((n, i) => n + (i.amount_paise || 0), 0);

  const exportCsv = () => {
    if (!batch) return;
    downloadCsv(csvFilename(batch), buildSettlementCsv(batch, items, { onlyPending: isOpen }));
  };

  const markPaid = (ids) => guard(async () => {
    const ref = reference.trim();
    if (!isValidReference(ref)) return say("err", "Enter the bank / bulk-transfer reference (letters, digits, space . _ / -, up to 80 characters).");
    const total = ids ? chosenTotal : pendingTotal, n = ids ? chosen.length : pendingItems.length;
    if (typeof window !== "undefined" && !window.confirm(`Record ${n} payment(s) totalling ${formatPaise(total)} as PAID with reference "${ref}"?\n\nOnly do this after the money has actually been sent. A paid item is final and cannot be undone.`)) return;
    const r = await settleItems(supabase, batch.batch_id, ref, ids);
    if (r.error) return say("err", r.error);
    say("ok", r.data.batch_completed ? `Recorded. Batch "${batch.label}" is complete.` : `Recorded ${r.data.settled_count} payment(s).`);
    setReference("");
    await refresh(); await loadDetail(batch.batch_id);
  });

  const release = (item) => guard(async () => {
    const reason = typeof window !== "undefined" ? window.prompt(`Release ${item.seller_name || "this seller"}'s ${formatPaise(item.amount_paise)}?\nTheir sales go back to "unsettled" and join the next batch.\n\nWhy? (for example: UPI ID rejected by the bank)`) : null;
    if (!reason || !reason.trim()) return;
    const r = await releaseSettlementItem(supabase, item.item_id, reason.trim());
    if (r.error) return say("err", r.error);
    say("ok", "Released. Those sales are unsettled again.");
    await refresh(); await loadDetail(batch.batch_id);
  });

  const cancel = () => guard(async () => {
    if (typeof window !== "undefined" && !window.confirm(`Cancel batch "${batch.label}"? Nothing has been paid yet; the sales go back to unsettled.`)) return;
    const r = await cancelSettlementBatch(supabase, batch.batch_id);
    if (r.error) return say("err", r.error);
    say("ok", "Batch cancelled."); setViewId(null); setDetail(null);
    await refresh();
  });

  const t = pending?.totals || {};
  const failed = pending?.error || batches?.error;

  return (
    <div>
      <div className="rounded-md p-4 mb-6" style={card}>
        <p className="text-sm mb-1" style={{ fontWeight: 600, color: "#14213D" }}>Monthly settlement (manual UPI)</p>
        <ol className="text-xs list-decimal ml-4 space-y-0.5" style={{ color: "#3A3D42" }}>
          <li>Preview what each seller is owed and freeze a batch (amounts and UPI IDs are locked in).</li>
          <li>Download the CSV and pay each seller by UPI from your bank or UPI app.</li>
          <li>Record the bank reference here. Items you cannot pay (for example a rejected UPI ID) can be released to the next batch.</li>
        </ol>
        <p className="text-xs mt-2" style={{ color: "#6B6F76" }}>Nothing on this page moves money. A paid item is final; sales refunded after payment are never taken back from a seller.</p>
      </div>

      {failed && <p className="text-sm mb-4" style={{ color: "#B33A2E" }} role="alert">Some data could not be loaded. Check your MFA session and refresh.</p>}
      {msg.text && <p className="text-sm mb-4" role={msg.tone === "err" ? "alert" : "status"} style={{ color: msg.tone === "err" ? "#B33A2E" : "#3A3D42" }}>{msg.text}</p>}

      {!openBatch && (
        <section className="mb-8" aria-label="Prepare a settlement batch">
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <label className="text-xs" style={{ color: "#6B6F76" }}>Sales before (IST day)
              <input type="date" value={cutoff} max={period.todayDate} onChange={(e) => setCutoff(e.target.value)} className="block mt-1 text-sm px-3 py-2 rounded-md" style={{ border: "1px solid #D8D5C9" }} />
            </label>
            <label className="text-xs" style={{ color: "#6B6F76" }}>Batch label
              <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} className="block mt-1 text-sm px-3 py-2 rounded-md" style={{ border: "1px solid #D8D5C9", ...MONO }} />
            </label>
            <button disabled={busy} onClick={preview} className="text-sm px-4 py-2 rounded-md" style={btn(busy, false)}>Preview</button>
            <button disabled={busy || !(t.payable_sellers > 0)} onClick={create} className="text-sm px-4 py-2 rounded-md" style={btn(busy || !(t.payable_sellers > 0))}>Freeze batch</button>
          </div>

          <p className="text-sm mb-3" style={{ color: "#14213D" }}>
            <strong>{formatPaise(t.payable_paise || 0)}</strong> payable to {t.payable_sellers || 0} seller(s) across {t.payable_purchases || 0} sale(s)
            {pending?.min_payout_paise > 0 && <span style={{ color: "#6B6F76" }}> · minimum payout {formatPaise(pending.min_payout_paise)}</span>}
            {pending?.upi_cooldown_hours > 0 && <span style={{ color: "#6B6F76" }}> · changed UPI IDs wait {pending.upi_cooldown_hours}h</span>}
            {t.blocked_sellers > 0 && <span style={{ color: "#8A6A18" }}> · {formatPaise(t.blocked_paise || 0)} held back for {t.blocked_sellers} seller(s) who can&apos;t be paid yet</span>}
          </p>

          {(pending?.payable || []).length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                <thead><tr className="text-left text-xs uppercase" style={{ color: "#6B6F76", ...MONO }}><th className="py-2 pr-3">Seller</th><th className="pr-3">UPI ID</th><th className="pr-3 text-right">Sales</th><th className="pr-3 text-right">Fee</th><th className="pr-3 text-right">Pay</th><th></th></tr></thead>
                <tbody>
                  {pending.payable.map((p) => (
                    <tr key={p.seller_id} style={{ borderTop: "1px solid #EAE8DE" }}>
                      <td className="py-2 pr-3">{p.seller_name || p.seller_id.slice(0, 8)}</td>
                      <td className="pr-3 text-xs" style={MONO}>{p.vpa_address}</td>
                      <td className="pr-3 text-right">{p.purchase_count}</td>
                      <td className="pr-3 text-right">{formatPaise(p.platform_fee_paise)}</td>
                      <td className="pr-3 text-right" style={{ fontWeight: 600 }}>{formatPaise(p.amount_paise)}</td>
                      <td><button disabled={busy} onClick={() => toggleSeller(p.seller_id, "suspended")} className="text-xs underline" style={{ color: "#14213D" }}>Pause</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(pending?.payable || []).length === 0 && !failed && <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>Nothing payable for this cut-off.</p>}

          {(pending?.blocked || []).length > 0 && (
            <div className="overflow-x-auto">
              <p className="text-xs mb-1" style={{ color: "#8A6A18", ...MONO }}>NOT INCLUDED (their earnings stay unsettled)</p>
              <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
                <tbody>
                  {pending.blocked.map((b) => (
                    <tr key={b.seller_id} style={{ borderTop: "1px solid #EAE8DE" }}>
                      <td className="py-2 pr-3">{b.seller_name || b.seller_id.slice(0, 8)}</td>
                      <td className="pr-3"><Pill tone="amber">{BLOCKED_LABELS[b.reason] || b.reason}</Pill>{b.reason === "upi_in_cooldown" && b.upi_unlocks_at && <span className="block text-xs mt-1" style={{ color: "#6B6F76" }}>new ID matures {when(b.upi_unlocks_at)}</span>}</td>
                      <td className="pr-3 text-right">{b.purchase_count} sale(s)</td>
                      <td className="pr-3 text-right">{formatPaise(b.amount_paise)}</td>
                      <td>{b.reason === "account_suspended" && <button disabled={busy} onClick={() => toggleSeller(b.seller_id, "active")} className="text-xs underline" style={{ color: "#14213D" }}>Resume</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {shownId && detail?.found && batch && (
        <section className="mb-8" aria-label="Settlement batch">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-3">
              <h2 className="text-lg" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Batch {batch.label}</h2>
              <Pill tone={isOpen ? "amber" : "green"}>{batch.status}</Pill>
              {!isOpen && <button onClick={() => { setViewId(null); setDetail(null); }} className="text-xs underline" style={{ color: "#6B6F76" }}>Close</button>}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={exportCsv} className="text-sm px-4 py-2 rounded-md" style={btn(false, false)}>{isOpen ? "Download CSV (to pay)" : "Download CSV"}</button>
              {isOpen && !hasPaid && <button disabled={busy} onClick={cancel} className="text-sm px-3 py-2 rounded-md" style={{ color: "#B33A2E", border: "1px solid #B33A2E", opacity: busy ? 0.6 : 1 }}>Cancel batch</button>}
            </div>
          </div>
          <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>Sales before {when(batch.period_end)} · created {when(batch.created_at)}{batch.completed_at ? ` · completed ${when(batch.completed_at)}` : ""} · total {formatPaise(batch.total_paise)} to {batch.seller_count} seller(s)</p>

          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead><tr className="text-left text-xs uppercase" style={{ color: "#6B6F76", ...MONO }}><th className="py-2 pr-2 w-6"></th><th className="pr-3">Seller</th><th className="pr-3">UPI ID</th><th className="pr-3 text-right">Sales</th><th className="pr-3 text-right">Amount</th><th className="pr-3">Status</th><th></th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.item_id} style={{ borderTop: "1px solid #EAE8DE", verticalAlign: "top" }}>
                    <td className="py-2 pr-2">{i.status === "pending" && isOpen && (
                      <input type="checkbox" aria-label={`Select ${i.seller_name || "seller"}`} checked={selected.has(i.item_id)}
                        onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(i.item_id); else n.delete(i.item_id); return n; })} />
                    )}</td>
                    <td className="pr-3">{i.seller_name || i.seller_id.slice(0, 8)}</td>
                    <td className="pr-3 text-xs" style={MONO}>
                      {i.vpa_address}
                      <div className="flex flex-wrap gap-1 mt-1">
                        {i.upi_changed_recently && <Pill tone="amber">UPI ID changed recently</Pill>}
                        {i.upi_changed_since_snapshot && <Pill tone="red">UPI ID changed since batch</Pill>}
                        {i.refunded_purchase_count > 0 && <Pill tone="red">{i.refunded_purchase_count} sale(s) refunded since</Pill>}
                        {i.account_status === "suspended" && <Pill tone="red">payouts paused</Pill>}
                      </div>
                    </td>
                    <td className="pr-3 text-right">{i.purchase_count}</td>
                    <td className="pr-3 text-right" style={{ fontWeight: 600 }}>{formatPaise(i.amount_paise)}</td>
                    <td className="pr-3"><Pill tone={itemTone[i.status]}>{i.status}</Pill>{i.utr && <div className="text-xs mt-1" style={MONO}>{i.utr}</div>}{i.released_reason && <div className="text-xs mt-1" style={{ color: "#6B6F76" }}>{i.released_reason}</div>}</td>
                    <td>{i.status === "pending" && isOpen && <button disabled={busy} onClick={() => release(i)} className="text-xs underline" style={{ color: "#14213D" }}>Release</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isOpen && pendingItems.length > 0 && (
            <div className="rounded-md p-4" style={card}>
              <p className="text-sm mb-2" style={{ fontWeight: 600, color: "#14213D" }}>Record payment</p>
              <p className="text-xs mb-3" style={{ color: "#6B6F76" }}>After you have sent the money, enter the bank / bulk-transfer reference (UTR). It is saved on every item you mark as paid and shown to those sellers.</p>
              <div className="flex flex-wrap items-center gap-3">
                <input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} placeholder="Bank reference / UTR" aria-label="Bank reference" className="text-sm px-3 py-2 rounded-md w-64" style={{ border: "1px solid #D8D5C9", ...MONO }} />
                <button disabled={busy || !isValidReference(reference)} onClick={() => markPaid(null)} className="text-sm px-4 py-2 rounded-md" style={btn(busy || !isValidReference(reference))}>Mark all {pendingItems.length} pending as paid ({formatPaise(pendingTotal)})</button>
                <button disabled={busy || chosen.length === 0 || !isValidReference(reference)} onClick={() => markPaid(chosen.map((c) => c.item_id))} className="text-sm px-4 py-2 rounded-md" style={btn(busy || chosen.length === 0 || !isValidReference(reference), false)}>Mark {chosen.length} selected as paid</button>
              </div>
            </div>
          )}
        </section>
      )}
      {shownId && detail && detail.found === false && <p className="text-sm mb-6" style={{ color: "#B33A2E" }}>That batch could not be loaded.</p>}

      <section aria-label="Past batches">
        <h2 className="text-sm mb-2" style={{ fontWeight: 600, color: "#14213D" }}>Batches</h2>
        {(batches?.items || []).length === 0 ? <p className="text-sm" style={{ color: "#6B6F76" }}>No batches yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
              <thead><tr className="text-left text-xs uppercase" style={{ color: "#6B6F76", ...MONO }}><th className="py-2 pr-3">Label</th><th className="pr-3">Status</th><th className="pr-3 text-right">Sellers</th><th className="pr-3 text-right">Total</th><th className="pr-3 text-right">Paid</th><th className="pr-3 text-right">Released</th><th className="pr-3">Created</th><th></th></tr></thead>
              <tbody>
                {batches.items.map((b) => (
                  <tr key={b.batch_id} style={{ borderTop: "1px solid #EAE8DE" }}>
                    <td className="py-2 pr-3" style={MONO}>{b.label}</td>
                    <td className="pr-3"><Pill tone={b.status === "open" ? "amber" : "green"}>{b.status}</Pill></td>
                    <td className="pr-3 text-right">{b.seller_count}</td>
                    <td className="pr-3 text-right">{formatPaise(b.total_paise)}</td>
                    <td className="pr-3 text-right">{formatPaise(b.paid_paise)}</td>
                    <td className="pr-3 text-right">{formatPaise(b.released_paise)}</td>
                    <td className="pr-3 text-xs">{when(b.created_at)}</td>
                    <td>{b.status !== "open" && <button onClick={() => setViewId(b.batch_id)} className="text-xs underline" style={{ color: "#14213D" }}>View</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
