// Real, pattern-based redaction — not a simulation. Runs client-side at
// listing-submit time (the seller already has the raw text; the goal is
// keeping it out of what OTHER users see, not defending against the
// uploader themselves) and replaces matches in-place before anything is
// ever written to the database. The original unredacted text is never
// persisted anywhere.
//
// Known limitations, stated plainly rather than silently: this is regex/
// pattern matching, not an ML model — it won't catch every possible secret
// format or a name mentioned in prose ("call me at John's desk"), and it
// does not scan uploaded screenshots (that would need OCR, which isn't
// part of this pass). It reliably catches the structured, high-confidence
// cases: emails, phone numbers, card numbers, and common API-key/token shapes.

// Order matters: the loosest pattern (phone number) has to run LAST, or it
// eats digit sequences that belong to more specific patterns first (a card
// number, or the digits inside a token) before those get a chance to match.
const PATTERNS = [
  { type: "email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[redacted email]" },
  { type: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted AWS key]" },
  { type: "Stripe API key", regex: /\bsk_(live|test)_[0-9a-zA-Z]{16,}\b/g, replacement: "[redacted Stripe key]" },
  { type: "GitHub token", regex: /\bgh[pousr]_[0-9a-zA-Z]{20,}\b/g, replacement: "[redacted GitHub token]" },
  { type: "Slack token", regex: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g, replacement: "[redacted Slack token]" },
  { type: "OpenAI API key", regex: /\bsk-[0-9a-zA-Z]{20,}\b/g, replacement: "[redacted API key]" },
  { type: "JWT / bearer token", regex: /\beyJ[0-9a-zA-Z_-]{10,}\.[0-9a-zA-Z_-]{10,}\.[0-9a-zA-Z_-]{10,}\b/g, replacement: "[redacted token]" },
  {
    type: "credit card number",
    regex: /\b(?:\d[ -]?){13,19}\b/g,
    replacement: "[redacted card number]",
    validate: (match) => luhnValid(match.replace(/[ -]/g, "")),
  },
  {
    type: "phone number",
    // Deliberately loose about grouping (covers "98765 43210" Indian-style
    // and "(555) 123-4567" US-style alike) but the minDigits/maxDigits
    // checks below keep it from swallowing unrelated long digit runs.
    // Runs last -- see ordering note above.
    regex: /\+?\d[\d\-.\s]{7,16}\d/g,
    replacement: "[redacted phone]",
    minDigits: 10,
    maxDigits: 15,
  },
];

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Redacts one string. Returns { text, findings } where findings is
// [{ type, count }] for whatever was actually matched (and, for phone/card,
// actually passed the extra validation — not every digit run counts).
function redactString(input) {
  if (!input) return { text: input || "", findings: [] };
  let text = input;
  const counts = {};

  for (const pattern of PATTERNS) {
    text = text.replace(pattern.regex, (match) => {
      const digitCount = match.replace(/\D/g, "").length;
      if (pattern.minDigits && digitCount < pattern.minDigits) return match;
      if (pattern.maxDigits && digitCount > pattern.maxDigits) return match;
      if (pattern.validate && !pattern.validate(match)) return match;
      counts[pattern.type] = (counts[pattern.type] || 0) + 1;
      return pattern.replacement;
    });
  }

  const findings = Object.entries(counts).map(([type, count]) => ({ type, count }));
  return { text, findings };
}

function mergeFindings(all) {
  const counts = {};
  for (const f of all) counts[f.type] = (counts[f.type] || 0) + f.count;
  return Object.entries(counts).map(([type, count]) => ({ type, count }));
}

// Redacts a whole listing submission: title, description, zip-contents
// note, and every message in the thread. Returns the redacted versions
// plus a merged findings list.
export function redactListing({ title, description, zipContents, messages }) {
  const titleResult = redactString(title);
  const descResult = redactString(description);
  const zipContentsResult = redactString(zipContents);
  const redactedMessages = (messages || []).map((m) => {
    const r = redactString(m.text);
    return { ...m, text: r.text, _findings: r.findings };
  });

  const allFindings = mergeFindings([
    ...titleResult.findings,
    ...descResult.findings,
    ...zipContentsResult.findings,
    ...redactedMessages.flatMap((m) => m._findings),
  ]);

  return {
    title: titleResult.text,
    description: descResult.text,
    zipContents: zipContentsResult.text,
    messages: redactedMessages.map(({ _findings, ...m }) => m),
    findings: allFindings,
  };
}
