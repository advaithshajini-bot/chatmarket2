// Username (profiles.display_name) rules for the settings page. Letters, numbers, spaces and . _ - ' only; never an email address.
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

export function validateUsername(value) {
  const v = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (v.length < USERNAME_MIN) return { ok: false, error: `Username must be at least ${USERNAME_MIN} characters.` };
  if (v.length > USERNAME_MAX) return { ok: false, error: `Username must be ${USERNAME_MAX} characters or fewer.` };
  if (v.includes("@")) return { ok: false, error: "Username can't be an email address." };
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(v)) return { ok: false, error: "Use letters, numbers, spaces and . _ - ' only." };
  return { ok: true, value: v };
}

export const DELETE_REASONS = [
  "I have a duplicate account",
  "I'm not using chatmarket anymore",
  "I'm concerned about my privacy",
  "I didn't find what I was looking for",
  "I'm having a problem with payments or a purchase",
  "Other",
];

export function explainDeleteRefusal(reason) {
  if (reason === "unsettled_earnings") return "You still have earnings that haven't been paid out yet. Please wait for the next monthly payout, then try again.";
  if (reason === "open_dispute") return "You have an open support issue. Please wait until it is resolved, then try again.";
  if (reason === "admin_account") return "Admin accounts can't be deleted here.";
  return "We couldn't delete your account. Please try again or contact support.";
}
