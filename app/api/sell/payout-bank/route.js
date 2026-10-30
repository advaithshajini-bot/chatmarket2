import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { validateBankPayoutForm, explainBankPayoutError } from "@/lib/domain/bank-payout";

// Saves the logged-in seller's bank account for manual monthly payouts. POST { beneficiaryName, accountNumber, confirmAccountNumber, ifsc, accountType }.
// Validated here (friendly errors) and again inside the database function set_my_bank_payout, which is the only writer. The caller's own session
// is used (no service key): the database knows who they are. The full account number is never echoed back; only the last 4 digits are.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return json({ error: "You need to be logged in." }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const form = validateBankPayoutForm(body);
  if (!form.ok) return json({ error: "Please check the highlighted fields.", fields: form.errors }, 400);

  const { data, error } = await supabase.rpc("set_my_bank_payout", {
    p_account_number: form.value.accountNumber,
    p_ifsc: form.value.ifsc,
    p_beneficiary: form.value.beneficiaryName,
    p_account_type: form.value.accountType,
  });
  if (error) {
    const status = error.code === "42501" ? 401 : error.code === "CM080" ? 422 : 500;
    return json({ error: explainBankPayoutError(error) }, status);
  }
  return json({
    ok: true, outcome: data?.outcome ?? "saved", last4: form.value.accountNumber.slice(-4), ifsc: form.value.ifsc,
    beneficiaryName: form.value.beneficiaryName, accountType: form.value.accountType,
    bankUnlocksAt: data?.bank_unlocks_at ?? null, bankCooldownHours: Number.isInteger(data?.bank_cooldown_hours) ? data.bank_cooldown_hours : 0,
  });
}
