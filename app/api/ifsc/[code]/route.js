import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { IFSC_RE } from "@/lib/domain/route";

// Bank name + branch for the seller's IFSC (shown under the field so they can see they typed the right bank). Login required; fails soft:
// if the public lookup is down or does not know the code, the form still works and just shows no bank name.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request, { params }) {
  const code = String(params?.code ?? "").toUpperCase();
  if (!IFSC_RE.test(code)) return NextResponse.json({ error: "invalid_ifsc" }, { status: 400 });
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "login_required" }, { status: 401 });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const res = await fetch(`https://ifsc.razorpay.com/${code}`, { signal: ac.signal, cache: "no-store" });
    if (!res.ok) return NextResponse.json({ found: false }, { status: 404 });
    const d = await res.json();
    const str = (v) => (typeof v === "string" ? v.slice(0, 120) : null);
    return NextResponse.json({ found: true, bank: str(d.BANK), branch: str(d.BRANCH), city: str(d.CITY) });
  } catch {
    return NextResponse.json({ found: false }, { status: 404 });
  } finally {
    clearTimeout(timer);
  }
}
