// Refreshes the Supabase auth session cookie on every request, per the
// @supabase/ssr recommended pattern for Next.js. Without this, a session
// can silently expire between page loads even while the browser still holds
// a refresh token.
//
// Also enforces host-based admin isolation: the admin panel only serves
// requests arriving on ADMIN_HOST (a separate deployment/domain of this
// same codebase). This is defense-in-depth on top of the real control
// (every admin query/mutation is already gated by RLS's private.is_admin()
// check) -- it's not a substitute for that, just removes /admin from the
// main site's attack surface entirely: on the main site's host, /admin
// 404s outright, before any auth check even runs.
//
// ADMIN_HOST is unset by default (no restriction applied) so this is safe
// to deploy before the second admin-only deployment exists -- it only
// activates once you've actually set up that deployment and configured
// this env var there.

import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function middleware(request) {
  const adminHost = process.env.ADMIN_HOST;
  const host = request.headers.get("host") || "";
  const pathname = request.nextUrl.pathname;

  if (adminHost) {
    const isAdminHost = host === adminHost;
    const isAdminPath = pathname.startsWith("/admin");

    // /admin requested on any host other than the admin deployment: pretend
    // the route doesn't exist, rather than redirecting (a redirect would
    // still confirm the route exists).
    if (isAdminPath && !isAdminHost) {
      return new NextResponse(null, { status: 404 });
    }

    // On the admin deployment itself, only /admin and the routes needed to
    // authenticate (/login, and API routes -- already excluded from this
    // middleware's matcher below) are reachable. Everything else redirects
    // to /admin rather than exposing the rest of the app there too.
    if (isAdminHost && !isAdminPath && pathname !== "/login") {
      return NextResponse.redirect(new URL("/admin", request.url));
    }
  }

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
