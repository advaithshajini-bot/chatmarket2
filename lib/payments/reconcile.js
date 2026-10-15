// lib/payments/reconcile.js -- the whole reconciliation pass: disputes first (they protect money), then transfers.
import { runDisputeSweep } from "./disputes.js";
import { runTransferSweep } from "./transfers.js";

export async function runReconciliation({ db, rzp, limit = 20, budgetMs = 20000, nowMs = () => Date.now() }) {
  const started = nowMs();
  const disputes = await runDisputeSweep({ db, rzp, limit, budgetMs: Math.floor(budgetMs / 2), nowMs });
  const left = Math.max(0, budgetMs - (nowMs() - started));
  const transfers = await runTransferSweep({ db, rzp, limit, budgetMs: left, nowMs });
  return { ...transfers, disputes };
}
