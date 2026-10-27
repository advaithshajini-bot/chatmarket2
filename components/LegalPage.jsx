import TopNav from "@/components/TopNav";

// Shared layout for the policy pages: same typography and palette as the rest of the site (Fraunces headings, IBM Plex Sans body, #14213D).
// A section's body entries are plain strings, or { list: [...] } for bullet points.
export default function LegalPage({ title, updated, intro, sections }) {
  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-16 max-w-2xl mx-auto">
        <h1 className="text-3xl mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{title}</h1>
        {updated && <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>Last updated: {updated}</p>}
        {intro && <p className="text-sm mb-10" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>{intro}</p>}
        <div className="space-y-8">
          {sections.map((section) => (
            <div key={section.heading}>
              <h2 className="text-lg mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>{section.heading}</h2>
              {section.body.map((para, i) =>
                typeof para === "string" ? (
                  <p key={i} className="text-sm mb-2" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>{para}</p>
                ) : (
                  <ul key={i} className="text-sm mb-2 list-disc pl-5 space-y-1" style={{ color: "#3A3D42", fontFamily: "'IBM Plex Sans', sans-serif", lineHeight: 1.7 }}>
                    {para.list.map((li) => <li key={li}>{li}</li>)}
                  </ul>
                )
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
