# Milestone 4.3 go-live checklist (Try Demo + blueprint download)

Everything below was verified only against a scratch Postgres and a local `next build`. Nothing here has run on your
Supabase project or your deployed site.

## 0. Before you touch production
1. Apply `20260930100700_add_demo_ui_support.sql` (adds `listing_demo_info` and the demo-run PRIVACY fix).
2. `npm i -D esbuild` (only the component render tests need it), then `node tests/phase4/run-all.mjs` against a SCRATCH
   database. Run the guardrail and component tests from the repo root.
3. `next build` locally.

## 1. What deploys
- New routes: `POST /api/demo/runs` (4.2 file, now returns a machine `reason`), `GET /api/demo/runs/[id]` (new),
  `GET /api/listings/[id]/blueprint` (4.2).
- UI: `components/TryDemo.jsx`, `components/BlueprintDownloadCard.jsx`; modified `WorkflowAgentDetail.jsx`,
  `LibraryDetailClient.jsx`, `app/listing/[id]/page.jsx`, `lib/domain/products.js` (see `modified-files.patch`).
- Nothing becomes visible until a listing has an ENABLED + ADMIN-APPROVED demo AND both flags are on:
  `listing_demo_info` returns `{available:false}` otherwise and the widget renders nothing.

## 2. Smoke test with one real call (about Rs 0.05 of Anthropic spend)
There is NO seller UI yet, so create the first demo by hand on a throwaway LIVE workflow listing:
```sql
insert into public.listing_demos (listing_id, demo_config, is_enabled) values ('<listing uuid>',
  '{"steps":[{"id":"s1","name":"Write a tagline","model":"claude-haiku-4-5-20251001",
              "system":"You write one punchy tagline. Reply with the tagline only.","maxOutputTokens":60,"timeoutSeconds":20}]}', true);
update public.listing_demos set approved_at = now() where listing_id = '<listing uuid>';  -- owner-only shortcut
select public.listing_demo_info('<listing uuid>');   -- expect available:true (needs both flags on)
update private.feature_flags set enabled = true where name in ('phase3_execution', 'phase4_demo');
```
Then, logged in as a NON-seller on the listing page: the "Try it live" card appears; run it; watch the step viewer.
Check `select status, cost, error from public.runs where is_demo order by created_at desc limit 3;`
Confirm as the SELLER account that the run is NOT visible to them. Roll back: set both flags to false.

## 3. Blueprint download
`blueprint_*` columns are filled by whoever uploads (no seller UI yet). To test: put a small JSON file in the
`listing-blueprints` bucket at `<seller_id>/<listing_id>/<name>.json`, then set the four columns
(`blueprint_path`, `blueprint_format`, `blueprint_sha256`, `blueprint_size_bytes`) on the listing. A buyer with a
`paid` purchase then sees the card on /library/<purchase>; a refunded purchase sees the disabled button.

## 4. Known gaps (deliberately not in 4.3)
- No seller UI to author a demo, request approval, or upload a blueprint; no admin approval screen.
- A failed or timed-out demo still counts against the user's 3 runs/day (the copy does not promise otherwise).
- The step viewer polls (0.8 s -> 5 s backoff); there is no Realtime push.
- The demo input is untrusted: output is rendered as escaped text only. Keep it that way.
- Blueprints are not scanned for embedded credentials on upload.
