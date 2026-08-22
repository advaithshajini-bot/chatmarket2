export default function ModelTag({ model }) {
  return (
    <span
      className="inline-block px-2 py-0.5 text-[11px] tracking-wide uppercase rounded-sm"
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        background: "#EDEEEA",
        color: "#14213D",
        border: "1px solid #D8D5C9",
      }}
    >
      {model}
    </span>
  );
}
