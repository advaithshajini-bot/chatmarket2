"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Info, Lock } from "lucide-react";
import TopNav from "@/components/TopNav";
import BankPayoutForm from "@/components/BankPayoutForm";
import { createClient } from "@/lib/supabase/client";
import { getMyBankPayout } from "@/lib/domain/bank-payout";

// The one payout screen: permanent bank details, whatever the payment flags say. Earnings are paid by hand (IMPS / NEFT) once a month.
// There is no UPI ID field here any more.
export default function PayoutPage() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [saved, setSaved] = useState(null);

  const reload = async () => setSaved(await getMyBankPayout(supabase));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!live) return;
        setUserId(user?.id ?? null);
        if (user) { const s = await getMyBankPayout(supabase); if (live) setSaved(s); }
      } catch { /* shows the empty form */ }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-10 max-w-xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>Get paid monthly</h1>
        <p className="text-sm mb-6" style={{ color: "#3A3D42" }}>
          Save your bank account once and we&apos;ll pay your share of every sale to it by bank transfer in one monthly payout, around the 1st of each month. You need this before you can list.
        </p>
        {loading ? (
          <p className="text-sm" style={{ color: "#6B6F76" }}><Loader2 size={14} className="inline animate-spin mr-1" /> Loading…</p>
        ) : !userId ? (
          <div className="rounded-md p-5 text-center" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
            <Lock size={20} color="#6B6F76" className="mx-auto mb-2" />
            <p className="text-sm mb-3" style={{ color: "#6B6F76" }}>Log in to add your bank details.</p>
            <Link href="/login?next=/sell/payout" style={{ color: "#14213D", fontWeight: 500 }}>Log in →</Link>
          </div>
        ) : (
          <BankPayoutForm saved={saved} onSaved={reload} />
        )}
        <div className="rounded-md p-4 mt-8 flex gap-3" style={{ background: "#FBF1DD", border: "1px solid #E9D9AA" }}>
          <Info size={16} color="#8A6A18" className="shrink-0 mt-0.5" />
          <div className="text-sm" style={{ color: "#3A3D42" }}>
            <p className="mb-1" style={{ fontWeight: 600, color: "#14213D" }}>All sales are final.</p>
            <p>Earnings are paid together once a month and can&apos;t be recalled once sent. Please double-check your account number and IFSC: money sent to a wrong account can&apos;t be brought back. If you change your bank details, the new account waits a short while before it can be paid. We never take a payout back from you.</p>
          </div>
        </div>
        <p className="text-sm mt-6"><Link href="/sell/earnings" className="underline" style={{ color: "#14213D" }}>See your earnings and payout status →</Link></p>
      </main>
    </div>
  );
}
