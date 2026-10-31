/**
 * export-md — export the current pi session to a Markdown transcript.
 *
 * Usage: /export-md [file]
 *
 * Writes the current session (the active branch) as a readable Markdown file:
 * user and assistant messages as headings, tool results in fenced code blocks,
 * and toggle notes for compaction, branch summaries, and model changes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";

// --- content helpers -------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
			.map((b) => (b as { text?: string }).text ?? "")
			.join("");
	}
	return "";
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const s = JSON.stringify(args);
	return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function safeSlug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "session"
	);
}

function viewUrl(absPath: string): string {
	const rel = relative(homedir(), absPath);
	return `http://localhost:1002/${rel}`;
}

// --- colored callouts (Obsidian `> [!type]` blocks) -----------------------

function callout(type: string, title: string, bodyLines: string[]): string[] {
	const out = [`> [!${type}] ${title}`];
	if (!bodyLines.length) {
		out.push(">");
		return out;
	}
	for (const line of bodyLines) {
		out.push(line === "" ? ">" : `> ${line}`);
	}
	out.push("");
	return out;
}

function asRecord(v: unknown): Record<string, any> {
	return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

function uLink(text: string, url: string): string {
	return url ? `[${text}](${url})` : text;
}

function defaultTool(toolName: string, body: string): string[] {
	const title = `tool: ${toolName}`;
	if (!body) return callout("note", title, ["(no output)"]);
	if (body.includes("\n") || body.length > 80) {
		return callout("note", title, ["```text", body, "```"]);
	}
	return callout("note", title, [body]);
}

/** Render a tool result message as a color-coded callout. */
function renderToolResult(toolName: string, msg: any): string[] {
	const details = asRecord(msg.details);
	const body = textOf(msg.content).trim();

	switch (toolName) {
		case "quiz": {
			let type = "warning";
			let title = "quiz";
			if (!details.cancelled) {
				type = details.correct ? "success" : "danger";
				title = details.correct ? "quiz ✓ correct" : "quiz ✗ incorrect";
			}
			const lines = [`**Q:** ${details.question ?? "(none)"}`];
			if (Array.isArray(details.options) && details.options.length) {
				lines.push(`**Choices:** ${details.options.map((o: string, i: number) => `${i + 1}. ${o}`).join(" · ")}`);
			}
			lines.push(
				details.cancelled ? "**Answered:** *(cancelled)*" : `**Your answer:** ${details.given ?? "(none)"}`,
			);
			if (!details.cancelled) lines.push(`**Key:** ${details.correctAnswer ?? ""}`);
			if (details.explanation) lines.push(`**Why:** ${details.explanation}`);
			return callout(type, title, lines);
		}

		case "ask_question": {
			const lines = [`**Q:** ${details.question ?? "(none)"}`];
			if (Array.isArray(details.options) && details.options.length) {
				lines.push(`**Options:** ${details.options.map((o: string, i: number) => `${i + 1}. ${o}`).join(" · ")}`);
			}
			const ans = Array.isArray(details.answers) ? details.answers : [];
			lines.push(details.cancelled ? "**Answered:** *(cancelled)*" : `**Answered:** ${ans.join("; ") || "(none)"}`);
			return callout("question", "ask_question", lines);
		}

		case "web_use": {
			if (Array.isArray(details.results) || details.resultCount !== undefined) {
				const results = Array.isArray(details.results) ? details.results : [];
				const lines = [`**Query:** ${details.query ?? ""}`, ""];
				if (!results.length) lines.push("(no results)");
				results.forEach((r: any, i: number) => {
					const t = r?.title ?? "(untitled)";
					const u = r?.url ?? "";
					const d = r?.description ?? "";
					lines.push(u ? `- **${i + 1}.** [${t}](${u})${d ? ` — ${d}` : ""}` : `- **${i + 1}.** ${t}${d ? ` — ${d}` : ""}`);
				});
				const n = results.length;
				return callout("info", `Web search — ${n} result${n === 1 ? "" : "s"}`, lines);
			}

			const isFetch = details.mode === "fetch" || details.summary || details.page_title;
			if (isFetch) {
				const lines: string[] = [];
				const url = details.url ?? "";
				const pt = details.page_title ?? "";
				lines.push(`**Source:** ${uLink(pt || url, url)}`);
				if (details.summary) lines.push(`**Summary:** ${details.summary}`);
				if (Array.isArray(details.key_points) && details.key_points.length) {
					lines.push("**Key points:**");
					details.key_points.forEach((k: unknown) => lines.push(`- ${k}`));
				}
				if (details.important_text) {
					lines.push("**Important text:**", "");
					lines.push(...String(details.important_text).split("\n"));
				}
				return callout("note", `Web fetch${pt ? ` — ${pt}` : ""}`, lines);
			}

			if (details.mode === "full" || details.html !== undefined) {
				const url = details.url ?? "";
				const html = typeof details.html === "string" ? details.html : body;
				const size = details.html_length ? `${details.html_length} bytes` : "";
				const lines = [`**URL:** ${url}`, size ? `**Size:** ${size}` : "", "", "```html", html, "```"];
				return callout("note", "Web full HTML", lines);
			}

			return defaultTool("web_use", body);
		}

		default:
			return defaultTool(toolName, body);
	}
}

