"use client";

import { useState, useMemo } from "react";
import { Search, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function formatDate(dateString) {
  return new Date(dateString).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function UserRow({ user, isSelf, onToggle, busy }) {
  const [confirming, setConfirming] = useState(false);

  const handleClick = () => {
    // Demoting yourself is the one action that can lock you out of this
    // page, so it gets an inline confirm step instead of firing immediately.
    if (user.is_admin && isSelf && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    onToggle(user.id, !user.is_admin);
  };

  return (
    <div className="flex items-center justify-between px-4 py-3.5 gap-4" style={{ background: "#FFFFFF" }}>
      <div className="min-w-0">
        <p className="text-sm truncate" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D", fontWeight: 500 }}>
          {user.display_name} {isSelf && <span style={{ color: "#6B6F76", fontWeight: 400 }}>(you)</span>}
        </p>
        <p className="text-xs" style={{ color: "#6B6F76" }}>
          joined {formatDate(user.created_at)}
        </p>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <span
          className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide inline-flex items-center gap-1"
          style={{
            background: user.is_admin ? "#EAF2EF" : "#E8E7E2",
            color: user.is_admin ? "#2F6F62" : "#6B6F76",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          {user.is_admin ? <ShieldCheck size={11} /> : <ShieldOff size={11} />}
          {user.is_admin ? "admin" : "member"}
        </span>

        {confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: "#B33A2E" }}>Remove your own admin access?</span>
            <button
              onClick={handleClick}
              disabled={busy}
              className="px-2.5 py-1 rounded text-xs"
              style={{ background: "#B33A2E", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="px-2.5 py-1 rounded text-xs"
              style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={handleClick}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs"
            style={
              user.is_admin
                ? { border: "1.5px solid #B33A2E", color: "#B33A2E", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }
                : { background: "#14213D", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }
            }
          >
            {user.is_admin ? "Remove admin" : "Make admin"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AdminUsersClient({ initialUsers, currentUserId }) {
  const [users, setUsers] = useState(initialUsers);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState("");

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.display_name.toLowerCase().includes(q));
  }, [users, query]);

  const handleToggle = async (id, nextIsAdmin) => {
    setBusyId(id);
    setError("");
    const supabase = createClient();
    const { data, error: updateError } = await supabase
      .from("profiles")
      .update({ is_admin: nextIsAdmin })
      .eq("id", id)
      .select()
      .single();

    setBusyId(null);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    // A demotion request that was silently reset by the DB-side protection
    // (e.g. someone else demoted the last admin racily) comes back with the
    // old value rather than an error — reflect what's actually true in Postgres.
    if (data.is_admin !== nextIsAdmin) {
      setError("That change wasn't applied — your admin access may have changed. Refresh to check.");
    } else {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, is_admin: data.is_admin } : u)));
      showToast(nextIsAdmin ? "Admin access granted" : "Admin access removed");
    }
  };

  return (
    <div>
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" color="#6B6F76" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search users by name…"
          className="w-full pl-9 pr-3 py-2 rounded text-sm outline-none"
          style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}
        />
      </div>

      {error && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{error}</p>}

      <div className="rounded-md overflow-hidden" style={{ border: "1px solid #D8D5C9" }}>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center py-10 gap-2">
            <ShieldQuestion size={20} color="#6B6F76" />
            <p className="text-sm" style={{ color: "#6B6F76" }}>
              {users.length === 0 ? "No signed-up users yet." : "No users match that search."}
            </p>
          </div>
        ) : (
          filtered.map((u, i) => (
            <div key={u.id} style={{ borderTop: i === 0 ? "none" : "1px solid #EAE8DE" }}>
              <UserRow user={u} isSelf={u.id === currentUserId} onToggle={handleToggle} busy={busyId === u.id} />
            </div>
          ))
        )}
      </div>

      {toast && (
        <div
          className="fixed bottom-[88px] sm:bottom-6 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-full text-sm"
          style={{ background: "#14213D", color: "#F7F7F4", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
