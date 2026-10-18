// lib/domain/upi.js -- UPI ID (VPA) validation. The SAME rule is enforced in the database (migration 20261018100000, public.set_my_payout_vpa),
// so what the form accepts is exactly what the server accepts.
//   name part:   2-64 chars of letters, digits, '.', '_' or '-', starting with a letter or digit
//   handle part: 2-32 chars of letters, digits or '.', starting with a letter   (the bank / app, e.g. okhdfcbank, ybl, paytm)
export const UPI_REGEX = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9.]{1,31}$/;

/** @returns {{ ok: boolean, value: string, error: string|null }}  value is trimmed and lower-cased. error is plain English, or null. */
export function validateUpi(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value.length === 0) return { ok: false, value, error: null };           // nothing typed yet: no red text
  if (value.length > 100) return { ok: false, value, error: "That UPI ID is too long." };
  if (/\s/.test(value)) return { ok: false, value, error: "A UPI ID has no spaces." };
  if (!value.includes("@")) return { ok: false, value, error: "A UPI ID has an @ in it, like name@bank." };
  if (value.split("@").length !== 2) return { ok: false, value, error: "A UPI ID has exactly one @." };
  if (!UPI_REGEX.test(value)) return { ok: false, value, error: "That doesn't look like a valid UPI ID (for example name@okhdfcbank)." };
  return { ok: true, value, error: null };
}

export function maskUpi(vpa) {
  if (typeof vpa !== "string" || !vpa.includes("@")) return "";
  const [name, handle] = vpa.split("@");
  return `${name.slice(0, 2)}***@${handle}`;
}
