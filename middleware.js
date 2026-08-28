// Refreshes the Supabase auth session cookie on every request, per the
// @supabase/ssr recommended pattern for Next.js. Without this, a session
// can silently expire between page loads even while the browser still holds
// a refresh token.

import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function middleware(request) {
  // Created ONCE. The cookie handlers below only ever call
  // `.cookies.set(...)` on this same object -- they never construct a new
  // NextResponse. See the "root cause" note in chat for why the previous
  // version (which reassigned `response = NextResponse.next(...)` inside
  // both `set` and `remove`) caused MIDDLEWARE_INVOCATION_TIMEOUT.
  const response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get(name) {
          return request.cookies.get(name)?.value;
        },
        set(name, value, options) {
          response.cookies.set({ name, value, ...options });
        },
        remove(name, options) {
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  await supabase.auth.getUser();
  return response;
}

export const config = {
  // Excludes static assets and, importantly, /api/* -- the API routes
  // (Razorpay checkout, etc.) already create their own Supabase server
  // client and call getUser() internally where needed. Running this
  // middleware in front of them too was redundant: every checkout request
  // paid for two auth round-trips instead of one, and any slowness on
  // Supabase's side hit checkout twice as hard.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
