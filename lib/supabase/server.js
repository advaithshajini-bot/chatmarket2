// Supabase client for use in Server Components, Server Actions, and Route Handlers.
// Reads/writes the auth session via Next.js cookies so a signed-in session from
// the browser client is visible on the server too.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get(name) {
          return cookieStore.get(name)?.value;
        },
        set(name, value, options) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch (e) {
            // Called from a Server Component during render — safe to ignore
            // as long as middleware.js is also refreshing the session.
          }
        },
        remove(name, options) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch (e) {
            // Same as above.
          }
        },
      },
    }
  );
}
