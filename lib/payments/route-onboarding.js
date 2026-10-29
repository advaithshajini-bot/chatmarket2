// lib/payments/route-onboarding.js -- seller linked-account onboarding (framework-free; db and rzp are injected).
//
// Steps (each is safe to repeat; the account id is saved the moment Razorpay returns it, so a later failure resumes instead of creating a second account):
//   1. POST /v2/accounts                         (skipped when the seller already has an account that is not yet active)
//   2. POST /v2/accounts/:id/products            (request the Route product)
//   3. PATCH /v2/accounts/:id/products/:pid      (bank settlement details)
//   4. save razorpay_account_id + route_status through route_save_linked_account
// PAN and bank details go to Razorpay only. We store the account id and the status, nothing else.
import { buildLinkedAccountPayload, buildProductRequestPayload, buildSettlementPayload, buildBankDisplay, mapRazorpayStatus } from "../domain/route.js";

const fail = (r, step) => ({ ok: false, step, retryable: !!r.retryable, code: r.code ?? "error", message: r.description || "Razorpay could not process this step." });

export async function onboardLinkedAccount({ db, rzp, userId, value, existingAccountId = null, bankName = null }) {
  let accountId = existingAccountId;
  if (!accountId) {
    const created = await rzp.createLinkedAccount(buildLinkedAccountPayload(value, { referenceId: userId }));
    if (!created.ok) return fail(created, "create_account");
    accountId = created.accountId;
    await db.routeSaveAccount({ userId, accountId, routeStatus: "created", note: null });   // remember it BEFORE the next call can fail
  }
  const product = await rzp.requestRouteProduct(accountId, buildProductRequestPayload());
  if (!product.ok) return fail(product, "request_product");
  const updated = await rzp.updateRouteProduct(accountId, product.productId, buildSettlementPayload(value));
  if (!updated.ok) return fail(updated, "settlement_details");
  const routeStatus = mapRazorpayStatus(updated.status ?? product.status);
  const note = routeStatus === "needs_clarification" && updated.requirements.length ? JSON.stringify(updated.requirements.map((x) => x?.field_reference ?? x?.reason_code ?? "detail")).slice(0, 280) : null;
  const saved = await db.routeSaveAccount({ userId, accountId, routeStatus, note });
  // Display-only bank facts (last 4, IFSC, name, type). Best effort: the account is already saved, so a failure here must not fail the onboarding.
  try { await db.routeSaveBank({ userId, ...buildBankDisplay(value), bankName: bankName ?? null }); } catch { /* shown as missing, not fatal */ }
  return { ok: true, accountId, routeStatus, ready: saved?.ready === true };
}

/** Re-read the status from Razorpay (the seller pressed "Check status"). Never downgrades an unreadable answer to 'activated'. */
export async function refreshLinkedAccount({ db, rzp, userId, accountId }) {
  const r = await rzp.fetchLinkedAccount(accountId);
  if (!r.ok) return fail(r, "fetch_account");
  const routeStatus = mapRazorpayStatus(r.status);
  const saved = await db.routeSaveAccount({ userId, accountId, routeStatus, note: null });
  return { ok: true, accountId, routeStatus, ready: saved?.ready === true };
}
