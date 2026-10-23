// Generation type options for the playbook sell form. The database CHECK constraints
// (migration 20261023100000) accept exactly these values.
export const GENERATION_TYPES = [
  { value: "images", label: "Images" },
  { value: "text", label: "Text" },
  { value: "videos", label: "Videos" },
  { value: "others", label: "Others" },
];
export const GENERATION_TYPE_OTHER_MAX = 60;

// Returns { generation_type, generation_type_other } for the insert, or { error } when the form is incomplete.
export function resolveGenerationType(type, other) {
  const t = String(type || "");
  if (!GENERATION_TYPES.some((g) => g.value === t)) return { error: "Choose a generation type." };
  if (t !== "others") return { generation_type: t, generation_type_other: null };
  const o = String(other || "").trim().slice(0, GENERATION_TYPE_OTHER_MAX);
  if (!o) return { error: "Type what your playbook generates." };
  return { generation_type: "others", generation_type_other: o };
}

// Buyer-facing label, e.g. "Images" or "Others: Music"; null when the listing has no value.
export function generationTypeLabel(type, other) {
  const g = GENERATION_TYPES.find((x) => x.value === type);
  if (!g) return null;
  return type === "others" && other ? `Others: ${other}` : g.label;
}
