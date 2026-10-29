# Phase 6 · Feature-flag rollout order, verification and rollback

All flags live in `private.feature_flags` (fail-closed: a missing row or any lookup problem means OFF). They are read **fresh on every call**, so a flip or a rollback
takes effect on the next request; no redeploy. Run SQL in the Supabase SQL editor as the project owner. **Every flag is OFF today. Flip one at a time, verify, wait, then the next.**

```sql
select name, enabled, updated_at from private.feature_flags order by name;   -- the dashboard of record
-- flip:      update private.feature_flags set enabled = true,  updated_at = now() where name = '<flag>';
-- rollback:  update private.feature_flags set enabled = false, updated_at = now() where name = '<flag>';
```

## Two independent tracks
The five flags form two tracks that do not depend on each other. Run the **money track first** (it needs `phase6_route_validation_runbook.md` Part A/B anyway); the
**execution track** adds Anthropic spend and a worker, so it can go before or after. Within a track the order matters.

| Track | Order | Why |
|---|---|---|
| Execution | 1 `phase3_execution` → 2 `phase4_approvals` → 3 `phase4_demo` | approvals and demos both run through the Phase 3 claim path; without `phase3_execution` they are refused |
| Money | 4 `phase5_route_transfers` → 5 `phase5_auto_refunds` | a refund is only automatic after transfers (and their reversal) are proven |

Between flips: wait at least one full day of real traffic (or a full rehearsal) and look at Needs attention (`/admin/payments`, badge on `/admin`).

---
## 1 · `phase3_execution` (runs workflows/agents)
**Needs:** the `execution-worker` edge function deployed; `supabase secrets set ANTHROPIC_API_KEY=…` only if demos will be used (step 3). No Deno suite has been run in my environment: run `node tests/phase4/run-all.mjs` where Deno is available first.
**Before:** `node tests/phase4/run-all.mjs` green; pg_cron job `sweep-stale-runs` scheduled (`supabase/manual/schedule_sweep_stale_runs.sql`).
**Flip:** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase3_execution';`
**Verify:** start a run of a simple workflow listing you own → it reaches `succeeded`; `select status, error, count(*) from runs where created_at > now() - interval '1 hour' group by 1,2;` has no unexpected `failed`. Worker logs no longer show `claim outcome: rejected execution_disabled`.
**Watch:** stuck `running` rows (the sweep should clear them). **WARNING:** with this ON and `phase4_approvals` OFF, any run whose steps declare `tool.permission` **fails closed** (`approvals_disabled`); list who is affected first (`phase4_approvals_activation.sql` step 1).
**Rollback:** set it `false`. New runs are refused (`execution_disabled`); in-flight runs finish or are swept.

## 2 · `phase4_approvals` (human approval for permissioned steps)
**Needs:** `phase3_execution` ON. The approval-expiry sweep scheduled: `select cron.schedule('expire-pending-approvals', '* * * * *', $$select private.expire_pending_approvals()$$);` (see `phase4_approvals_activation.sql`, steps 1–2).
**Flip:** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase4_approvals';`
**Verify:** run a listing with a permissioned step → it pauses for approval; approve it as the owner → it continues; reject → it fails closed; leave one unanswered → it expires after 24 h.
**Rollback:** `false`. Gated steps with no approval fail closed; pending approvals stay pending (approving refused, rejecting and the expiry sweep still work); already-approved steps still run.

## 3 · `phase4_demo` (try-before-you-buy, costs real Anthropic money)
**Needs:** `phase3_execution` ON; a **dedicated** `ANTHROPIC_API_KEY` secret with a monthly spend limit in the Anthropic console; model prices verified (`select * from private.model_pricing;` and `phase4_demo_activation.sql` step 0); caps reviewed (`select * from private.demo_settings;`: Rs3/run, Rs500/day, 3 runs/user/day by default); at least one seller demo approved by an admin with MFA.
**Flip:** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase4_demo';`
**Verify:** as a non-admin buyer, run one demo → succeeds, `select count(*), sum(cost) from runs where is_demo and created_at > now() - interval '1 hour';` shows the cost, under the caps; the 4th run in 24 h is refused. This is the old "4.4 interactive demo smoke test".
**Kill switches (any one):** flag `false`; `update private.demo_settings set value = 0 where key = 'global_daily_budget_inr';`; revoke/rotate `ANTHROPIC_API_KEY`.

