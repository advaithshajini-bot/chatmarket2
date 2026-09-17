import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getVerifiedUser } from "@/lib/supabase/get-verified-user";
import { validateProductConfiguration } from "@/lib/validation/product-configuration";
import { CATEGORIES } from "@/lib/categories";

// Phase 2 — the ONLY write path for creating a Workflow/Agent listing.
// Deliberately minimal: title/description/category/price/product_type/
// configuration, nothing else (no tool/permission declaration yet, no
// Creator Studio). Configuration is validated here, server-side, with the
// exact same Phase 1 Zod schemas the execution engine will validate
// against again before ever running one — never trust configuration
// supplied by the browser, per Phase 1's own stated principle carried
// into Phase 2.
export async function POST(request) {
  const supabase = createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "You need to be logged in to list a product." }, { status: 401 });
  }

  // Mirrors the client-side gate in app/sell/page.jsx (selling is gated on
  // KYC approval) -- checked again here so this route can't be used to
  // bypass that gate directly.
  const { data: kyc } = await supabase
    .from("seller_kyc")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (kyc?.status !== "approved") {
    return NextResponse.json({ error: "Your seller identity verification must be approved first." }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { productType, title, description, category, categoryOther, price, configuration } = body || {};

  if (productType !== "workflow" && productType !== "agent") {
    return NextResponse.json(
      { error: `productType must be "workflow" or "agent" (got "${productType}").` },
      { status: 400 }
    );
  }
  if (!title || typeof title !== "string" || title.trim().length < 3 || title.length > 200) {
    return NextResponse.json({ error: "Title must be between 3 and 200 characters." }, { status: 400 });
  }
  if (!description || typeof description !== "string" || description.trim().length < 10) {
    return NextResponse.json({ error: "Description must be at least 10 characters." }, { status: 400 });
  }
  const resolvedCategory = category === "Other" ? String(categoryOther || "").trim() : category;
  if (!resolvedCategory || (category !== "Other" && !CATEGORIES.includes(category))) {
    return NextResponse.json({ error: "Choose a valid category." }, { status: 400 });
  }
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    return NextResponse.json({ error: "Price must be a positive number." }, { status: 400 });
  }

  // The one validation that matters most: configuration must conform to
  // the Phase 1 Zod schema for this product_type. Never trust the shape a
  // client sends -- reject outright rather than attempting to coerce it.
  const validation = validateProductConfiguration(productType, configuration);
  if (!validation.success) {
    return NextResponse.json(
      {
        error: "Configuration is invalid.",
        details: validation.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 }
    );
  }

  const sellerName = user.user_metadata?.display_name || user.email;

  const { data: inserted, error: insertError } = await supabase
    .from("listings")
    .insert({
      title: title.trim(),
      description: description.trim(),
      category: resolvedCategory,
      price: numericPrice,
      seller_id: user.id,
      seller_name: sellerName,
      product_type: productType,
      version: 1,
      configuration: validation.data,
      // Same moderation lifecycle every listing already goes through --
      // no new admin surface needed for Phase 2.
      status: "pending_review",
    })
    .select("id")
    .single();

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ id: inserted.id }, { status: 201 });
}
