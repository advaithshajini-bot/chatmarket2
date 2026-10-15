import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { handleDisputeSync } from "@/lib/payments/dispute-sync-handler";
import { syncDisputeForPurchase } from "@/lib/payments/disputes";
import { createPaymentsDb } from "@/lib/payments/db";
import { createServiceClient } from "@/lib/payments/service-client";
import { createRazorpayClient } from "@/lib/payments/razorpay-client";

// "A dispute just changed: act on it now." Called by the browser right after a dispute is filed or resolved; the sweep is the
// safety net. Glue only -- what is done is derived from the database (lib/payments/disputes.js), never from this request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request) {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  let body = null;
  try { body = await request.json(); } catch { /* handled as invalid */ }
  const r = await handleDisputeSync({
    userId: userData?.user?.id ?? null,
    purchaseId: body?.purchaseId,
    canSeeDispute: async (purchaseId) => {
      const { data, error } = await supabase.from("disputes").select("id").eq("purchase_id", purchaseId).maybeSingle();
      if (error) throw new Error("lookup failed");
      return !!data;
    },
    sync: async (purchaseId) => {
      const service = createServiceClient();
      const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!service || !keyId || !keySecret) return;
      await syncDisputeForPurchase({ db: createPaymentsDb(service), rzp: createRazorpayClient({ keyId, keySecret }), purchaseId });
    },
  });
  return NextResponse.json(r.json, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
