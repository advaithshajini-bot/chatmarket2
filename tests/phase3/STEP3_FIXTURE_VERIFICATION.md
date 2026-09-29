# Step 3 verification — fixture-based, guaranteed fail-closed

## Why this is safe

Confirmed by reading `private.claim_next_step`'s actual body (not assumed):
it checks whether the run exists **first**, then checks
`is_execution_enabled()` **second** — before it ever looks at run status,
ceilings, or step selection. With `phase3_execution` still `false`, a
completely real-looking fixture run will still get rejected with
`execution_disabled` at the second check, no matter what. This lets the
fixture prove the *whole* chain (INSERT → trigger fires → pg_net posts →
worker receives → worker calls the RPC → RPC responds) while structurally
guaranteeing it can't result in anything actually executing.

## Step A — create the fixture (real, committed — not rolled back)

Rolled-back transactions don't work here: `pg_net`'s dispatch and the
worker's own call happen outside your transaction, in a separate process,
so the fixture needs to actually exist when they run. Run this via your
`DATABASE_URL` connection (same setup as the Gate 7 test files):

```sql
-- one throwaway user + listing + run, all clearly marked
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000fff99', 'gate7-step3-fixture@example.invalid')
on conflict (id) do nothing;

insert into public.listings (title, model, category, price, seller_name, seller_id, status)
values ('Step3 dispatch fixture', 'n/a', 'n/a', 0, 'fixture', '00000000-0000-0000-0000-0000000fff99', 'pending_review')
returning id \gset listing_

insert into public.runs (user_id, product_id, product_version, execution_config, status)
values (
  '00000000-0000-0000-0000-0000000fff99',
  :'listing_id',
  1,
  '{"steps":[{"retryLimit":0,"timeoutSeconds":30}],"limits":{"maxSteps":1,"maxCostInr":10,"timeoutSeconds":60}}'::jsonb,
  'queued'
)
returning id \gset run_

-- THIS is the statement that fires the T1 trigger:
insert into public.run_steps (run_id, step_index, status)
values (:'run_id', 0, 'pending');
```

(If your SQL client doesn't support `\gset`, just run each insert
separately and copy the returned `id` values by hand into the next
statement.)

## Step B — confirm the trigger actually dispatched

```sql
select id, url, status_code, created
from net._http_response
order by created desc
limit 5;
```

Expect a row with your worker's URL and a `status_code` of `200`,
created right around when you ran the `run_steps` insert. If nothing
shows up at all, the trigger didn't fire or the Vault secrets weren't
found — check Step C before assuming it's broken.

## Step C — confirm the worker actually received and processed it

```
supabase functions logs execution-worker
```

Expect to see a log line for this invocation showing `claim outcome:
rejected execution_disabled` — the exact, correct, fail-closed result.
**If you see `claimed` instead, stop immediately and tell me** — that
would mean execution happened while the flag is off, which should be
structurally impossible given the check order above, and would be a real
emergency to understand before touching anything else.

## Step D — clean up

```sql
delete from public.run_steps where run_id = :'run_id';
delete from public.runs where id = :'run_id';
delete from public.listings where id = :'listing_id';
delete from auth.users where id = '00000000-0000-0000-0000-0000000fff99';
```

Delete in this order (children before parents) to respect the foreign
keys. Confirm afterward with a quick `select count(*) from public.runs
where user_id = '00000000-0000-0000-0000-0000000fff99'` — should be 0.
