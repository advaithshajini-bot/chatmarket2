-- Milestone 5.3 (part 2): the seller's own payout status, in plain terms.
--
-- ADDITIVE and READ-ONLY. One new function: public.seller_payout_status(integer). No table, column, flag or existing function changes.
--
-- It returns ONLY the calling seller's own sales, each with a status CODE (never free text from the ledger) and dates/amounts:
--   needs_account  no payout account on file yet          account_pending  account being set up
--   queued         account active, payout not started     processing       payout in progress (includes transient failures)
--   held           inside the dispute window (release_date)               dispute         a buyer's dispute is open
--   releasing      hold ended, money on its way           paid             settled to the seller
--   reversed       refunded / reversed                    under_review     our team is looking at it (parked, or account suspended)
-- It NEVER returns: Razorpay ids (account, payment, transfer, refund), transfers.error, transfers.review_reason, attempts,
-- the dispute reason or note, buyer identity, or webhook data. Amounts are integer paise (seller share = amount - platform fee).
--
-- Security: SECURITY DEFINER, search_path = '', identity from auth.uid() ONLY (there is no seller parameter, so a caller cannot ask
-- about anyone else). Anonymous callers get 42501. Granted to authenticated only. Error code CM074 (invalid input).
--
-- Rollback: drop function public.seller_payout_status(integer);

create function public.seller_payout_status(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_account text;
  v_items   jsonb;
  v_summary jsonb;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'login_required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = 'CM074', message = 'invalid_payout_status_input';
  end if;

  select a.status into v_account from public.seller_payout_accounts a where a.user_id = v_uid;

  with s as (
    select p.id as purchase_id, p.purchased_at, l.title as listing_title,
           (round(p.amount * 100) - round(coalesce(p.platform_fee, 0) * 100))::bigint as share,
           p.status as pstatus,
           t.id as tid, t.status as tstatus, t.settlement_status, t.on_hold, t.hold_until, t.review_reason, t.amount_reversed_paise,
           d.status as dstatus
      from public.purchases p
      join public.listings l on l.id = p.listing_id
      left join public.transfers t on t.purchase_id = p.id
      left join public.disputes d on d.purchase_id = p.id
     where l.seller_id = v_uid
       and p.razorpay_payment_id is not null
  ),
  c as (
    select s.*,
      case
        when s.pstatus = 'refunded' or s.tstatus = 'reversed'                                  then 'reversed'
        when s.dstatus = 'open'                                                                then 'dispute'
        when s.tid is null and v_account is null                                               then 'needs_account'
        when s.tid is null and v_account = 'pending'                                           then 'account_pending'
        when s.tid is null and v_account = 'suspended'                                         then 'under_review'
        when s.tid is null                                                                     then 'queued'
        when s.review_reason is not null                                                       then 'under_review'
        when s.tstatus in ('creating', 'failed')                                               then 'processing'
        when s.settlement_status = 'settled'                                                   then 'paid'
        when s.on_hold and s.hold_until is not null and s.hold_until > now()                   then 'held'
        when s.on_hold and s.hold_until is null                                                then 'processing'
        else 'releasing'
      end as code
    from s
  )
  select
    coalesce((select jsonb_agg(x.j order by x.purchased_at desc, x.purchase_id)
                from (
                  select c.purchased_at, c.purchase_id,
                         jsonb_build_object(
                           'purchase_id', c.purchase_id, 'listing_title', c.listing_title, 'purchased_at', c.purchased_at,
                           'status', c.code, 'share_paise', c.share,
                           'reversed_paise', case when c.code = 'reversed' then c.share else coalesce(c.amount_reversed_paise, 0) end,
                           'release_date', case when c.code = 'held' then c.hold_until else null end) as j
                    from c
                   order by c.purchased_at desc, c.purchase_id
                   limit p_limit
                ) x), '[]'::jsonb),
    (select jsonb_build_object(
        'held_paise',      coalesce(sum(c.share) filter (where c.code in ('held', 'dispute')), 0),
        'releasing_paise', coalesce(sum(c.share) filter (where c.code in ('releasing', 'processing', 'queued')), 0),
        'paid_paise',      coalesce(sum(c.share - coalesce(c.amount_reversed_paise, 0)) filter (where c.code = 'paid'), 0),
        'reversed_paise',  coalesce(sum(c.share) filter (where c.code = 'reversed'), 0),
        'waiting_paise',   coalesce(sum(c.share) filter (where c.code in ('needs_account', 'account_pending', 'under_review')), 0))
       from c)
    into v_items, v_summary;

  return jsonb_build_object('account_status', coalesce(v_account, 'none'), 'summary', v_summary, 'items', v_items);
end;
$$;
revoke all on function public.seller_payout_status(integer) from public, anon, authenticated;
grant execute on function public.seller_payout_status(integer) to authenticated;
