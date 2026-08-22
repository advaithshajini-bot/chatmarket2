// Supabase client for use in Client Components ("use client").
// Safe to expose NEXT_PUBLIC_SUPABASE_ANON_KEY in the browser — it's the
// publishable key, and every table it can touch is protected by the Row
// Level Security policies applied in the Supabase project (see docs/supabase-schema.sql).

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
