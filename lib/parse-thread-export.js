// Best-effort parser for thread exports dropped in the seller upload step.
// Handles Claude's data export ("chat_messages" array), ChatGPT's export
// ("mapping" tree), a generic {role/content} array possibly nested inside a
// wrapper object (real seller files are often wrapped, e.g.
// { conversation_export: { messages: [...] } } — this was found and fixed
// against an actual seller-submitted file, not guessed), and a plain
// pasted-transcript fallback.

function normalizeClaudeExport(parsed) {
  const messages = (parsed.chat_messages || [])
    .map((m) => ({ who: m.sender === "human" ? "user" : "assistant", text: (m.text || "").trim() }))
    .filter((m) => m.text);
  return { model: "Claude", messages };
}

function normalizeChatGPTExport(parsed) {
  const nodes = Object.values(parsed.mapping || {});
  const messages = nodes
    .map((n) => n.message)
    .filter((m) => m && m.content && Array.isArray(m.content.parts) && m.author)
    .sort((a, b) => (a.create_time || 0) - (b.create_time || 0))
    .map((m) => ({
      who: m.author.role === "user" ? "user" : "assistant",
      text: m.content.parts.join("\n").trim(),
    }))
    .filter((m) => m.text);
  return { model: "ChatGPT", messages };
}

function normalizeGenericArray(arr) {
  const messages = arr
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const roleField = m.role || m.author || m.who || m.sender || "";
      const textField = m.content || m.text || m.message || "";
      const text = typeof textField === "string" ? textField : Array.isArray(textField?.parts) ? textField.parts.join("\n") : "";
      const roleStr = String(roleField).toLowerCase();
      const who = roleStr.includes("user") || roleStr.includes("human") ? "user" : "assistant";
      return { who, text: text.trim() };
    })
    .filter((m) => m && m.text);
  return { model: "", messages };
}

// Real export files are sometimes wrapped in an outer object
// (e.g. { conversation_export: { date, platform, messages: [...] } }).
// Searches the parsed JSON up to a couple of levels deep for a recognizable
// shape, rather than only checking the top level.
function findMessagesShape(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return null;

  if (Array.isArray(obj.chat_messages)) return normalizeClaudeExport(obj);
  if (obj.mapping && typeof obj.mapping === "object") return normalizeChatGPTExport(obj);
  if (Array.isArray(obj.messages)) return normalizeGenericArray(obj.messages);
  if (Array.isArray(obj)) return normalizeGenericArray(obj);

  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findMessagesShape(value, depth + 1);
      if (found && found.messages.length) return found;
    }
  }
  return null;
}

// Looks for a model/platform hint anywhere in the parsed JSON's string
// fields (e.g. a top-level "platform": "Claude (Anthropic)" field) —
// more reliable than guessing from the filename alone.
function findModelHint(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return "";
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && /platform|model|source|assistant|ai\b/i.test(key)) {
      const lower = value.toLowerCase();
      if (lower.includes("claude")) return "Claude";
      if (lower.includes("chatgpt") || lower.includes("gpt")) return "ChatGPT";
      if (lower.includes("gemini")) return "Gemini";
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = findModelHint(value, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function parsePlainText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const messages = [];
  let currentWho = null;
  let buffer = [];

  const flush = () => {
    if (buffer.length && currentWho) messages.push({ who: currentWho, text: buffer.join(" ").trim() });
    buffer = [];
  };

  for (const line of lines) {
    const userMatch = /^(user|you|human)\s*:/i.exec(line);
    const aiMatch = /^(assistant|ai|claude|chatgpt|gemini)\s*:/i.exec(line);
    if (userMatch) {
      flush();
      currentWho = "user";
      buffer.push(line.slice(userMatch[0].length).trim());
    } else if (aiMatch) {
      flush();
      currentWho = "assistant";
      buffer.push(line.slice(aiMatch[0].length).trim());
    } else if (currentWho) {
      buffer.push(line);
    }
  }
  flush();

  // Fallback for real pasted transcripts with no "User:"/"Assistant:"
  // labels at all: treat blank-line-separated paragraphs as alternating
  // turns, starting with the user. Only kicks in when the labeled pass
  // above found nothing, and only when there's more than one paragraph —
  // a single paragraph is more likely to be plain notes than a transcript.
  if (messages.length === 0) {
    const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length > 1) {
      paragraphs.forEach((p, i) => messages.push({ who: i % 2 === 0 ? "user" : "assistant", text: p }));
    }
  }

  return { model: "", messages };
}

// Returns { model: string, messageCount: number, messages: [{who,text}] } or
// null if the file couldn't be read as anything usable.
export function parseThreadExport(rawText, filename = "") {
  // Mobile share-sheet / notes-app exports commonly prepend a UTF-8 BOM
  // and/or use lone \r line endings (old Mac style) instead of \n or \r\n --
  // both silently break JSON.parse and line-splitting respectively if left
  // in. Normalized once here, up front, before either parsing path runs.
  rawText = rawText.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");

  let result = null;
  let modelHint = "";

  try {
    const parsed = JSON.parse(rawText);
    result = findMessagesShape(parsed);
    modelHint = findModelHint(parsed);
  } catch {
    // not JSON — fall through to plain-text parsing
  }

  if (!result) {
    result = parsePlainText(rawText);
  }

  const model = result.model || modelHint || (() => {
    const lowerName = filename.toLowerCase();
    if (lowerName.includes("gemini")) return "Gemini";
    if (lowerName.includes("chatgpt") || lowerName.includes("gpt")) return "ChatGPT";
    if (lowerName.includes("claude")) return "Claude";
    return "";
  })();

  if (!result.messages.length) return null;

  return { model, messageCount: result.messages.length, messages: result.messages };
}
