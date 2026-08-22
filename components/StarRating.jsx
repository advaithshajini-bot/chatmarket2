import { Star } from "lucide-react";

export default function StarRating({ value, onChange }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} onClick={() => onChange(n)} type="button">
          <Star size={18} fill={n <= value ? "#E2A83E" : "none"} color={n <= value ? "#E2A83E" : "#D8D5C9"} />
        </button>
      ))}
    </div>
  );
}
