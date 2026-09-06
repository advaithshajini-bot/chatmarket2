export default function Loading() {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: "70vh" }}>
      <div className="text-center">
        <div
          className="mx-auto mb-4 rounded-full animate-spin"
          style={{ width: 32, height: 32, border: "3px solid #D8D5C9", borderTopColor: "#14213D" }}
        />
        <p className="text-sm" style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Loading...
        </p>
      </div>
    </div>
  );
}
