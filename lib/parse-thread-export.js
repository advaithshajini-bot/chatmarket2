// Best-effort parser for thread exports dropped in the seller upload step.
// Handles the two real export shapes sellers are likely to have (Claude's
// data export "chat_messages" array, ChatGPT's "mapping" tree) plus a plain
// pasted-transcript fallback. Detection is a starting point, not an oracle —
// the seller can always override the model/message-count fields afterward.

function normalizeClaudeExport(parsed) {
  // Claude data export: { uuid, name, chat_messages: [{ text, sender: "human"|"assistant", ... }] }
  const messages = (parsed.chat_messages || [])
    .map((m) => ({ who: m.sender === "human" ? "user" : "assistant", text: (m.text || "").trim() }))
    .filter((m) => m.text);
  return { model: "Claude", messages };
}

function normalizeChatGPTExport(parsed) {
  // ChatGPT export: { mapping: { [nodeId]: { message: { author: {role}, content: {parts} }, parent, children, ... } } }
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

function normalizeGenericArray(parsed) {
  // A generic array of {role|author|who, content|text|message} objects.
  const messages = parsed
    .map((m) => {
      const roleField = m.role || m.author || m.who || m.sender || "";
      const textField = m.content || m.text || m.message || "";
      const text = typeof textField === "string" ? textField : Array.isArray(textField?.parts) ? textField.parts.join("\n") : "";
      const roleStr = String(roleField).toLowerCase();
      const who = roleStr.includes("user") || roleStr.includes("human") ? "user" : "assistant";
      return { who, text: text.trim() };
    })
    .filter((m) => m.text);
  return { model: "", messages };
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

  return { model: "", messages };
}

// Returns { model: string, messageCount: number, messages: [{who,text}] } or
// null if the file couldn't be read as anything usable.
export function parseThreadExport(rawText, filename = "") {
  let result = null;

  try {
    const parsed = JSON.parse(rawText);
    if (parsed && Array.isArray(parsed.chat_messages)) {
      result = normalizeClaudeExport(parsed);
    } else if (parsed && parsed.mapping && typeof parsed.mapping === "object") {
      result = normalizeChatGPTExport(parsed);
    } else if (Array.isArray(parsed)) {
      result = normalizeGenericArray(parsed);
    }
  } catch {
    // not JSON — fall through to plain-text parsing
  }

  if (!result) {
    result = parsePlainText(rawText);
  }

  if (!result.model) {
    const lowerName = filename.toLowerCase();
    if (lowerName.includes("gemini")) result.model = "Gemini";
    else if (lowerName.includes("chatgpt") || lowerName.includes("gpt")) result.model = "ChatGPT";
    else if (lowerName.includes("claude")) result.model = "Claude";
  }

  if (!result.messages.length) return null;

  return { model: result.model, messageCount: result.messages.length, messages: result.messages };
}
