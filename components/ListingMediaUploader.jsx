"use client";

import { useRef, useState } from "react";
import { Image as ImageIcon, Video as VideoIcon, Play } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LISTING_RULES, validateImageFile, validateVideoFile, validateVideoDuration, formatDuration } from "@/lib/domain/listing-rules";

// Mandatory listing media, uploaded straight to the public `listing-media` bucket under <seller_id>/<listingId>/<file>
// (the bucket policy checks that folder against auth.uid(), so no listing row is needed yet).
//   Screenshots: 4 to 10 images, PNG / JPEG / WebP, up to 10MB each.
//   Preview video: exactly 1 .mp4 / .webm, up to 25MB, 5 to 15 seconds (read from the file's metadata in the browser).
const BUCKET = "listing-media";
const LABEL = { fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" };

export function ScreenshotUploader({ form, setForm }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const { screenshotsMin: MIN, screenshotsMax: MAX } = LISTING_RULES;
  const count = form.screenshots.length;
  const enough = count >= MIN && count <= MAX;

  const handleFiles = async (fileList) => {
    const room = MAX - count;
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    setError("");
    if (picked.length > room) setError(`You can add ${room} more screenshot${room === 1 ? "" : "s"} (maximum ${MAX}).`);
    const files = picked.slice(0, Math.max(room, 0));
    if (!files.length) return;

    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { setError("Log in to upload screenshots."); return; }

    setUploading(true);
    const uploaded = [];
    for (const file of files) {
      const v = validateImageFile(file);
      if (!v.ok) { setError(v.error); continue; }
      const path = `${userData.user.id}/${form.listingId}/img-${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file);
      if (upErr) { setError(upErr.message); continue; }
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      uploaded.push({ path, url: data.publicUrl, name: file.name });
    }
    if (uploaded.length) setForm((f) => ({ ...f, screenshots: [...f.screenshots, ...uploaded] }));
    setUploading(false);
  };

  const handleRemove = async (path) => {
    setForm((f) => ({ ...f, screenshots: f.screenshots.filter((s) => s.path !== path) }));
    await createClient().storage.from(BUCKET).remove([path]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs uppercase tracking-wide" style={LABEL}>Output screenshots (required)</label>
        <span className="text-[11px] px-2 py-0.5 rounded" style={{ fontFamily: "'IBM Plex Mono', monospace", color: enough ? "#2F6F62" : "#B33A2E", background: enough ? "#EEF6F3" : "#FBEDEA" }}>
          {count} of {MIN}–{MAX} uploaded
        </span>
      </div>
      {count > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-5 gap-2 mb-2">
          {form.screenshots.map((s) => (
            <div key={s.path} className="relative rounded overflow-hidden" style={{ border: "1px solid #D8D5C9", aspectRatio: "1" }}>
              <img src={s.url} alt={s.name} className="w-full h-full object-cover" />
              <button type="button" onClick={() => handleRemove(s.path)} aria-label={`Remove ${s.name}`} className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs" style={{ background: "rgba(20,33,61,0.75)", color: "#FFFFFF" }}>×</button>
            </div>
          ))}
        </div>
      )}
      {count < MAX && (
        <div className="rounded-md p-4 flex items-center justify-center gap-2 cursor-pointer text-center" style={{ border: "1.5px dashed #D8D5C9", background: "#F7F7F4" }}
          onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}>
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          <ImageIcon size={16} color="#6B6F76" />
          <p className="text-xs" style={{ color: "#6B6F76" }}>{uploading ? "Uploading…" : `Drop ${MIN} to ${MAX} screenshots, or browse (PNG, JPEG or WebP, up to 10MB each)`}</p>
        </div>
      )}
      {!enough && count > 0 && <p className="text-xs mt-1.5" style={{ color: "#B33A2E" }}>Add at least {MIN} screenshots to continue.</p>}
      {error && <p className="text-xs mt-1.5" style={{ color: "#B33A2E" }} role="alert">{error}</p>}
    </div>
  );
}

// Reads the duration from the file's metadata with an HTML5 <video> element.
export function readVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.preload = "metadata";
    video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); };
    video.onerror = () => { URL.revokeObjectURL(url); resolve(NaN); };
    video.src = url;
  });
}

export function VideoUploader({ form, setForm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const video = form.video;

  const handleFile = async (file) => {
    if (!file) return;
    setError("");
    const v = validateVideoFile(file);
    if (!v.ok) { setError(v.error); return; }
    const duration = await readVideoDuration(file);
    const d = validateVideoDuration(duration);
    if (!d.ok) { setError(Number.isFinite(duration) ? d.error : "We couldn't read that video. Try another .mp4 or .webm file."); return; }
    const supabase = createClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) { setError("Log in to upload the video."); return; }
    setBusy(true);
    const path = `${userData.user.id}/${form.listingId}/video-${crypto.randomUUID()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
    if (upErr) { setError(upErr.message); setBusy(false); return; }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
    if (video?.path) await supabase.storage.from(BUCKET).remove([video.path]);   // Replace: the old file goes
    setForm((f) => ({ ...f, video: { path, url: data.publicUrl, name: file.name, duration } }));
    setBusy(false);
  };

  const remove = async () => {
    const old = video;
    setForm((f) => ({ ...f, video: null }));
    if (old?.path) await createClient().storage.from(BUCKET).remove([old.path]);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs uppercase tracking-wide" style={LABEL}>Preview video (required)</label>
        <span className="text-[11px] px-2 py-0.5 rounded" style={{ fontFamily: "'IBM Plex Mono', monospace", color: video ? "#2F6F62" : "#B33A2E", background: video ? "#EEF6F3" : "#FBEDEA" }}>
          {video ? "1 of 1 uploaded" : "0 of 1 uploaded"}
        </span>
      </div>
      {video ? (
        <div className="rounded-md p-3 flex gap-3 items-center" style={{ border: "1px solid #D8D5C9", background: "#F7F7F4" }}>
          <div className="relative rounded overflow-hidden shrink-0" style={{ width: 128, aspectRatio: "16/9", background: "#14213D" }}>
            <video src={video.url} className="w-full h-full object-cover" muted playsInline controls preload="metadata" />
            <span className="absolute bottom-1 right-1 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(20,33,61,0.8)", color: "#FFFFFF", fontFamily: "'IBM Plex Mono', monospace" }}>{formatDuration(video.duration)}s</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm truncate" style={{ color: "#14213D" }}>{video.name}</p>
            <p className="text-xs" style={{ color: "#6B6F76" }}>Duration {formatDuration(video.duration)}s</p>
            <div className="flex gap-3 mt-1">
              <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="text-xs underline" style={{ color: "#14213D" }}>{busy ? "Uploading…" : "Replace"}</button>
              <button type="button" onClick={remove} disabled={busy} className="text-xs underline" style={{ color: "#B33A2E" }}>Remove</button>
            </div>
          </div>
          <input ref={inputRef} type="file" accept="video/mp4,video/webm" className="hidden" onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      ) : (
        <div className="rounded-md p-4 flex items-center justify-center gap-2 cursor-pointer text-center" style={{ border: "1.5px dashed #D8D5C9", background: "#F7F7F4" }}
          onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]); }}>
          <input ref={inputRef} type="file" accept="video/mp4,video/webm" className="hidden" onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
          <VideoIcon size={16} color="#6B6F76" />
          <p className="text-xs" style={{ color: "#6B6F76" }}>{busy ? "Uploading…" : "Drop one preview video, or browse (.mp4 or .webm, 5 to 15 seconds, under 25MB)"}</p>
          {!busy && <Play size={12} color="#6B6F76" />}
        </div>
      )}
      {error && <p className="text-xs mt-1.5" style={{ color: "#B33A2E" }} role="alert">{error}</p>}
    </div>
  );
}
