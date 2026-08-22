"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Smartphone, CreditCard, Landmark, Wallet, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const PAYMENT_METHODS = [
  { id: "upi", label: "UPI", icon: Smartphone, hint: "Pay via any UPI app" },
  { id: "razorpay", label: "Razorpay", icon: Wallet, hint: "Cards, wallets & more" },
  { id: "gpay", label: "Google Pay", icon: Wallet, hint: "Fast checkout" },
  { id: "netbanking", label: "Netbanking", icon: Landmark, hint: "All major banks" },
  { id: "card", label: "Credit / Debit Card", icon: CreditCard, hint: "Visa, Mastercard, RuPay" },
];

export default function ListingCheckout({ listing }) {
  const router = useRouter();
  const [payment, setPayment] = useState("upi");
  const [paid, setPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setIsLoggedIn(!!data.user);
      setCheckingAuth(false);
    });
  }, []);

  const handlePay = async () => {
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();

    if (!userData.user) {
      router.push(`/login?next=/listing/${listing.id}`);
      return;
    }

    setLoading(true);
    setError("");

    const { error: insertError } = await supabase.from("purchases").insert({
      user_id: userData.user.id,
      listing_id: listing.id,
      amount: listing.price,
      payment_method: payment,
    });

    // 23505 = unique_violation — they already own this thread, which is fine.
    if (insertError && insertError.code !== "23505") {
      setError(insertError.message);
      setLoading(false);
      return;
    }

    setPaid(true);
    setLoading(false);
  };

  return (
    <div className="rounded-md p-5 sticky top-20" style={{ background: "#FFFFFF", border: "1px solid #D8D5C9" }}>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-3xl" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
          ₹{listing.price}
        </span>
        <span className="text-xs" style={{ color: "#6B6F76" }}>platform fee included</span>
      </div>
      <p className="text-xs mb-4" style={{ color: "#6B6F76" }}>
        Unlocks the full {listing.messages}-message thread for your account only
      </p>

      {paid ? (
        <div
          className="flex items-center gap-2 px-3 py-3 rounded text-sm"
          style={{ background: "#EAF2EF", color: "#2F6F62", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <Unlock size={16} /> Unlocked — check your{" "}
          <Link href="/library" style={{ textDecoration: "underline" }}>library</Link>
        </div>
      ) : (
        <>
          <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Pay with
          </p>
          <div className="space-y-2 mb-4">
            {PAYMENT_METHODS.map((m) => {
              const Icon = m.icon;
              const active = payment === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => setPayment(m.id)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded text-sm transition-colors"
                  style={{
                    border: active ? "1.5px solid #14213D" : "1px solid #D8D5C9",
                    background: active ? "#EDEEEA" : "#FFFFFF",
                    fontFamily: "'IBM Plex Sans', sans-serif",
                    color: "#14213D",
                  }}
                >
                  <span className="flex items-center gap-2">
                    <Icon size={15} />
                    {m.label}
                  </span>
                  {active ? <Check size={15} color="#2F6F62" /> : (
                    <span className="text-xs" style={{ color: "#6B6F76" }}>{m.hint}</span>
                  )}
                </button>
              );
            })}
          </div>

          {error && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{error}</p>}

          <button
            onClick={handlePay}
            disabled={loading || checkingAuth}
            className="w-full py-3 rounded text-sm font-medium"
            style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
          >
            {loading ? "Processing..." : !isLoggedIn && !checkingAuth ? `Log in to pay ₹${listing.price}` : `Pay ₹${listing.price} & unlock`}
          </button>
          <p className="text-[11px] mt-2 text-center" style={{ color: "#6B6F76" }}>
            Funds held for 48 hrs after unlock in case of a dispute
          </p>
        </>
      )}
    </div>
  );
}
