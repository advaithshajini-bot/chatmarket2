"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Pages that are themselves in the middle of an auth flow. The AAL check
// below is skipped on these -- otherwise it would sign out the very
// password-only session an admin needs to complete their MFA challenge on
// /login, or the recovery session /forgot-password needs to set a new
// password.
const AUTH_FLOW_PATHS = ["/login", "/signup", "/forgot-password"];

// Shared by TopNav and MobileTabBar so both agree on what "logged in"
// means. A session that only satisfies aal1 for an account that has a
// verified MFA factor enrolled is NOT treated as logged in anywhere else
// in the app -- signing in with just a password used to be enough to
// browse, sell, or view purchases as that account even before the MFA
// challenge was completed, which defeats the point of requiring it.
export function useAuthUser() {
  const pathname = usePathname();
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const evaluate = async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        if (!cancelled) setUser(null);
        return;
      }

      const onAuthFlowPage = AUTH_FLOW_PATHS.some((p) => pathname?.startsWith(p));
      if (!onAuthFlowPage) {
        const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalData && aalData.nextLevel === "aal2" && aalData.currentLevel !== "aal2") {
          await supabase.auth.signOut();
          if (!cancelled) setUser(null);
          return;
        }
      }

      if (!cancelled) {
        setUser({
          name: data.user.user_metadata?.display_name || data.user.email,
          email: data.user.email,
        });
      }
    };

    evaluate();

    const { data: listener } = supabase.auth.onAuthStateChange(() => {
      evaluate();
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, [pathname]);

  return user;
}