// --- transcript rendering --------------------------------------------------

/**
 * Render one session entry (already in chronological order) to Markdown lines.
 * Returns a list of line-strings (each without trailing newline).
 */
function renderEntry(entry: any): string[] {
	if (!entry || typeof entry !== "object") return [];
	const out: string[] = [];

	if (entry.type === "message") {
		const msg = entry.message ?? {};
		const role = msg.role;

		if (role === "user") {
			out.push("## User", "", textOf(msg.content), "");
		} else if (role === "assistant") {
			const model = msg.model ? ` (${msg.model})` : "";
			out.push(`## Assistant${model}`, "");
			const textParts: string[] = [];
			const calls: string[] = [];
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const b of content) {
				if (b.type === "text") textParts.push(b.text);
				else if (b.type === "thinking") textParts.push(`> _thinking:_ ${b.thinking}`);
				else if (b.type === "toolCall") calls.push(`- tool \`${b.name}\`(${summarizeArgs(b.arguments)})`);
				else if (b.type === "image") textParts.push("> _(attached image — not embedded)_");
			}
			if (textParts.length) out.push(textParts.join("\n\n"), "");
			if (calls.length) {
				out.push("Calls:", ...calls, "");
			}
			if (msg.stopReason === "error") out.push("> _assistant error:_ " + (msg.errorMessage ?? "unknown"), "");
		} else if (role === "toolResult") {
			out.push(...renderToolResult(msg.toolName ?? "tool", msg));
		} else if (role === "bashExecution") {
			const lines = ["```sh", msg.command ?? "", "```"];
			if (msg.output) lines.push("", "```text", msg.output, "```");
			out.push(...callout("note", "bash", lines));
		} else if (role === "custom") {
			out.push("#### Custom message", "", textOf(msg.content), "");
		} else {
			// Fallback for other roles
			out.push(`#### ${role}`, "", textOf(msg.content), "");
		}
		return out;
	}

	if (entry.type === "compaction") {
		out.push(`> **Compaction:** ${entry.summary ?? ""}`, "");
		return out;
	}
	if (entry.type === "branch_summary") {
		out.push(`> **Branch summary:** ${entry.summary ?? ""}`, "");
		return out;
	}
	if (entry.type === "custom_message") {
		out.push("#### Extension message", "", textOf(entry.content), "");
		return out;
	}
	if (entry.type === "model_change") {
		out.push(`> _model:_ ${entry.provider}/${entry.modelId}`, "");
		return out;
	}
	if (entry.type === "thinking_level_change") {
		out.push(`> _thinking level:_ ${entry.thinkingLevel}`, "");
		return out;
	}
	if (entry.type === "session_info") {
		out.push(`> _session name:_ ${entry.name ?? ""}`, "");
		return out;
	}
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("export-md", {
		description: "Export the current session to a Markdown transcript. Usage: /export-md [file]",
		handler: async (args, ctx) => {
			const sm = ctx.sessionManager as any;
			const all: any[] = (sm.getEntries && sm.getEntries?.() ) ?? [];
			const leafId = sm.getLeafId && sm.getLeafId();

			// Walk the active branch from the leaf up via parentId, then reverse to
			// chronological order. Doesn't depend on getBranch's return order.
			let entries: any[];
			if (leafId) {
				const byId = new Map(all.map((e) => [e.id, e]));
				const chain: any[] = [];
				let cur = byId.get(leafId);
				let guard = 0;
				while (cur && guard++ <= all.length) {
					chain.push(cur);
					cur = cur.parentId ? byId.get(cur.parentId) : undefined;
				}
				entries = chain.reverse();
			} else {
				entries = all;
			}

			// First user message for a default filename.
			let firstUser = "";
			for (const e of entries) {
				if (e.type === "message" && e.message?.role === "user") {
					firstUser = textOf(e.message.content).split(/\s+/).slice(0, 4).join(" ");
					break;
				}
			}

			const name = sm.getSessionName();
			const base = safeSlug(name || firstUser || new Date().toISOString());
			const out = args && args.trim() ? join(ctx.cwd, args.trim()) : join(ctx.cwd, `${base}.md`);

			const lines: string[] = [];
			lines.push(`# ${name || base}`, "");
			lines.push(`> Exported session transcript`, "");
			lines.push(`> - **File:** \`${sm.getSessionFile() ?? "(ephemeral)"}\``);
			const header = sm.getHeader && sm.getHeader();
			if (header?.cwd) lines.push(`> - **cwd:** \`${header.cwd}\``);
			lines.push(`> - **Exported:** ${new Date().toISOString()}`, "");

			for (const e of entries) {
				lines.push(...renderEntry(e));
			}

			try {
				await mkdir(dirname(out), { recursive: true });
				await writeFile(out, lines.join("\n"), "utf8");
			} catch (err) {
				ctx.ui.notify(`Export failed: ${(err as Error).message}`, "error");
				return;
			}

			ctx.ui.notify(`Exported ${entries.length} entries to ${out}\nView: ${viewUrl(out)}`);
		},
	});
}
