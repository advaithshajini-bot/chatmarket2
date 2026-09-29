# Step 3 — Vault secret setup

Run these two statements yourself in the Supabase dashboard's SQL Editor
(or via your DATABASE_URL connection) — substitute your own real values.
Do NOT paste your actual WORKER_SHARED_SECRET value into this chat; these
are meant to stay only between your terminal/dashboard and the database.

```sql
select vault.create_secret(
  'https://uolfnbheigxnzelqtodw.supabase.co/functions/v1/execution-worker',
  'execution_worker_url',
  'Invocation URL for the execution-worker Edge Function'
);

select vault.create_secret(
  'PASTE_YOUR_ROTATED_WORKER_SHARED_SECRET_HERE',
  'execution_worker_shared_secret',
  'Bearer token the dispatch trigger sends -- must match WORKER_SHARED_SECRET set via supabase secrets set'
);
```

Important: **this must be the exact same value** you set via
`supabase secrets set WORKER_SHARED_SECRET=...` after rotating it earlier
-- these are two separate secret stores (Vault is database-side, Function
secrets are Edge-Function-side) that both need to hold the identical
string, or the trigger's dispatch calls will get a 401 from the function
that this whole chain otherwise correctly proved works.

## Order of operations

1. Run the two `vault.create_secret` calls above (safe, no schema change,
   just data).
2. Apply `20260927100000_add_run_step_dispatch.sql` (once reviewed —
   not yet approved to apply, per the process so far).
3. Verify (see next message) — don't assume the dispatch fires correctly
   just because both steps ran without error.

## Exact Dashboard procedure, so no token ever appears in a file or in this chat

1. Go to your project's dashboard → **SQL Editor** (left sidebar) → **New query**.
2. Paste the **first** `vault.create_secret` call (the URL one — this one has no sensitive value, safe either way).
3. Click **Run**. You should see a one-row result with a UUID (the secret's id) — that's success, nothing more to check.
4. **New query** again (a fresh one, not reusing the same tab's history where you might paste over it) — paste the **second** `vault.create_secret` call, but before running it, replace `PASTE_YOUR_ROTATED_WORKER_SHARED_SECRET_HERE` with your actual rotated secret, typed directly into the SQL Editor's text box.
5. Click **Run**. Same one-row UUID result expected.
6. **Immediately clear that query from the editor** (select all, delete) so the raw secret value doesn't linger visibly in the editor pane or get accidentally included in a future copy-paste of "everything in this tab."
7. To confirm both secrets exist **without ever displaying their values**, run this separately: `select name, created_at from vault.secrets order by created_at desc limit 2;` — note this queries `vault.secrets` (metadata only), not `vault.decrypted_secrets` (which would show the actual value) — deliberately the safer table to check against.
8. The dashboard does keep a query history that could include what you ran in step 4 — if that's a concern for your setup, you can clear it afterward from the SQL Editor's history panel, or rotate the secret again later as routine hygiene either way.

