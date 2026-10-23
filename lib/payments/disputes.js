// lib/payments/disputes.js -- acting on disputes (framework-free; db and rzp are injected).
//   resolved_refunded -> refund the buyer (only while phase5_auto_refunds is ON; it is seeded OFF)
// Route transfers are retired, so there is nothing to hold, release or reverse: the old hold / flag / release / reverse actions were
// removed in the Tier 2 clean-up. The DATABASE decides what is needed (plan_refund re-derives it inside a lock and hands out a lease);
// this file only performs the Razorpay call and reports the result. Anything unsafe is parked for a human, never guessed.
const epochNow = () => Math.floor(Date.now() / 1000);
const msg = (r) => `${r.code ?? "error"}${r.description ? `: ${r.description}` : ""}`.slice(0, 300);

async function doRefund({ db, rzp, purchaseId }) {
  const plan = await db.planRefund({ purchaseId });
  if (plan?.outcome !== "claimed") return { action: "refund", outcome: plan?.outcome ?? "unknown" };
  const fail = async (r) => {
    const res = await db.recordRefundFailure({ purchaseId, error: msg(r), retryable: r.retryable });
    return { action: "refund", outcome: res?.outcome === "failed" ? "failed" : "retry_scheduled", code: r.code };
  };
  try {
    // ALWAYS look first: a refund made by hand in the dashboard (or by an attempt that timed out) must be adopted, never repeated.
    const listed = await rzp.listPaymentRefunds(plan.payment_id);
    if (!listed.ok) return await fail(listed);
    if (listed.unreadable > 0) return await fail({ code: "unreadable_refund_list", description: "could not read every existing refund", retryable: true });
    const live = listed.refunds.filter((x) => x.status !== "failed");
    if (live.length > 1) return await fail({ code: "multiple_refunds_at_razorpay", description: `${live.length} refunds on one payment`, retryable: false });
    if (live.length === 1) {
      const x = live[0];
      if (x.amountPaise !== plan.amount_paise) return await fail({ code: "existing_refund_mismatch", description: `existing ${x.id} has a different amount`, retryable: false });
      const applied = await db.applyRefundEvent({ refundId: x.id, purchaseId, status: x.status, amountPaise: x.amountPaise, paymentId: plan.payment_id, eventAt: epochNow(), eventId: null });
      return { action: "refund", outcome: "adopted", refundId: x.id, applied: applied?.outcome };
    }
    const at = epochNow();
    const created = await rzp.createRefund({ paymentId: plan.payment_id, amountPaise: plan.amount_paise, notes: { purchase_id: purchaseId } });
    if (!created.ok) return await fail(created);
    const x = created.refund;
    if (x.amountPaise !== plan.amount_paise || (x.paymentId && x.paymentId !== plan.payment_id)) {
      return await fail({ code: "response_mismatch", description: `razorpay created ${x.id} with unexpected amount/payment`, retryable: false });
    }
    const applied = await db.applyRefundEvent({ refundId: x.id, purchaseId, status: x.status, amountPaise: x.amountPaise, paymentId: plan.payment_id, eventAt: at, eventId: null });
    return { action: "refund", outcome: "created", refundId: x.id, applied: applied?.outcome };
  } catch {
    try { return await fail({ code: "exception", description: "unexpected error while refunding", retryable: true }); }
    catch { return { action: "refund", outcome: "error" }; }
  }
}

const DO = { refund: doRefund };
export const DISPUTE_ACTIONS = Object.keys(DO);
export const performDisputeAction = ({ kind, db, rzp, purchaseId, now = epochNow }) =>
  DO[kind] ? DO[kind]({ db, rzp, purchaseId, now }) : Promise.resolve({ action: kind, outcome: "unknown_kind" });

const IDLE = ["not_needed", "disabled", "not_found"];
/** Do whatever the dispute on ONE purchase needs right now (a refund, if due). Bounded; idempotent. */
export async function syncDisputeForPurchase({ db, rzp, purchaseId, now = epochNow }) {
  const results = [];
  for (let round = 0; round < 4; round++) {
    let progressed = false;
    for (const kind of ["refund"]) {
      const r = await performDisputeAction({ kind, db, rzp, purchaseId, now });
      if (IDLE.includes(r.outcome)) continue;
      results.push(r);
      progressed = r.outcome === "done" || r.outcome === "created" || r.outcome === "adopted";
      break;
    }
    if (!progressed) break;
  }
  return results;
}

/** One bounded pass over everything the database says disputes need. Items are isolated. */
export async function runDisputeSweep({ db, rzp, limit = 20, budgetMs = 10000, nowMs = () => Date.now() }) {
  const started = nowMs();
  const counts = { items: 0, done: 0, retry_scheduled: 0, needs_review: 0, failed: 0, skipped: 0, errors: 0, timeBudgetHit: false };
  const work = await db.listDisputeWork({ limit });
  for (const item of Array.isArray(work) ? work : []) {
    if (nowMs() - started > budgetMs) { counts.timeBudgetHit = true; break; }
    counts.items++;
    try {
      const r = await performDisputeAction({ kind: item.kind, db, rzp, purchaseId: item.purchase_id });
      if (["done", "created", "adopted"].includes(r.outcome)) counts.done++;
      else if (r.outcome === "retry_scheduled") counts.retry_scheduled++;
      else if (r.outcome === "needs_review") counts.needs_review++;
      else if (r.outcome === "failed") counts.failed++;
      else if (r.outcome === "error") counts.errors++;
      else counts.skipped++;
    } catch { counts.errors++; }
  }
  return counts;
}
