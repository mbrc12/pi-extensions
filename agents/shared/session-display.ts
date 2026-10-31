/** Dependency-free formatting for Pi session messages used by agent-session viewers. */

export type SessionDisplayEntryType = "user" | "system" | "assistant" | "tool";

/** One semantic transcript entry; consumers can apply their own tag colors. */
export interface SessionDisplayEntry {
	type: SessionDisplayEntryType;
	label: string;
	body: string;
	/** Tool calls and tool results stay compact even when other entries are expanded. */
	fixed?: boolean;
}

export interface SessionDisplayOptions {
	/** Show full messages; tool calls and results always remain capped at 200 characters. */
	expanded?: boolean;
}

/**
 * Extract display-safe entries in original message/content order. System prompts
 * (the harness prompt, AGENTS.md, skills, and similar) are omitted, as are
 * thinking and unknown/private content blocks.
 */
export function getSessionDisplayEntries(messages: readonly unknown[], options: SessionDisplayOptions = {}): SessionDisplayEntry[] {
	const entries: SessionDisplayEntry[] = [];
	for (const item of messages) {
		if (!isRecord(item) || typeof item.role !== "string") continue;
		const role = item.role;
		if (role === "system") continue;
		if (role === "user" || role === "assistant") {
			const parts = contentParts(item.content);
			for (const part of parts) {
				if (part.kind === "text") {
					if (part.text.trim()) entries.push(makeEntry(role, role, part.text, options.expanded));
				} else if (role === "assistant" && part.kind === "toolCall") {
					const args = isRecord(part.arguments) ? Object.entries(part.arguments).map(([key, value]) => `${key} = ${jsonValue(value)}`).join(", ") : jsonValue(part.arguments);
					entries.push({ ...makeEntry("tool", part.name || "tool", args, false), fixed: true });
				}
			}
		} else if (role === "toolResult") {
			const result = contentParts(item.content).filter((part) => part.kind === "text").map((part) => part.text).filter((text) => text.trim()).join("\n");
			const name = typeof item.toolName === "string" && item.toolName ? item.toolName : "tool";
			const body = `${item.isError === true ? "Error: " : ""}${result}`;
			entries.push({ ...makeEntry("tool", `${name} result`, body, false), fixed: true });
		}
	}
	return entries;
}

/** Render entries without ANSI styling, suitable for a plain-text inspector. */
export function formatSessionDisplay(messages: readonly unknown[], options: SessionDisplayOptions = {}): string {
	return renderSessionDisplayEntries(getSessionDisplayEntries(messages, options));
}

/** Render structured entries; tags are plain text for consumer-controlled styling. */
export function renderSessionDisplayEntries(entries: readonly SessionDisplayEntry[]): string {
	return entries.map(({ type, label, body }) => {
		if (type === "assistant") return `-----\n${body}\n-----`;
		if (type === "tool") return `[tool] ${label}${body ? `: ${body}` : ""}`;
		return `[${type}]${body ? ` ${body}` : ""}`;
	}).join("\n");
}

function makeEntry(type: SessionDisplayEntryType, label: string, body: string, expanded = false): SessionDisplayEntry {
	const clean = body.trim();
	return { type, label, body: expanded ? clean : truncate(clean.replace(/\s+/g, " "), 200) };
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function contentParts(content: unknown): Array<{ kind: "text"; text: string } | { kind: "toolCall"; name: string; arguments: unknown }> {
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const parts: Array<{ kind: "text"; text: string } | { kind: "toolCall"; name: string; arguments: unknown }> = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push({ kind: "text", text: block.text });
		else if (block.type === "toolCall") parts.push({ kind: "toolCall", name: typeof block.name === "string" ? block.name : "tool", arguments: block.arguments });
	}
	return parts;
}

function jsonValue(value: unknown): string {
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? String(value) : encoded;
	} catch { return String(value); }
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
