const MAP = {
  live: { bg: "#EAF2EF", color: "#2F6F62", label: "Approved" },
  pending_review: { bg: "#FBF1DD", color: "#8A6A18", label: "Pending review" },
  flagged: { bg: "#FBEAE8", color: "#B33A2E", label: "Rejected" },
  removed: { bg: "#E8E7E2", color: "#6B6F76", label: "Removed" },
};

export default function StatusPill({ status }) {
  const s = MAP[status] || MAP.pending_review;
  return (
    <span
      className="text-[11px] px-2 py-1 rounded-full uppercase tracking-wide"
      style={{ background: s.bg, color: s.color, fontFamily: "'IBM Plex Mono', monospace" }}
    >
      {s.label}
    </span>
  );
}
