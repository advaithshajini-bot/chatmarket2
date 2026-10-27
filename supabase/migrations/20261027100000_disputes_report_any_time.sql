-- "Report an issue" is open at any time after a purchase (like a review). All sales are final: a report is reviewed by the chatmarket team and
-- never creates a refund by itself. This replaces ONE row-level-security policy: the 48-hour limit is removed, every other condition is unchanged
-- (the buyer files only as themselves, only on their own PAID purchase).
-- Rollback: recreate the policy with the extra condition  and pu.purchased_at > now() - interval '48 hours'  (see the baseline migration).
drop policy "Buyers can file a dispute on their own paid purchase" on public.disputes;
create policy "Buyers can file a dispute on their own paid purchase" on public.disputes for insert to authenticated
  with check (
    (select auth.uid()) = buyer_id
    and exists (select 1 from public.purchases pu where pu.id = purchase_id and pu.user_id = (select auth.uid()) and pu.status = 'paid')
  );
