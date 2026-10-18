// lib/payments/reconcile.js -- the whole reconciliation pass: disputes first (they protect money), then Route transfers, then UPI payouts (each a no-op while its flag is off).
import { runDisputeSweep } from "./disputes.js";
import { runTransferSweep } from "./transfers.js";
import { runPayoutSweep } from "./vpa-payouts.js";

export async function runReconciliation({ db, rzp, limit = 20, budgetMs = 20000, nowMs = () => Date.now() }) {
  const started = nowMs();
  const disputes = await runDisputeSweep({ db, rzp, limit, budgetMs: Math.floor(budgetMs / 3), nowMs });
  const left = Math.max(0, budgetMs - (nowMs() - started));
  const transfers = await runTransferSweep({ db, rzp, limit, budgetMs: Math.floor(left / 2), nowMs });
  const left2 = Math.max(0, budgetMs - (nowMs() - started));
  const payouts = await runPayoutSweep({ db, rzp, limit, budgetMs: left2, nowMs });
  return { ...transfers, disputes, payouts };
}
