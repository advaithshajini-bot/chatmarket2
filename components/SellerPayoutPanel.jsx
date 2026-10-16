"use client";

import Link from "next/link";
import { describeStatus, describeAccount } from "@/lib/domain/seller-payouts";
import { formatPaise } from "@/lib/domain/paise";

const MONO = { fontFamily: "'IBM Plex Mono', monospace" };
const TONES = { green: ["#EAF2EF", "#2F6F62"], amber: ["#FBF1DD", "#8A6A18"], red: ["#F6E3E0", "#B33A2E"], grey: ["#E8E7E2", "#6B6F76"] };
const when = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

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

export default function SellerPayoutPanel({ payouts }) {
  const account = describeAccount(payouts?.account_status);
  const s = payouts?.summary || {};
  const items = payouts?.items || [];
  return (
    <div>
      {payouts?.error && <p className="text-sm mb-4" style={{ color: "#B33A2E" }} role="alert">We couldn&apos;t load your payout status just now. Please refresh in a moment.</p>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Pill tone={account.tone}>{account.label}</Pill>
        {account.needsAction && (
          <Link href="/sell/payout" className="text-sm underline" style={{ color: "#14213D" }}>Link your payout account →</Link>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Held" paise={s.held_paise} hint="in the 48-hour window or on hold" />
        <Stat label="On its way" paise={s.releasing_paise} />
        <Stat label="Paid" paise={s.paid_paise} />
        <Stat label="Refunded" paise={s.reversed_paise} />
      </div>
      {s.waiting_paise > 0 && (
        <p className="text-sm mb-4" style={{ color: "#3A3D42" }}>{formatPaise(s.waiting_paise)} is waiting on your payout account or a quick check by our team.</p>
      )}

      {items.length === 0 ? (
        <p className="text-sm text-center py-10" style={{ color: "#6B6F76" }}>No sales to pay out yet.</p>
      ) : (
        <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
          {items.map((i, n) => {
            const d = describeStatus(i);
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
      <p className="text-xs mt-3" style={{ color: "#6B6F76" }}>Amounts are your share after the platform fee. Status is updated as payment updates arrive, so it can trail your bank by a little.</p>
    </div>
  );
}
