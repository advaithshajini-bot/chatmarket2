import Link from "next/link";
import { ArrowLeft, ShieldCheck, Wrench } from "lucide-react";
import TopNav from "@/components/TopNav";
import ProductTypeBadge from "@/components/ProductTypeBadge";
import ListingCheckout from "@/components/ListingCheckout";
import ReviewsSection from "@/components/ReviewsSection";
import ListingReviewForm from "@/components/ListingReviewForm";

const STEP_KIND_LABELS = {
  validate: "Validate input",
  ai_process: "AI processing",
  tool_call: "Tool call",
  transform: "Transform output",
};

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <h2 className="text-lg mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        {title}
      </h2>
      <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
        {children}
      </div>
    </div>
  );
}

// Display-only detail page for product_type = 'workflow' | 'agent'. No
// execution, no run button -- the purchase CTA (ListingCheckout, unchanged
// from the Playbook path) is the only action available, identical in kind
// to a Playbook purchase: it unlocks access, it does not run anything.
export default function WorkflowAgentDetail({ product, tools, permissions, reviews, isLoggedIn, existingReview }) {
  const config = product.configuration || {};
  const inputs = Array.isArray(config.inputs) ? config.inputs : [];
  const outputs = Array.isArray(config.outputs) ? config.outputs : [];
  const steps = Array.isArray(config.steps) ? config.steps : [];

  return (
    <div style={{ minHeight: "100vh" }}>
      <TopNav />
      <main className="px-6 py-8 max-w-5xl mx-auto">
        <Link
          href="/browse"
          className="flex items-center gap-1.5 text-sm mb-6"
          style={{ color: "#6B6F76", fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          <ArrowLeft size={14} /> Back to browse
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <ProductTypeBadge type={product.type} />
            <h1 className="text-3xl mt-3 mb-2" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
              {product.title}
            </h1>
            <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>
              {product.category}
            </p>

            <Section title={product.type === "agent" ? "What job it performs" : "What it does"}>
              <p className="text-sm" style={{ color: "#3A3D42" }}>
                {config.goal || product.description}
              </p>
              {product.type === "agent" && config.instructions && (
                <p className="text-sm mt-3" style={{ color: "#3A3D42" }}>
                  {config.instructions}
                </p>
              )}
            </Section>

            {(inputs.length > 0 || outputs.length > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                {inputs.length > 0 && (
                  <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
                    <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                      Inputs
                    </p>
                    <ul className="space-y-1">
                      {inputs.map((input, i) => (
                        <li key={i} className="text-sm" style={{ color: "#3A3D42" }}>
                          {input.name}
                          {input.required !== false && <span style={{ color: "#C68F2A" }}> *</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {outputs.length > 0 && (
                  <div className="rounded-md p-4" style={{ background: "#F7F7F4", border: "1px solid #D8D5C9" }}>
                    <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
                      Outputs
                    </p>
                    <ul className="space-y-1">
                      {outputs.map((output, i) => (
                        <li key={i} className="text-sm" style={{ color: "#3A3D42" }}>
                          {output.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {steps.length > 0 && (
              <Section title="High-level steps">
                <ol className="space-y-2">
                  {steps.map((step, i) => (
                    <li key={step.id || i} className="flex items-center gap-3 text-sm" style={{ color: "#3A3D42" }}>
                      <span
                        className="flex items-center justify-center w-6 h-6 rounded-full text-xs shrink-0"
                        style={{ background: "#EDEEEA", fontFamily: "'IBM Plex Mono', monospace", color: "#14213D" }}
                      >
                        {i + 1}
                      </span>
                      {STEP_KIND_LABELS[step.kind] || step.kind}
                    </li>
                  ))}
                </ol>
              </Section>
            )}

            {tools.length > 0 && (
              <Section title="Tools required">
                <div className="flex flex-wrap gap-2">
                  {tools.map((tool) => (
                    <span
                      key={tool.id}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full"
                      style={{ background: "#FFFFFF", border: "1px solid #D8D5C9", color: "#14213D" }}
                    >
                      <Wrench size={11} /> {tool.name}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {permissions.length > 0 && (
              <Section title="Permissions">
                <div className="space-y-2">
                  {permissions.map((p) => (
                    <div key={p.permission} className="flex items-center gap-2 text-sm" style={{ color: "#3A3D42" }}>
                      <ShieldCheck size={14} color="#2F6F62" />
                      {p.permission}
                      {p.requiresApproval && (
                        <span className="text-xs" style={{ color: "#6B6F76" }}>
                          — requires approval before it runs
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Description">
              <p className="text-sm" style={{ color: "#3A3D42" }}>{product.description}</p>
            </Section>

            <div id="reviews">
              <ReviewsSection
                reviews={reviews}
                reviewForm={
                  <ListingReviewForm listingId={product.id} isLoggedIn={isLoggedIn} existingReview={existingReview} />
                }
              />
            </div>
          </div>

          <div className="lg:col-start-3">
            <ListingCheckout listing={{ id: product.id, price: Number(product.price) }} />
          </div>
        </div>
      </main>
    </div>
  );
}
