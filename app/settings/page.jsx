"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import DeleteAccountFlow from "@/components/DeleteAccountFlow";
import { createClient } from "@/lib/supabase/client";
import { validateUsername, USERNAME_MAX } from "@/lib/domain/username";

export default function SettingsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState(null);
  const [saved, setSaved] = useState("");
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }
  const [showDelete, setShowDelete] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user) { router.replace("/login"); return; }
      const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", data.user.id).maybeSingle();
      const name = profile?.display_name && !profile.display_name.includes("@") ? profile.display_name : "";
      setUserId(data.user.id); setSaved(name); setUsername(name); setLoading(false);
    })();
  }, [router]);

  const check = validateUsername(username);
  const unchanged = check.ok && check.value === saved;

  const save = async (e) => {
    e.preventDefault();
    setMessage(null);
    if (!check.ok) { setMessage({ ok: false, text: check.error }); return; }
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase.from("profiles").update({ display_name: check.value }).eq("id", userId);
    if (error) { setSaving(false); setMessage({ ok: false, text: "We couldn't save your username. Please try again." }); return; }
    await supabase.auth.updateUser({ data: { display_name: check.value } });
    setSaved(check.value); setUsername(check.value); setSaving(false);
    setMessage({ ok: true, text: "Username updated." });
    router.refresh();
  };

  const card = { background: "#FFFFFF", border: "1px solid #D8D5C9" };
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-2xl mx-auto" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>
        <h1 className="text-3xl mb-6" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>Settings</h1>
        {loading ? <p className="text-sm" style={{ color: "#6B6F76" }}>Loading…</p> : (
          <>
            <form onSubmit={save} className="rounded-md p-5 mb-6" style={card} aria-label="Username">
              <h2 className="text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600 }}>Username</h2>
              <p className="text-sm mb-3" style={{ color: "#6B6F76" }}>This is the name shown in your account menu and on your public profile.</p>
              <label htmlFor="username" className="block text-sm mb-1">Username</label>
              <input id="username" value={username} onChange={(e) => { setUsername(e.target.value); setMessage(null); }} maxLength={USERNAME_MAX + 10}
                     className="w-full px-3 py-2 rounded text-sm" style={{ border: `1px solid ${username && !check.ok ? "#B33A2E" : "#D8D5C9"}` }} aria-invalid={!!username && !check.ok} />
              <div className="flex items-start justify-between gap-3 mt-1.5">
                <span className="text-xs" style={{ color: "#B33A2E" }} role={username && !check.ok ? "alert" : undefined}>{username && !check.ok ? check.error : ""}</span>
                <span className="text-xs" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>{username.trim().length} / {USERNAME_MAX}</span>
              </div>
              <div className="flex items-center justify-end gap-3 mt-4">
                {message && <span role="status" className="text-sm" style={{ color: message.ok ? "#2F6F62" : "#B33A2E" }}>{message.text}</span>}
                <button type="submit" disabled={saving || !check.ok || unchanged} className="px-5 py-2 rounded text-sm"
                        style={{ background: "#14213D", color: "#F7F7F4", fontWeight: 600, opacity: saving || !check.ok || unchanged ? 0.45 : 1 }}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>

            <section className="rounded-md p-5" style={{ ...card, borderColor: "#E5B9B3" }} aria-label="Delete account">
              <h2 className="text-lg mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#B33A2E" }}>Delete account</h2>
              <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>Permanently remove your profile, saved payout details and listings. This can't be undone.</p>
              <button type="button" onClick={() => setShowDelete(true)} className="px-5 py-2 rounded text-sm" style={{ background: "#B33A2E", color: "#FFFFFF", fontWeight: 600 }}>Delete account</button>
            </section>
          </>
        )}
      </main>
      {showDelete && <DeleteAccountFlow onClose={() => setShowDelete(false)} />}
    </div>
  );
}
