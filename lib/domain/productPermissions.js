// lib/domain/productPermissions.js
//
// A product's declared permission scope (public.product_permissions).
// High-risk permissions (SEND/PUBLISH/DELETE/FINANCIAL_ACTION) can only
// ever be declared with requiresApproval = true -- enforced by the
// database CHECK constraint regardless of what a caller passes here, so
// this layer doesn't need to (and shouldn't) re-implement that rule to be
// safe; it exists for convenience and to keep call sites readable.

import { HIGH_RISK_PERMISSIONS } from "../validation/shared.js";

export { HIGH_RISK_PERMISSIONS };

export async function listProductPermissions(supabase, productId) {
  const { data, error } = await supabase
    .from("product_permissions")
    .select("permission, requires_approval")
    .eq("product_id", productId);

  if (error) throw error;
  return (data ?? []).map((row) => ({
    permission: row.permission,
    requiresApproval: row.requires_approval,
  }));
}

/**
 * Declares a permission on a product. RLS requires the caller to own the
 * product; the database additionally rejects
 * (requiresApproval=false + a high-risk permission) outright.
 */
export async function addProductPermission(supabase, productId, permission, requiresApproval = true) {
  const { data, error } = await supabase
    .from("product_permissions")
    .insert({ product_id: productId, permission, requires_approval: requiresApproval })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function removeProductPermission(supabase, productId, permission) {
  const { error } = await supabase
    .from("product_permissions")
    .delete()
    .eq("product_id", productId)
    .eq("permission", permission);

  if (error) throw error;
}
