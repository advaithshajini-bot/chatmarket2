// Server-component counterpart to the client's lib/supabase/use-auth-user.js
// hook. Use this instead of a raw `supabase.auth.getUser()` on any page
// that gates content behind "you need to log in" -- a session that only
// satisfies aal1 for an account with a verified MFA factor is treated as
// logged out (and signed out outright), not just as "logged in but not
// admin". Without this, a password-only session for an MFA-enrolled
// account could reach any normal page's content -- purchase history,
// library, seller earnings -- before ever completing the MFA challenge,
// even though none of those pages are admin-only themselves.
//
// Skip this on pages that are themselves part of an in-progress auth flow
// (there are none among the server components using this today, but if
// one needs it later, check the request path the way the client hook
// checks pathname before calling this).
export async function getVerifiedUser(supabase) {
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;

  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData && aalData.nextLevel === "aal2" && aalData.currentLevel !== "aal2") {
    await supabase.auth.signOut();
    return null;
  }

  return data.user;
}
