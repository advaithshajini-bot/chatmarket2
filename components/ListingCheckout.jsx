"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Unlock, Smartphone, CreditCard, Landmark, Wallet, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

const PAYMENT_METHODS = [
  { id: "upi", label: "UPI", icon: Smartphone, hint: "Pay via any UPI app", razorpayMethod: "upi" },
  { id: "razorpay", label: "Razorpay", icon: Wallet, hint: "Cards, wallets & more", razorpayMethod: undefined },
  { id: "gpay", label: "Google Pay", icon: Wallet, hint: "Fast checkout", razorpayMethod: "upi" },
  { id: "netbanking", label: "Netbanking", icon: Landmark, hint: "All major banks", razorpayMethod: "netbanking" },
  { id: "card", label: "Credit / Debit Card", icon: CreditCard, hint: "Visa, Mastercard, RuPay", razorpayMethod: "card" },
];

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't load the payment widget — check your connection and try again."));
    document.body.appendChild(script);
  });
}

export default function ListingCheckout({ listing }) {
  const router = useRouter();
  const [payment, setPayment] = useState("upi");
  const [paid, setPaid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userInfo, setUserInfo] = useState(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setIsLoggedIn(!!data.user);
      setUserInfo(data.user);
      setCheckingAuth(false);
    });
  }, []);

  const handlePay = async () => {
    if (!isLoggedIn) {
      router.push(`/login?next=/listing/${listing.id}`);
      return;
    }

    setLoading(true);
    setError("");

    try {
      await loadRazorpayScript();

      const orderRes = await fetch("/api/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok) {
        // Already owning this thread isn't really an error state for the buyer.
        if (orderRes.status === 409) {
          setPaid(true);
          setLoading(false);
          return;
        }
        throw new Error(orderData.error || "Couldn't start checkout.");
      }

      const selected = PAYMENT_METHODS.find((m) => m.id === payment);

      const razorpay = new window.Razorpay({
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.orderId,
        name: "chatmarket",
        description: orderData.listingTitle,
        prefill: {
          name: userInfo?.user_metadata?.display_name || "",
          email: userInfo?.email || "",
        },
        method: selected?.razorpayMethod ? { [selected.razorpayMethod]: true } : undefined,
        theme: { color: "#14213D" },
        modal: {
          ondismiss: () => setLoading(false),
        },
        handler: async (response) => {
          try {
            const verifyRes = await fetch("/api/razorpay/verify-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                listingId: listing.id,
                paymentMethod: payment,
              }),
            });
            const verifyData = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(verifyData.error || "Payment couldn't be verified.");
            setPaid(true);
          } catch (err) {
            setError(err.message);
          } finally {
            setLoading(false);
          }
        },
      });

      razorpay.on("payment.failed", (response) => {
        setError(response.error?.description || "Payment failed — you weren't charged.");
        setLoading(false);
      });

      razorpay.open();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
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
