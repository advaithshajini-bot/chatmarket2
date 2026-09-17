"use client";

// components/WorkflowAgentListingForm.jsx
//
// Phase 2 — deliberately minimal. Title/description/category/price plus
// the smallest structured configuration the Phase 1 Zod schemas require
// (goal, inputs[], outputs[], steps[]). No workflow builder, no
// drag-and-drop, no tool/permission declaration UI, no execution -- all
// explicitly out of scope this phase. Client-side checks here are for UX
// only; the API route re-validates everything with the same Zod schema
// server-side and is the only real authority.

import { useState } from "react";
import { Plus, Trash2, ArrowLeft } from "lucide-react";
import { CATEGORIES } from "@/lib/categories";
import { STEP_KINDS } from "@/lib/validation/shared";
import { productTypeMeta } from "@/lib/product-types";

const FIELD_TYPES = ["string", "number", "boolean", "file", "json"];

function IOFieldRows({ label, rows, setRows }) {
  return (
    <div className="mb-5">
      <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        {label}
      </p>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              value={row.name}
              onChange={(e) => setRows(rows.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)))}
              placeholder="field name"
              className="flex-1 text-sm px-3 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            />
            <select
              value={row.type}
              onChange={(e) => setRows(rows.map((r, idx) => (idx === i ? { ...r, type: e.target.value } : r)))}
              className="text-sm px-2 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button type="button" onClick={() => setRows(rows.filter((_, idx) => idx !== i))} aria-label="Remove">
              <Trash2 size={15} color="#6B6F76" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows([...rows, { name: "", type: "string", required: true }])}
        className="flex items-center gap-1 text-xs mt-2"
        style={{ color: "#14213D" }}
      >
        <Plus size={13} /> Add {label.toLowerCase().slice(0, -1)}
      </button>
    </div>
  );
}

function StepRows({ steps, setSteps }) {
  return (
    <div className="mb-5">
      <p className="text-xs uppercase tracking-wide mb-2" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
        High-level steps
      </p>
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs w-5" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>{i + 1}.</span>
            <select
              value={step.kind}
              onChange={(e) => setSteps(steps.map((s, idx) => (idx === i ? { ...s, kind: e.target.value } : s)))}
              className="flex-1 text-sm px-3 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              {STEP_KINDS.filter((k) => k !== "tool_call").map((kind) => (
                <option key={kind} value={kind}>{kind.replace("_", " ")}</option>
              ))}
            </select>
            <button type="button" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))} aria-label="Remove">
              <Trash2 size={15} color="#6B6F76" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setSteps([...steps, { id: `step_${steps.length + 1}`, kind: "ai_process" }])}
        className="flex items-center gap-1 text-xs mt-2"
        style={{ color: "#14213D" }}
      >
        <Plus size={13} /> Add step
      </button>
      {/* tool_call steps aren't offered here -- declaring which registry
          tool a step uses is Creator Studio scope (Phase 5+), explicitly
          out of scope for this minimal Phase 2 form. */}
    </div>
  );
}

export default function WorkflowAgentListingForm({ type, onBack, onSubmitted }) {
  const meta = productTypeMeta(type);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [categoryOther, setCategoryOther] = useState("");
  const [price, setPrice] = useState("");
  const [goal, setGoal] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inputs, setInputs] = useState([{ name: "", type: "string", required: true }]);
  const [outputs, setOutputs] = useState([{ name: "", type: "string", required: true }]);
  const [steps, setSteps] = useState([{ id: "step_1", kind: "ai_process" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");

    const configuration = {
      goal: goal.trim(),
      ...(type === "agent" ? { instructions: instructions.trim() } : {}),
      inputs: inputs.filter((i) => i.name.trim()).map((i) => ({ ...i, name: i.name.trim() })),
      outputs: outputs.filter((o) => o.name.trim()).map((o) => ({ ...o, name: o.name.trim() })),
      steps: steps.map((s) => ({ id: s.id, kind: s.kind, config: {} })),
    };

    try {
      const res = await fetch("/api/listings/create-workflow-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productType: type,
          title,
          description,
          category,
          categoryOther,
          price,
          configuration,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.details?.[0] ? ` (${data.details[0].path}: ${data.details[0].message})` : "";
        throw new Error((data.error || "Couldn't create the listing.") + detail);
      }
      onSubmitted();
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm mb-4" style={{ color: "#6B6F76" }}>
        <ArrowLeft size={14} /> Change product type
      </button>

      <h1 className="text-2xl mb-1" style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, color: "#14213D" }}>
        List a new {meta.label}
      </h1>
      <p className="text-sm mb-6" style={{ color: "#6B6F76" }}>{meta.description}</p>

      <div className="space-y-4 mb-6">
        <div>
          <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Title
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={200}
            className="w-full text-sm px-3 py-2 rounded outline-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
            rows={3}
            className="w-full text-sm px-3 py-2 rounded outline-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            >
              <option value="" disabled>Choose one</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="Other">Other</option>
            </select>
            {category === "Other" && (
              <input
                value={categoryOther}
                onChange={(e) => setCategoryOther(e.target.value)}
                placeholder="Your category"
                required
                className="w-full text-sm px-3 py-2 rounded outline-none mt-2"
                style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
              />
            )}
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
              Price (₹)
            </label>
            <input
              type="number"
              min="1"
              step="1"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
              className="w-full text-sm px-3 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
            Goal — what does it do, in one or two sentences?
          </label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            required
            rows={2}
            className="w-full text-sm px-3 py-2 rounded outline-none"
            style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
          />
        </div>

        {type === "agent" && (
          <div>
            <label className="text-xs uppercase tracking-wide mb-1 block" style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#6B6F76" }}>
              Instructions — how should it approach the job?
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              required
              rows={3}
              className="w-full text-sm px-3 py-2 rounded outline-none"
              style={{ border: "1px solid #D8D5C9", fontFamily: "'IBM Plex Sans', sans-serif" }}
            />
          </div>
        )}
      </div>

      <IOFieldRows label="Inputs" rows={inputs} setRows={setInputs} />
      <IOFieldRows label="Outputs" rows={outputs} setRows={setOutputs} />
      <StepRows steps={steps} setSteps={setSteps} />

      {error && <p className="text-xs mb-3" style={{ color: "#B33A2E" }}>{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 rounded text-sm font-medium"
        style={{ background: "#E2A83E", color: "#14213D", fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600 }}
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </button>
      <p className="text-[11px] mt-2 text-center" style={{ color: "#6B6F76" }}>
        An admin reviews every new listing before it goes live.
      </p>
    </form>
  );
}
