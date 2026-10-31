// Public creator reads. The RPCs expose only public facts (name, bio, counts, verified); never bank or contact details.
export async function getSellerPublicProfile(supabase, sellerId) {
  const { data } = await supabase.rpc("seller_public_profile", { p_seller: sellerId });
  return data?.found ? data : null;
}

export async function getMostPopularListingIds(supabase, limit = 6) {
  const { data } = await supabase.rpc("most_popular_listings", { p_limit: limit });
  return (data || []).map((r) => r.listing_id);
}
