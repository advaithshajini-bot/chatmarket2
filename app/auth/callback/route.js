import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Google redirects the browser here after the person approves access, with
// a one-time ?code= in the URL. Exchanging it for a session is what
// actually logs them in -- this route only runs that exchange and then
// forwards them on; there's no separate "sign in" step after this.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/browse";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth`);
}
