// lib/payments/service-client.js -- SERVER-ONLY Supabase client using the service-role key.
// Import this only from route handlers (app/api/**). It bypasses RLS; the payment functions it calls are the only
// things it is used for. A guardrail test fails the build if a client component imports it.
import { createClient } from "@supabase/supabase-js";

export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