## 4 · `phase5_route_transfers` (pay sellers through Route)
**Needs:** `phase6_route_validation_runbook.md` Part A (shapes confirmed) and Part B1–B3, B6 passed in TEST mode; `CRON_SECRET` set; the minute-level sweep scheduled (`phase5_2c_schedule_sweep.sql`, read it first, call the sweep by hand once and see `{"ok":true}`); admin has linked sellers (`/admin/payments`); webhooks subscribed (`transfer.*`, `refund.*`).
**Flip (test mode first, then live keys only at the very end of Phase 6):** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase5_route_transfers';`
**Verify:** one real small purchase: transfer row `created`, `on_hold` true, seller sees "Held until …", `purchases.transfer_status = 'held'`; Needs attention empty; `select * from webhook_events where status in ('needs_review','failed');` empty.
**Watch (daily):** the `/admin` Payments badge; `select purchase_id, status, attempts, error from transfers where status in ('creating','failed');`
**Rollback:** `false`. No new transfers are created; events for existing transfers are still recorded; dispute **holds and reversals** still run (they are protective); **releases** pause (they need this flag), so held money stays held, never paid out early. Transfers already at Razorpay stay (undo in the dashboard).

## 5 · `phase5_auto_refunds` (buyer refund after a reversed transfer)
**Needs:** flag 4 proven in live use for a while; Part A7/A9 answered and B5 passed; you are comfortable the full-amount refund policy matches your terms (partial refunds are not automated).
**Flip:** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase5_auto_refunds';`
**Verify:** the next refunded dispute produces `select status, razorpay_refund_id, error from refunds order by created_at desc limit 3;` → `pending` → `processed`; never more than one row per purchase; nothing in Needs attention.
**Rollback:** `false`. Refunded disputes still reverse the transfer; the refund becomes a manual step in the Razorpay dashboard. A refund already created at Razorpay cannot be undone here.

---
## Combined emergency stop (money)
```sql
update private.feature_flags set enabled = false, updated_at = now() where name in ('phase5_route_transfers', 'phase5_auto_refunds');
select cron.unschedule('route-reconciliation-sweep');   -- only if you scheduled it; stops the minute sweep
```
## Combined emergency stop (spend)
```sql
update private.feature_flags set enabled = false, updated_at = now() where name in ('phase4_demo', 'phase3_execution');
```
## Record keeping
After each flip, note the date/time, the SQL you ran, and the verification result in your own log. `private.feature_flags.updated_at` records only the last change.

---
## 6 · `phase6_vpa_payouts` (instant UPI payouts, Milestone 5.4) — REPLACES the Route flags for money
The 5.4 pivot makes the Route track optional. **Do not run both.** `phase6_vpa_payouts` and `phase5_route_transfers` are mutually exclusive in the database: with both ON, **neither runs** (check `select private.is_vpa_payouts_enabled(), private.is_route_transfers_enabled();` both false). `phase5_auto_refunds` is not part of the UPI model (all sales are final); leave it OFF.
**Needs:** everything in `supabase/manual/phase6_upi_payouts_golive.md` (RazorpayX test-mode validation, funded RazorpayX balance, `RAZORPAYX_ACCOUNT_NUMBER`, IP allowlisting, `payout.*` webhooks). Without validation against a real RazorpayX account this flag must stay OFF.
**Before:** `update private.vpa_payout_config set cutoff_at = now() where id;` (otherwise nothing is eligible: that is the safe default).
**Flip:** `update private.feature_flags set enabled = true, updated_at = now() where name = 'phase6_vpa_payouts';`
**Verify:** one small real sale → `select status, utr, amount_paise from vpa_payouts order by created_at desc limit 5;` shows `processed` with a UTR; `/sell/earnings` says "Instant payout: Paid".
**Watch:** Needs attention (`payout_failed`, `payout_queued` = RazorpayX balance low, `payout_returned` = bank returned the money, `payout_parked` = over the cap).
**Rollback:** set it `false` (new payouts stop; in-flight ones are still polled). A seller can be stopped with Pause on `/admin/payments`. Money already sent cannot be recalled.
