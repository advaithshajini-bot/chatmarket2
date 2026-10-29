# Archive: retired payment runbooks

These documents describe payment mechanisms that are **no longer used**. They are kept as a record of what was built and applied, not as instructions.

| File | What it covered | Retired by |
|---|---|---|
| `phase5_2_review_golive.md` | Route transfers: ledger, creation, sweep | Tier 2 clean-up |
| `phase5_2c_review_golive.md` | Disputes -> transfer hold / reverse, and refunds (the refund side is still in code, flag `phase5_auto_refunds` OFF) | Tier 2 clean-up |
| `phase5_2c_schedule_sweep.sql` | `pg_cron` job calling the reconciliation sweep. **Never schedule it**: the sweep route no longer exists | Tier 2 clean-up |
| `phase6_route_validation_runbook.md` | Validating Route against Razorpay in test mode | Tier 2 clean-up |
| `phase6_flag_rollout.md` | Flag rollout order for Route and UPI payouts | Tier 1 + 2 clean-up |
| `phase6_upi_payouts_golive.md` | RazorpayX instant UPI payouts | Tier 1 clean-up |

Current process: `../phase7_monthly_settlement_runbook.md`. `../schedule_sweep_stale_runs.sql` (Phase 3 agent runs) is unrelated and stays where it is.
The database objects these documents describe (tables, functions, flags) still exist and are dormant; dropping them would be a separate, explicitly approved migration.
