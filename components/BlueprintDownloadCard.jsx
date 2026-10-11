"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, FileJson, ShieldAlert } from "lucide-react";
import { checksumCommands, describeBlueprintError, formatBytes, formatLabel } from "@/lib/blueprints/format";

// The buyer's blueprint download. Access is NOT decided here: the server route creates a 60-second signed
// URL with the buyer's own session, and Storage RLS only allows that for the seller, an admin, or a user with a
// 'paid' purchase of this listing. This component just asks, shows what came back, and helps verify the file.

const INK = "#14213D", MUTED = "#6B6F76", RULE = "#D8D5C9", TEAL = "#2F6F62", RED = "#B33A2E";
const SANS = "'IBM Plex Sans', sans-serif", MONO = "'IBM Plex Mono', monospace";

export default function BlueprintDownloadCard({ listing, refunded = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hasBlueprint = !!listing?.blueprint_path;
  const filename = hasBlueprint ? String(listing.blueprint_path).split("/").pop() : "";
  const cmds = checksumCommands(filename);

  const download = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/listings/${listing.id}/blueprint`, { cache: "no-store" });
      let json = {};
      try { json = await res.json(); } catch { /* ignore */ }
      if (res.status === 200 && json.url) {
        window.location.href = json.url;
      } else {
        setError(describeBlueprintError({ status: res.status, refunded }));
      }
    } catch {
      setError(describeBlueprintError());
    } finally {
      setBusy(false);
    }
  };

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(listing.blueprint_sha256);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable: the hash is selectable text */ }
  };

  return (
    <div className="rounded-md p-5 sticky top-20" style={{ background: "#FFFFFF", border: `1px solid ${RULE}` }}>
      <div className="flex items-center gap-2 mb-3">
        <FileJson size={15} color="#E2A83E" aria-hidden="true" />
        <p className="text-sm" style={{ fontFamily: SANS, fontWeight: 600, color: INK }}>Your blueprint</p>
      </div>

      {hasBlueprint ? (
        <>
          <p className="text-xs mb-1" style={{ color: "#3A3D42", fontFamily: SANS }}>
            {formatLabel(listing.blueprint_format)}
            {formatBytes(listing.blueprint_size_bytes) ? ` · ${formatBytes(listing.blueprint_size_bytes)}` : ""}
          </p>
          <p className="text-xs mb-4" style={{ color: MUTED, fontFamily: SANS }}>
            Import it into your own setup and add your own API keys. It is yours to keep.
          </p>
          <button
            type="button"
            onClick={download}
            disabled={busy || refunded}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm"
            style={{ background: refunded ? RULE : INK, color: "#F7F7F4", fontFamily: SANS, fontWeight: 500, cursor: refunded ? "not-allowed" : "pointer" }}
          >
            <Download size={14} aria-hidden="true" /> {busy ? "Preparing download…" : "Download blueprint"}
          </button>
          {refunded && <p className="text-xs mt-2" style={{ color: RED }}>{describeBlueprintError({ status: 403, refunded: true })}</p>}
          {error && <p role="alert" className="text-xs mt-2" style={{ color: RED }}>{error}</p>}

          {listing.blueprint_sha256 && (
            <details className="mt-4">
              <summary className="text-xs cursor-pointer" style={{ color: MUTED, fontFamily: SANS }}>Verify your download</summary>
              <div className="mt-2 text-xs" style={{ color: "#3A3D42", fontFamily: SANS }}>
                <p className="mb-1">SHA-256 of the file the seller uploaded:</p>
                <div className="flex items-start gap-2">
                  <code className="break-all" style={{ fontFamily: MONO, background: "#F7F7F4", padding: "2px 4px", borderRadius: 4 }}>
                    {listing.blueprint_sha256}
                  </code>
                  <button type="button" onClick={copyHash} aria-label="Copy checksum" className="shrink-0 p-1 rounded" style={{ border: `1px solid ${RULE}` }}>
                    {copied ? <Check size={12} color={TEAL} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                  </button>
                </div>
                <p className="mt-2 mb-1">Then compare it with:</p>
                <p><code style={{ fontFamily: MONO }}>{cmds.unix}</code> <span style={{ color: MUTED }}>(macOS / Linux)</span></p>
                <p><code style={{ fontFamily: MONO }}>{cmds.windows}</code> <span style={{ color: MUTED }}>(Windows PowerShell)</span></p>
              </div>
            </details>
          )}

          <p className="flex items-start gap-1.5 mt-4 text-xs" style={{ color: MUTED, fontFamily: SANS }}>
            <ShieldAlert size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>Review a blueprint before importing it, and never paste secrets into a file you did not write.</span>
          </p>
        </>
      ) : (
        <p className="text-xs" style={{ color: MUTED, fontFamily: SANS }}>{describeBlueprintError({ status: 404 })}</p>
      )}
    </div>
  );
}
