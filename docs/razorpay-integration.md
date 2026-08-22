# ChatMarket — Razorpay Integration Guide

Razorpay's relevant product here is **Route** — built specifically for marketplaces that need to split a single payment between the platform (your commission) and multiple sellers, with each seller getting their own linked sub-account. This maps directly onto the `transactions` table from the data model doc.

---

## 1. How the pieces fit together

```
Buyer pays ₹499
      │
      ▼
Razorpay Order created (your platform account)
      │
      ▼
Buyer completes checkout (UPI / card / netbanking / wallet)
      │
      ▼
payment.captured webhook fires
      │
      ▼
Route: transfer ₹499 → seller's linked account, minus your commission
      │            (held on_hold for 48 hrs — your dispute window)
      ▼
transfer.processed webhook fires → funds settle to seller's bank
```

Razorpay takes care of the split and the hold; you don't need to build your own ledger for "who owes whom."

---

## 2. Setup steps

1. **Create a Razorpay Business account** and complete KYC for ChatMarket itself.
2. **Enable Route** in the Razorpay dashboard (Account & Settings → Route) — this is a separate activation from standard payments.
3. **Onboard each seller as a Linked Account.** This is the part that needs their own KYC (PAN, bank account, business type) before they can receive a transfer. Until a seller completes this, their listings can go live but payouts stay pending — surface this clearly in the seller dashboard ("Complete payout setup to receive earnings").
4. **Set your commission** as a fixed percentage taken automatically at transfer time, so you never have to manually reconcile it.

---

## 3. Backend: creating an order

```javascript
// server/razorpay.js
const Razorpay = require("razorpay");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// POST /api/checkout/:listingId
app.post("/api/checkout/:listingId", async (req, res) => {
  const listing = await db.listings.findById(req.params.listingId);
  const buyer = req.user;

  const order = await razorpay.orders.create({
    amount: listing.price_cents,       // in paise
    currency: "INR",
    receipt: `listing_${listing.id}_buyer_${buyer.id}`,
    notes: {
      listing_id: listing.id,
      seller_id: listing.seller_id,
      buyer_id: buyer.id,
    },
  });

  // Store a pending transaction row before redirecting to checkout
  await db.transactions.create({
    listing_id: listing.id,
    buyer_id: buyer.id,
    seller_id: listing.seller_id,
    amount_cents: listing.price_cents,
    platform_fee_cents: Math.round(listing.price_cents * 0.18), // 18% commission
    razorpay_order_id: order.id,
    status: "created",
  });

  res.json({ orderId: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID });
});
```

---

## 4. Frontend: Checkout.js

Razorpay's checkout modal auto-shows UPI, cards, netbanking, and wallets — you don't configure each one separately.

```javascript
// Load once: <script src="https://checkout.razorpay.com/v1/checkout.js"></script>

async function payForListing(listingId) {
  const res = await fetch(`/api/checkout/${listingId}`, { method: "POST" });
  const { orderId, amount, key } = await res.json();

  const options = {
    key,
    amount,
    currency: "INR",
    name: "chatmarket",
    description: "Unlock this thread",
    order_id: orderId,
    handler: async function (response) {
      // response contains razorpay_payment_id, razorpay_order_id, razorpay_signature
      await fetch("/api/checkout/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });
      window.location.href = `/library`; // unlocked content now visible
    },
    theme: { color: "#14213D" },
  };

  const rzp = new window.Razorpay(options);
  rzp.open();
}
```

---

## 5. Backend: verifying payment + triggering the split transfer

**Never unlock content just because the frontend called `handler`** — always verify the signature server-side before granting access.

```javascript
const crypto = require("crypto");

app.post("/api/checkout/verify", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  const txn = await db.transactions.findByOrderId(razorpay_order_id);
  const listing = await db.listings.findById(txn.listing_id);
  const seller = await db.users.findById(txn.seller_id);

  // Create the Route transfer, held for your dispute window
  const transfer = await razorpay.transfers.create({
    account: seller.razorpay_linked_account_id,
    amount: txn.amount_cents - txn.platform_fee_cents,
    currency: "INR",
    on_hold: true,
    on_hold_until: Math.floor(Date.now() / 1000) + 60 * 60 * 48, // 48 hrs
  });

  await db.transactions.update(txn.id, {
    status: "held",
    razorpay_payment_id,
    razorpay_transfer_id: transfer.id,
    unlocked_at: new Date(),
  });

  await db.listings.update(listing.id, { status: "sold_unlocked_for_buyer" });

  res.json({ success: true });
});
```

---

## 6. Webhooks

Set these up in the Razorpay dashboard (Settings → Webhooks) pointing at one endpoint. Always verify the webhook signature — it's separate from the checkout signature above.

```javascript
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest("hex");

  if (signature !== expected) return res.status(400).send("Invalid signature");

  const event = JSON.parse(req.body);

  switch (event.event) {
    case "payment.captured":
      // Confirms funds actually landed — useful as a backup to the /verify call
      break;

    case "transfer.processed":
      // The 48-hr hold has released and money reached the seller's linked account
      await db.transactions.updateByTransferId(event.payload.transfer.entity.id, {
        status: "released",
      });
      break;

    case "payment.failed":
      await db.transactions.updateByOrderId(event.payload.payment.entity.order_id, {
        status: "failed",
      });
      break;
  }

  res.json({ received: true });
});
```

---

## 7. Handling disputes before the hold releases

If a buyer files a dispute inside your 48-hour window (via your own `disputes` table), cancel or reverse the transfer before Razorpay auto-releases it:

```javascript
// Only works while on_hold is still true
await razorpay.transfers.edit(transfer.id, { on_hold: true, on_hold_until: newLaterTimestamp });
// or, for a full refund back to the buyer:
await razorpay.payments.refund(razorpay_payment_id, { amount: txn.amount_cents });
```

Build a small admin view where you can see open disputes and trigger this manually — don't automate refund decisions until you have enough transaction volume to trust rules over human judgment.

---

## 8. Updated `transactions` table fields

Add these to the schema from the earlier data model doc:

```sql
ALTER TABLE transactions
  ADD COLUMN razorpay_order_id TEXT,
  ADD COLUMN razorpay_payment_id TEXT,
  ADD COLUMN razorpay_transfer_id TEXT;

ALTER TABLE users
  ADD COLUMN razorpay_linked_account_id TEXT;
```

---

## 9. Testing

Razorpay provides a full test mode with dummy UPI IDs, test card numbers, and simulated netbanking — no real money moves. Test the full loop before going live:
1. Create order → pay with a test UPI ID → verify signature → transfer created with `on_hold: true`
2. Manually trigger `transfer.processed` in test mode to confirm your webhook updates `status: released` correctly
3. Test a refund mid-hold to confirm the dispute path works before a real buyer ever needs it
