"use client";

import { useState, useEffect } from "react";
import { ShieldCheck, ShieldPlus, Trash2, Loader2, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function AdminMfaSetup() {
  const [loading, setLoading] = useState(true);
  const [factors, setFactors] = useState([]);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollData, setEnrollData] = useState(null); // { factorId, qrCode, secret, challengeId }
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [justEnabled, setJustEnabled] = useState(false);

  const loadFactors = async () => {
    const supabase = createClient();
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors(data?.totp || []);
    setLoading(false);
  };

  useEffect(() => {
    loadFactors();
  }, []);

  const handleStartEnroll = async () => {
    setError("");
    const supabase = createClient();
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (enrollError) {
      setError(enrollError.message);
      return;
    }
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: data.id });
    if (challengeError) {
      setError(challengeError.message);
      return;
    }
    setEnrollData({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      challengeId: challengeData.id,
    });
    setEnrolling(true);
  };

  const handleVerify = async () => {
    setVerifying(true);
    setError("");
    const supabase = createClient();
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollData.factorId,
      challengeId: enrollData.challengeId,
      code,
    });
    setVerifying(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    setEnrolling(false);
    setEnrollData(null);
    setCode("");
    setJustEnabled(true);
    await loadFactors();
  };

  const handleCancelEnroll = async () => {
    if (enrollData) {
      const supabase = createClient();
      await supabase.auth.mfa.unenroll({ factorId: enrollData.factorId });
    }
    setEnrolling(false);
    setEnrollData(null);
    setCode("");
    setError("");
  };

  const handleRemove = async (factorId) => {
    const supabase = createClient();
    await supabase.auth.mfa.unenroll({ factorId });
    await loadFactors();
  };

  if (loading) {
    return <p className="text-sm" style={{ color: "#6B6F76" }}>Loading…</p>;
  }

  if (enrolling && enrollData) {
    return (
      <div className="rounded-md p-5" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
        <p className="text-sm mb-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, color: "#14213D" }}>
          Scan this with your authenticator app
        </p>
        <div
          className="mb-3 rounded-md overflow-hidden"
          style={{ width: 180, height: 180, background: "#FFFFFF", border: "1px solid #D8D5C9" }}
          dangerouslySetInnerHTML={{ __html: enrollData.qrCode }}
        />
        <p className="text-xs mb-1" style={{ color: "#6B6F76" }}>Can't scan? Enter this code manually:</p>
        <p className="text-xs mb-4 px-2 py-1.5 rounded inline-block" style={{ fontFamily: "'IBM Plex Mono', monospace", background: "#EDEEEA", color: "#14213D" }}>
          {enrollData.secret}
        </p>
        <p className="text-sm mb-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif", color: "#14213D" }}>Then enter the 6-digit code it shows:</p>
        <div className="flex items-center gap-2 mb-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            className="px-3 py-2 rounded text-sm outline-none w-32"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Mono', monospace", background: "#FFFFFF" }}
          />
          <button
            onClick={handleVerify}
            disabled={code.length !== 6 || verifying}
            className="px-4 py-2 rounded text-xs font-medium"
            style={{ background: "#14213D", color: "#FFFFFF" }}
          >
            {verifying ? "Verifying…" : "Verify & enable"}
          </button>
          <button onClick={handleCancelEnroll} className="px-3 py-2 rounded text-xs" style={{ color: "#6B6F76" }}>
            Cancel
          </button>
        </div>
        {error && <p className="text-xs" style={{ color: "#B33A2E" }}>{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {justEnabled && (
        <div className="flex items-center gap-2 p-3 rounded-md mb-4" style={{ background: "#EAF2EF", border: "1px solid #CFE4DE" }}>
          <CheckCircle2 size={15} color="#2F6F62" />
          <p className="text-sm" style={{ color: "#2F6F62" }}>Two-factor authentication is on.</p>
        </div>
      )}

      {factors.length === 0 ? (
        <div className="rounded-md p-5 text-center" style={{ background: "#FBF1DD", border: "1px solid #F0DFAE" }}>
          <p className="text-sm mb-4" style={{ color: "#6B6F76" }}>No authenticator app is set up yet.</p>
          <button
            onClick={handleStartEnroll}
            className="px-5 py-2.5 rounded text-sm inline-flex items-center gap-2"
            style={{ background: "#14213D", color: "#FFFFFF", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500 }}
          >
            <ShieldPlus size={15} /> Set up two-factor authentication
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {factors.map((f) => (
            <div key={f.id} className="flex items-center justify-between p-3 rounded-md" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
              <div className="flex items-center gap-2">
                <ShieldCheck size={15} color="#2F6F62" />
                <span className="text-sm" style={{ color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif" }}>
                  Authenticator app — added {new Date(f.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                </span>
              </div>
              <button onClick={() => handleRemove(f.id)} className="p-1.5 rounded" style={{ color: "#B33A2E" }} title="Remove">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-xs mt-2" style={{ color: "#B33A2E" }}>{error}</p>}
    </div>
  );
}
