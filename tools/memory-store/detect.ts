/**
 * Message handling for the memory-store extension.
 *
 * - collectMessageParts(): conversation snapshot from the session branch.
 * - Text extraction from messages with string or block content.
 * - Tool-call counting for the background review thresholds.
 */

// ─── Message text extraction ───

interface MessageLike {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

/** Get the plain text of a message, handling string or block content. */
export function getMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as MessageLike;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => (block as { text: string }).text)
      .join("\n");
  }
  return "";
}

// ─── Conversation snapshot ───

export interface MessagePart {
  role: "user" | "assistant";
  text: string;
}

/**
 * Collect message parts from session branch entries. Entry shape (from
 * ctx.sessionManager.getBranch()): { type: "message", message: {...} }.
 */
export function collectMessageParts(entries: unknown[], recentMessages = 0): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: unknown }).message;
    const text = getMessageText(message);
    if (!text) continue;
    const role = (message as { role?: unknown } | null)?.role;
    if (role === "user") parts.push({ role: "user", text });
    else if (role === "assistant") parts.push({ role: "assistant", text });
  }
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

/** Format parts as labeled lines for an LLM prompt. */
export function formatParts(parts: MessagePart[]): string {
  return parts.map((p) => (p.role === "user" ? `[USER]: ${p.text}` : `[ASSISTANT]: ${p.text}`)).join("\n\n");
}

/** Count tool calls in an assistant message's content blocks. */
export function countToolCalls(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (block) => !!block && typeof block === "object" && (block as { type?: string }).type === "toolCall",
  ).length;
}
