"use client";

import Link from "next/link";
import { describeSettlement, describeSettlementAccount, describeBankCooldown, formatPayoutDate } from "@/lib/domain/seller-settlement";
import { formatPaise } from "@/lib/domain/paise";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONES = { green: ["#EAF2EF", "#2F6F62"], amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], grey: ["#E8E7E2", "#6B6F76"] };
const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

function Pill({ tone, children }) {
  const [bg, color] = TONES[tone] || TONES.grey;
  return <span className="text-[11px] px-2 py-1 rounded-full tracking-wide" style={{ background: bg, color, ...MONO }}>{children}</span>;
}

function Stat({ label, paise, hint }) {
  return (
    <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
      <p className="text-xs uppercase tracking-wide mb-1" style={{ color: "#6B6F76", ...MONO }}>{label}</p>
      <p className="text-xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{formatPaise(paise)}</p>
      {hint && <p className="text-xs mt-1" style={{ color: "#6B6F76" }}>{hint}</p>}
    </div>
  );
}

// Monthly manual settlement: sales are paid once a month, by hand, to the seller's saved bank account. All sales are final.
export default function SellerPayoutPanel({ settlement }) {
  const account = describeSettlementAccount(settlement?.account_status);
  const s = settlement?.summary || {};
  const items = settlement?.items || [];
  const payouts = settlement?.payouts || [];
  const next = formatPayoutDate(settlement?.next_payout_date);
  const cooldownNote = describeBankCooldown(settlement?.bank_unlocks_at);

  return (
    <div>
      {settlement?.error && <p className="text-sm mb-4" style={{ color: "#B33A2E" }} role="alert">We couldn&apos;t load your payout status just now. Please refresh in a moment.</p>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Pill tone={account.tone}>{account.label}</Pill>
        {account.needsAction && (
          <Link href="/sell/payout" className="text-sm underline" style={{ color: "#14213D" }}>Add your bank account →</Link>
        )}
      </div>

      {settlement?.bank_masked && (
        <p className="text-sm mb-4" style={{ color: "#3A3D42" }}>Payouts go to <span style={MONO}>{settlement.bank_masked}</span>. <Link href="/sell/payout" className="underline">Change</Link></p>
      )}

      {cooldownNote && (
        <p className="text-sm mb-4 rounded-md px-3 py-2.5" role="status" style={{ background: "#FBF1DD", border: "1px solid #E9D9AA", color: "#3A3D42" }}>
          {cooldownNote} Earnings made meanwhile are not lost: they are paid in the next monthly payout after that time.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <Stat label="Unsettled earnings" paise={s.unsettled_paise} hint={next ? `Next payout: ${next}` : "Paid once a month"} />
        {s.in_batch_paise > 0 && <Stat label="Being paid" paise={s.in_batch_paise} hint="in this month's payout" />}
        <Stat label="Paid out" paise={s.settled_paise} hint="sent to your bank account" />
        {s.action_needed_paise > 0 && <Stat label="Action needed" paise={s.action_needed_paise} hint="add your bank account" />}
        {s.refunded_paise > 0 && <Stat label="Refunded before payout" paise={s.refunded_paise} />}
      </div>

      {settlement?.min_payout_paise > 0 && (
        <p className="text-sm mb-6" style={{ color: "#3A3D42" }}>
          Payouts are made once your unsettled earnings reach {formatPaise(settlement.min_payout_paise)}. Smaller amounts roll over to the next month and are added to your next payout.
        </p>
      )}

      <h3 className="text-sm mb-2" style={{ fontWeight: 600, color: "#14213D" }}>Past payouts</h3>
      {payouts.length === 0 ? (
        <p className="text-sm mb-8" style={{ color: "#6B6F76" }}>No payouts yet. Your first one is on {next || "the 1st of next month"}.</p>
      ) : (
        <div className="rounded-md overflow-hidden mb-8" style={{ border: "1px solid #D8D5C9" }}>
          {payouts.map((p, n) => (
            <div key={`${p.batch_label}-${p.paid_at}`} className="flex items-center justify-between gap-4 px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: n === 0 ? "none" : "1px solid #EAE8DE" }}>
              <div className="min-w-0">
                <p className="text-sm" style={{ color: "#14213D", fontWeight: 500 }}>{p.batch_label} payout · {p.purchase_count} sale{p.purchase_count === 1 ? "" : "s"}</p>
                <p className="text-xs" style={{ color: "#6B6F76" }}>Sent {when(p.paid_at)} to <span style={MONO}>{p.bank_masked || p.upi_masked}</span>{p.reference ? <> · Ref <span style={MONO}>{p.reference}</span></> : null}</p>
              </div>
              <span className="text-sm shrink-0" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{formatPaise(p.amount_paise)}</span>
            </div>
          ))}
        </div>
      )}

      <h3 className="text-sm mb-2" style={{ fontWeight: 600, color: "#14213D" }}>Your sales</h3>
      {items.length === 0 ? (
        <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>No sales to pay out yet.</p>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
          {items.map((i, n) => {
            const d = describeSettlement(i);
            return (
              <div key={i.purchase_id} className="flex items-center justify-between gap-4 px-4 py-3.5" style={{ background: "#FFFFFF", borderTop: n === 0 ? "none" : "1px solid #EAE8DE" }}>
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: "#14213D", fontWeight: 500 }}>{i.listing_title}</p>
                  <p className="text-xs" style={{ color: "#6B6F76" }}>Sold {when(i.purchased_at)} · {d.detail}</p>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-sm" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{formatPaise(i.share_paise)}</span>
                  <Pill tone={d.tone}>{d.label}</Pill>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="text-xs mt-3" style={{ color: "#6B6F76" }}>
        Amounts are your share after the platform fee. Earnings are paid together once a month, on or around the 1st, to your saved bank account. All sales are final: once a payout is sent it is yours, and it is never taken back. A payout can take a day or two to be recorded here after it is sent.
      </p>
    </div>
  );
}
