// lib/domain/productTools.js
//
// Which registry tools (public.tools) a product declares it may use
// (public.product_tools). Read paths work today; write paths are gated by
// RLS to the product's own owner (a creator can only add/remove tools on
// products they own -- enforced in the database, not just here).

export async function listEnabledTools(supabase) {
  const { data, error } = await supabase
    .from("tools")
    .select("id, name, description, input_schema, output_schema, required_permission")
    .eq("enabled", true)
    .order("name");

  if (error) throw error;
  return data ?? [];
}

export async function listProductTools(supabase, productId) {
  const { data, error } = await supabase
    .from("product_tools")
    .select("tool_id, tools ( id, name, description, required_permission )")
    .eq("product_id", productId);

  if (error) throw error;
  return (data ?? []).map((row) => row.tools).filter(Boolean);
}

/**
 * Declares that a product may use a tool. RLS requires the caller to own
 * the product (private.owns_product) -- this will fail for anyone else,
 * by design.
 */
export async function addProductTool(supabase, productId, toolId) {
  const { data, error } = await supabase
    .from("product_tools")
    .insert({ product_id: productId, tool_id: toolId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function removeProductTool(supabase, productId, toolId) {
  const { error } = await supabase
    .from("product_tools")
    .delete()
    .eq("product_id", productId)
    .eq("tool_id", toolId);

  if (error) throw error;
}
