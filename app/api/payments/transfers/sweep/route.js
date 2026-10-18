import { NextResponse } from "next/server";
import { handleSweepRequest } from "@/lib/payments/sweep-handler";
import { runReconciliation } from "@/lib/payments/reconcile";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { createRazorpayClient } from "@/lib/payments/razorpay-client";

// Reconciliation sweep: acts on disputes (hold / release / reverse / refund), then creates transfers that are due (only while the phase5_route_transfers flag
// is ON), retries failed attempts, and polls transfers whose webhook never arrived. Protected by CRON_SECRET
// (Authorization: Bearer ...). Vercel Cron sends GET; manual runs may POST. Glue only -- logic is in lib/payments.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

async function run(request) {
  const service = createServiceClient();
  const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
  const r = await handleSweepRequest({
    authorization: request.headers.get("authorization"),
    secret: process.env.CRON_SECRET,
    sweep: async () => {
      if (!service || !keyId || !keySecret) throw new Error("not configured");
      return runReconciliation({ db: createPaymentsDb(service), rzp: createRazorpayClient({ keyId, keySecret, accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || null }), limit: 20, budgetMs: 20000 });
    },
  });
  return NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
export const GET = run;
export const POST = run;
