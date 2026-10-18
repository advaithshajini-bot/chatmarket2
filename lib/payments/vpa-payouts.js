// lib/payments/vpa-payouts.js -- instant UPI payouts (framework-free; db and rzp are injected).
//
// Safety model (a seller must never be paid twice for one purchase):
//   1. plan_vpa_payout() claims the purchase in the database (unique purchase_id) BEFORE Razorpay is called.
//   2. A payout is only created by a call that holds that claim, with X-Payout-Idempotency = payout_key.
//   3. If a previous attempt may have reached Razorpay (lookup_first) we LIST payouts by reference_id (= payout_key) first and adopt.
//   4. Everything Razorpay tells us afterwards goes through apply_vpa_payout_event(): idempotent and forward-only.
// There is no hold, no dispute reaction and no clawback here: a payout is final, and nothing in this file ever debits a seller.
const epochNow = () => Math.floor(Date.now() / 1000);

const asEvent = (p, purchaseId, eventAt) => ({
  payoutId: p.id, purchaseId, status: p.status, utr: p.utr, eventAt, amountPaise: p.amountPaise, reason: p.reason, eventId: null,
});

export async function payoutPurchase({ db, rzp, purchaseId, now = epochNow }) {
  const plan = await db.planVpaPayout({ purchaseId });
  if (plan?.outcome !== "claimed") return { outcome: plan?.outcome ?? "unknown" };

  const fail = async (r) => {
    const res = await db.recordVpaPayoutFailure({ purchaseId, error: `${r.code ?? "error"}${r.description ? `: ${r.description}` : ""}`.slice(0, 300), retryable: r.retryable });
    return { outcome: res?.outcome === "failed" ? "failed" : "retry_scheduled", code: r.code };
  };

  try {
    if (plan.lookup_first) {
      const at = now();
      const listed = await rzp.listPayoutsByReference(plan.payout_key);
      if (!listed.ok) return await fail(listed);
      if (listed.unreadable > 0) return await fail({ code: "unreadable_payout_list", description: "could not read every existing payout", retryable: true });
      if (listed.payouts.length > 1) return await fail({ code: "duplicate_payouts_at_razorpay", description: `${listed.payouts.length} payouts for one reference`, retryable: false });
      if (listed.payouts.length === 1) {
        const p = listed.payouts[0];
        if (p.amountPaise !== plan.amount_paise) return await fail({ code: "existing_payout_mismatch", description: `existing ${p.id} has a different amount`, retryable: false });
        const applied = await db.applyVpaPayoutEvent(asEvent(p, purchaseId, at));
        return { outcome: "adopted", payoutId: p.id, applied: applied?.outcome };
      }
    }

    let fundAccountId = plan.fund_account_id;
    if (!fundAccountId) {
      let contactId = plan.contact_id;
      if (!contactId) {
        const c = await rzp.createContact({ name: plan.seller_name, referenceId: plan.seller_id });
        if (!c.ok) return await fail(c);
        contactId = c.contactId;
      }
      const f = await rzp.createVpaFundAccount({ contactId, vpa: plan.vpa });
      if (!f.ok) return await fail(f);
      if (f.vpa && f.vpa.toLowerCase() !== plan.vpa) return await fail({ code: "fund_account_mismatch", description: "fund account has a different UPI ID", retryable: false });
      const rec = await db.recordVpaFundAccount({ sellerId: plan.seller_id, vpa: plan.vpa, contactId, fundAccountId: f.fundAccountId });
      if (rec?.outcome !== "ok") return await fail({ code: "vpa_changed", description: "seller changed UPI ID during payout", retryable: false });
      fundAccountId = f.fundAccountId;
    }

    const at = now();
    const created = await rzp.createVpaPayout({
      fundAccountId, amountPaise: plan.amount_paise, referenceId: plan.payout_key, idempotencyKey: plan.payout_key,
      notes: { purchase_id: purchaseId },
    });
    if (!created.ok) return await fail(created);
    const p = created.payout;
    if (p.amountPaise !== plan.amount_paise || (p.fundAccountId && p.fundAccountId !== fundAccountId)) {
      return await fail({ code: "response_mismatch", description: `razorpay created ${p.id} with unexpected amount/destination`, retryable: false });
    }
    const applied = await db.applyVpaPayoutEvent(asEvent(p, purchaseId, at));
    return { outcome: "created", payoutId: p.id, applied: applied?.outcome };
  } catch {
    try { return await fail({ code: "exception", description: "unexpected error while creating the payout", retryable: true }); }
    catch { return { outcome: "error" }; }
  }
}

export async function pollPayout({ db, rzp, purchaseId, payoutId, now = epochNow }) {
  const at = now();
  const r = await rzp.fetchPayout(payoutId);
  if (!r.ok) return { outcome: r.retryable ? "poll_retry_later" : "poll_failed", code: r.code };
  const applied = await db.applyVpaPayoutEvent(asEvent(r.payout, purchaseId, at));
  return { outcome: "polled", applied: applied?.outcome };
}

export async function runPayoutSweep({ db, rzp, limit = 20, budgetMs = 20000, nowMs = () => Date.now() }) {
  const started = nowMs();
  const counts = { items: 0, created: 0, adopted: 0, polled: 0, retry_scheduled: 0, failed: 0, skipped: 0, errors: 0, timeBudgetHit: false };
  const work = await db.listVpaPayoutWork({ limit });
  for (const item of Array.isArray(work) ? work : []) {
    if (nowMs() - started > budgetMs) { counts.timeBudgetHit = true; break; }
    counts.items++;
    try {
      if (item.kind === "create") {
        const r = await payoutPurchase({ db, rzp, purchaseId: item.purchase_id });
        if (r.outcome === "created") counts.created++;
        else if (r.outcome === "adopted") counts.adopted++;
        else if (r.outcome === "retry_scheduled") counts.retry_scheduled++;
        else if (r.outcome === "failed") counts.failed++;
        else if (r.outcome === "error") counts.errors++;
        else counts.skipped++;
      } else if (item.kind === "poll") {
        const r = await pollPayout({ db, rzp, purchaseId: item.purchase_id, payoutId: item.razorpay_payout_id });
        if (r.outcome === "polled") counts.polled++; else counts.skipped++;
      } else counts.skipped++;
    } catch { counts.errors++; }
  }
  return counts;
}
