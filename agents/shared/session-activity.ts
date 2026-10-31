/** Shared formatting primitives for rendering session and agent activity. */
import type { Message } from "@earendil-works/pi-ai";

export type DurationStyle = "precise" | "clock";

/**
 * Format a duration using either the subagent's compact precision or the
 * background-job elapsed-time convention.
 */
export function formatDuration(ms: number, style: DurationStyle = "precise"): string {
	const elapsed = Math.max(0, ms);
	if (style === "clock") {
		const seconds = Math.floor(elapsed / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
		return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m${String(seconds % 60).padStart(2, "0")}s`;
	}
	const totalSeconds = elapsed / 1000;
	if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
	if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

/** Normalize single-line activity text and cap its display length. */
export function compactActivityText(value: unknown, max = 500): string {
	const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface SessionActivity {
	/** Recent tool calls/results in chronological order. */
	activity: string[];
	/** Most recent assistant text, when one exists. */
	draft: string;
}

/** Extract human-readable tool activity and the latest assistant text draft. */
export function extractSessionActivity(
	messages: Message[],
	options: { messageLimit?: number; activityLimit?: number; argumentChars?: number; resultChars?: number; draftChars?: number } = {},
): SessionActivity {
	const { messageLimit = 20, activityLimit = 5, argumentChars = 140, resultChars = 180, draftChars = 1000 } = options;
	const activity: string[] = [];
	let draft = "";
	for (const message of messages.slice(-messageLimit)) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") {
					activity.push(`Called ${part.name}: ${compactActivityText(JSON.stringify(part.arguments), argumentChars)}`);
				} else if (part.type === "text") draft = compactActivityText(part.text, draftChars);
			}
		} else if (message.role === "toolResult") {
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
			activity.push(`${message.isError ? "Failed" : "Finished"} ${message.toolName}${text ? `: ${compactActivityText(text, resultChars)}` : ""}`);
		}
	}
	return { activity: activity.slice(-activityLimit), draft };
}

export interface SessionTranscriptOptions {
	/** Maximum trailing session messages to inspect. Default: 40. */
	messageLimit?: number;
	/** Maximum transcript entries to return. Default: 40. */
	entryLimit?: number;
	/** Maximum characters per user/assistant text, tool arguments, or result. Default: 2000. */
	textChars?: number;
	/** Format headings and tool output as Markdown. */
	markdown?: boolean;
}

/**
 * Format a bounded, chronological session transcript for display.
 * Only user/assistant text, tool calls, and tool results are included; thinking
 * blocks and all other content types are deliberately ignored.
 */
export function formatSessionTranscript(messages: Message[], options: SessionTranscriptOptions = {}): string {
	const { messageLimit = 40, entryLimit = 40, textChars = 2000, markdown = false } = options;
	const entries: string[] = [];
	for (const message of tail(messages, messageLimit)) {
		if (message.role === "user" || message.role === "assistant") {
			const role = message.role === "user" ? "USER" : "ASSISTANT";
			const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const part of content) {
				if (part.type === "text") {
					const text = boundedMultilineText(part.text, textChars);
					if (text) entries.push(markdown ? `### ${role === "USER" ? "Assignment" : "Assistant"}\n\n${text}` : `${role}\n${text}`);
				} else if (message.role === "assistant" && part.type === "toolCall") {
					const args = boundedMultilineText(safeJson(part.arguments), textChars);
					entries.push(markdown ? `### Tool call: ${part.name}${args ? `\n\n${markdownCode(args)}` : ""}` : `TOOL CALL · ${part.name}${args ? `\n${indentLines(args)}` : ""}`);
				}
			}
		} else if (message.role === "toolResult") {
			const resultText = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.filter((text) => typeof text === "string" && text.trim())
				.join("\n");
			const result = boundedMultilineText(resultText, textChars);
			const status = message.isError ? "ERROR" : "RESULT";
			entries.push(markdown ? `### ${message.isError ? "Tool error" : "Tool result"}: ${message.toolName}${result ? `\n\n${markdownCode(result)}` : ""}` : `${status} · ${message.toolName}${result ? `\n${indentLines(result)}` : ""}`);
		}
	}
	return tail(entries, entryLimit).join("\n\n");
}

function tail<T>(items: T[], limit: number): T[] {
	const count = Math.max(0, Math.floor(limit));
	return count === 0 ? [] : items.slice(-count);
}

function safeJson(value: unknown): string {
	try { return JSON.stringify(value) ?? ""; } catch { return String(value); }
}

/** Keep meaningful line breaks while trimming outer whitespace and bounding large blocks. */
function boundedMultilineText(value: string, max: number): string {
	const text = value.trim();
	const limit = Math.max(0, max);
	if (text.length <= limit) return text;
	if (limit === 0) return "…";
	return `${text.slice(0, limit).trimEnd()}…`;
}

function markdownCode(value: string): string {
	const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${value}\n${fence}`;
}

function indentLines(value: string): string {
	return value.split("\n").map((line) => `  ${line}`).join("\n");
}

/**
 * Render extracted session activity consistently in compact or expanded form.
 * Compact output keeps the latest event and a short assistant draft; expanded
 * output shows the bounded event history and the full bounded draft.
 */
export function renderSessionActivity(
	session: SessionActivity,
	expanded: boolean,
	options: { activityLimit?: number; draftChars?: number } = {},
): string[] {
	const { activityLimit = 5, draftChars = expanded ? 1000 : 240 } = options;
	const activity = (session.activity ?? []).slice(-Math.max(1, activityLimit));
	const lines: string[] = [];
	lines.push(...renderRecentActivity(activity, expanded));
	const draft = compactActivityText(session.draft, draftChars);
	if (draft) lines.push(expanded ? "Latest assistant text:" : "Assistant:", draft);
	return lines;
}

/** Format the recent-activity portion of a status report, preserving its existing labels. */
export function renderRecentActivity(activity: string[] | undefined, expanded: boolean): string[] {
	if (!activity?.length) return [];
	const lines = [`Last activity: ${activity.at(-1)}`];
	if (expanded && activity.length > 1) lines.push("Recent activity:", ...activity.slice(0, -1).map((item) => `- ${item}`));
	return lines;
}
