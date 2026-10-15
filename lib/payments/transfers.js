// lib/payments/transfers.js -- creating and reconciling Route transfers (framework-free; db and rzp are injected).
//
// Safety model (a seller must never be paid twice for one purchase):
//   1. plan_transfer() claims the purchase in the database (unique purchase_id) BEFORE Razorpay is called.
//   2. A transfer is only ever created by a call that holds that claim.
//   3. If a previous attempt may have reached Razorpay (timeout / crash) the claim says lookup_first: we LIST the
//      payment's transfers and adopt the existing one instead of creating another.
//   4. Everything Razorpay tells us afterwards goes through apply_transfer_event(): idempotent and forward-only.
const epochNow = () => Math.floor(Date.now() / 1000);

const asEvent = (t, purchaseId, eventAt) => ({
  transferId: t.id, purchaseId, status: t.status, settlementStatus: t.settlementStatus, onHold: t.onHold,
  amountReversedPaise: t.amountReversedPaise, eventAt, amountPaise: t.amountPaise, recipient: t.recipient, eventId: null,
});

export async function createTransferForPurchase({ db, rzp, purchaseId, now = epochNow }) {
  const plan = await db.planTransfer({ purchaseId });
  if (plan?.outcome !== "claimed") return { outcome: plan?.outcome ?? "unknown" };

  const fail = async (r) => {
    const res = await db.recordTransferFailure({ purchaseId, error: `${r.code ?? "error"}${r.description ? `: ${r.description}` : ""}`.slice(0, 300), retryable: r.retryable });
    return { outcome: res?.outcome === "failed" ? "failed" : "retry_scheduled", code: r.code };
  };

  try {
    if (plan.lookup_first) {
      const at = now();
      const listed = await rzp.listPaymentTransfers(plan.payment_id);
      if (!listed.ok) return await fail(listed);
      if (listed.unreadable > 0) return await fail({ code: "unreadable_transfer_list", description: "could not read every existing transfer", retryable: true });
      const mine = listed.transfers.filter((t) => t.recipient === plan.account_id && (t.purchaseId === purchaseId || t.purchaseId === null));
      if (mine.length > 1) return await fail({ code: "duplicate_transfers_at_razorpay", description: `${mine.length} transfers for one payment`, retryable: false });
      if (mine.length === 1) {
        const t = mine[0];
        if (t.amountPaise !== plan.amount_paise) return await fail({ code: "existing_transfer_mismatch", description: `existing ${t.id} has a different amount`, retryable: false });
        const applied = await db.applyTransferEvent(asEvent(t, purchaseId, at));
        return { outcome: "adopted", transferId: t.id, applied: applied?.outcome };
      }
    }

    if (plan.adopt_only) {
      // The dispute was resolved in the buyer's favour while this creation was pending, and nothing exists at Razorpay: stop here.
      return await fail({ code: "refunded_before_transfer", description: "dispute refunded; no transfer will be created", retryable: false });
    }
    const at = now();
    const created = await rzp.createTransfer({
      paymentId: plan.payment_id, account: plan.account_id, amountPaise: plan.amount_paise,
      onHold: plan.on_hold, holdUntilEpoch: plan.hold_until_epoch, notes: { purchase_id: purchaseId },
    });
    if (!created.ok) return await fail(created);
    const t = created.transfer;
    if (t.amountPaise !== plan.amount_paise || (t.recipient && t.recipient !== plan.account_id)) {
      // Razorpay created something that is not what we asked for. Do not record it as ours; make it loud.
      return await fail({ code: "response_mismatch", description: `razorpay created ${t.id} with unexpected amount/recipient`, retryable: false });
    }
    const applied = await db.applyTransferEvent(asEvent(t, purchaseId, at));
    return { outcome: "created", transferId: t.id, applied: applied?.outcome };
  } catch {
    try { return await fail({ code: "exception", description: "unexpected error while creating the transfer", retryable: true }); }
    catch { return { outcome: "error" }; }
  }
}

export async function pollTransfer({ db, rzp, purchaseId, transferId, now = epochNow }) {
  const at = now();                       // taken BEFORE the request: a webhook that lands later is newer than this
  const r = await rzp.fetchTransfer(transferId);
  if (!r.ok) return { outcome: r.retryable ? "poll_retry_later" : "poll_failed", code: r.code };
  const applied = await db.applyTransferEvent(asEvent(r.transfer, purchaseId, at));
  return { outcome: "polled", applied: applied?.outcome };
}

/** One bounded reconciliation pass. Items are isolated: one failure never stops the rest. */
export async function runTransferSweep({ db, rzp, limit = 20, budgetMs = 20000, nowMs = () => Date.now() }) {
  const started = nowMs();
  const counts = { items: 0, created: 0, adopted: 0, polled: 0, retry_scheduled: 0, failed: 0, skipped: 0, errors: 0, timeBudgetHit: false };
  const work = await db.listTransferWork({ limit });
  for (const item of Array.isArray(work) ? work : []) {
    if (nowMs() - started > budgetMs) { counts.timeBudgetHit = true; break; }
    counts.items++;
    try {
      if (item.kind === "create") {
        const r = await createTransferForPurchase({ db, rzp, purchaseId: item.purchase_id });
        if (r.outcome === "created") counts.created++;
        else if (r.outcome === "adopted") counts.adopted++;
        else if (r.outcome === "retry_scheduled") counts.retry_scheduled++;
        else if (r.outcome === "failed") counts.failed++;
        else if (r.outcome === "error") counts.errors++;
        else counts.skipped++;
      } else if (item.kind === "poll") {
        const r = await pollTransfer({ db, rzp, purchaseId: item.purchase_id, transferId: item.razorpay_transfer_id });
        if (r.outcome === "polled") counts.polled++; else counts.skipped++;
      } else counts.skipped++;
    } catch {
      counts.errors++;
    }
  }
  return counts;
}
