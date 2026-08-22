import { Lock } from "lucide-react";

export default function PerforatedDivider() {
  return (
    <div className="relative flex items-center my-3">
      <div className="flex-1 h-0" style={{ borderTop: "2px dashed #D8D5C9" }} />
      <div
        className="mx-2 flex items-center justify-center rounded-full"
        style={{ width: 22, height: 22, background: "#E2A83E" }}
      >
        <Lock size={12} color="#14213D" />
      </div>
      <div className="flex-1 h-0" style={{ borderTop: "2px dashed #D8D5C9" }} />
    </div>
  );
}
