#!/usr/bin/env node
/**
 * Pane renderer for one agent session file.
 *
 * Runs inside a tmux window and follows a pi session JSONL transcript, printing
 * each new message as readable text. It is deliberately dependency-free and
 * self-contained: it is spawned as a plain `node <this file>` process, so it
 * cannot import the TypeScript extensions.
 *
 * Usage: node tmux-viewer.mjs <session.jsonl> [--title <name>]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const POLL_MS = 400;
const MAX_TOOL_LINES = 12;
const MAX_RESULT_CHARS = 4000;

const argv = process.argv.slice(2);
const sessionFile = argv[0];
const titleIndex = argv.indexOf("--title");
const title = titleIndex >= 0 ? argv[titleIndex + 1] : "agent";

const useColor = !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = (text) => paint("2", text);
const bold = (text) => paint("1", text);
const cyan = (text) => paint("36", text);
const red = (text) => paint("31", text);
const green = (text) => paint("32", text);

function columns() {
	return Math.max(40, Number(process.stdout.columns) || 100);
}

/** Split one line into chunks no wider than the terminal, on word boundaries. */
function wrap(text, width, indent) {
	const out = [];
	for (const rawLine of String(text).split("\n")) {
		if (rawLine.length <= width) {
			out.push(indent + rawLine);
			continue;
		}
		let line = "";
		for (const word of rawLine.split(/(\s+)/)) {
			if (!word) continue;
			if (line && line.length + word.length > width) {
				out.push(indent + line.trimEnd());
				line = word.trimStart();
			} else {
				line += word;
			}
		}
		if (line.trim()) out.push(indent + line.trimEnd());
	}
	return out;
}

function textParts(content) {
	if (typeof content === "string") return [{ kind: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.flatMap((part) => {
		if (typeof part === "string") return [{ kind: "text", text: part }];
		if (!part || typeof part !== "object") return [];
		if (part.type === "text" && typeof part.text === "string") return [{ kind: "text", text: part.text }];
		if (part.type === "toolCall") return [{ kind: "toolCall", name: part.name, arguments: part.arguments }];
		if (part.type === "image") return [{ kind: "text", text: "[image]" }];
		return [];
	});
}

function argumentSummary(args) {
	if (!args || typeof args !== "object") return String(args ?? "");
	return Object.entries(args)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			const flat = String(text ?? "").replace(/\s+/g, " ");
			return `${key}=${flat.length > 90 ? `${flat.slice(0, 90)}…` : flat}`;
		})
		.join(" ");
}

function renderMessage(message) {
	const width = columns() - 4;
	const lines = [];
	const role = message?.role;
	const parts = textParts(message?.content);

	if (role === "user") {
		for (const part of parts) {
			if (part.kind !== "text") continue;
			lines.push(...wrap(part.text, width, "  ").map((line) => dim(line)));
		}
	} else if (role === "assistant") {
		for (const part of parts) {
			if (part.kind === "text") {
				lines.push(...wrap(part.text, width, "  "));
			} else if (part.kind === "toolCall") {
				lines.push(`${green("●")} ${cyan(part.name ?? "tool")} ${dim(argumentSummary(part.arguments))}`);
			}
		}
	} else if (role === "toolResult") {
		const body = parts
			.filter((part) => part.kind === "text")
			.map((part) => part.text)
			.join("\n");
		const truncated = body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n… truncated` : body;
		const block = wrap(truncated, width, "  ").slice(0, MAX_TOOL_LINES);
		if (body.length) {
			lines.push(dim(`  ⎿ ${message.toolName ?? "result"}${message.isError ? " (error)" : ""}`));
			lines.push(...block.map((line) => (message.isError ? red(line) : dim(line))));
		}
	}
	return lines.length ? ["", ...lines] : [];
}

function renderEntry(entry) {
	if (!entry || typeof entry !== "object") return [];
	if (entry.type !== "message" || !entry.message) return [];
	return renderMessage(entry.message);
}

function header() {
	const rows = [
		`${bold(title)} ${dim("— agent transcript")}`,
		dim(path.basename(sessionFile ?? "unknown")),
	];
	return rows;
}

let offset = 0;
let pending = "";
let announced = false;
let firstContent = true;
let lastSize = -1;

function emit(lines) {
	if (lines.length === 0) return;
	process.stdout.write(`${lines.join("\n")}\n`);
}

function reset() {
	offset = 0;
	pending = "";
	lastSize = -1;
}

function poll() {
	let size;
	try {
		size = fs.statSync(sessionFile).size;
	} catch {
		return; // The child has not written its first entry yet.
	}
	if (size === lastSize) return;
	lastSize = size;
	if (size < offset) reset();

	if (!announced) {
		announced = true;
		process.stdout.write("\x1b[2J\x1b[H");
		emit(header());
		emit([dim("waiting for the first message…")]);
	}

	const length = size - offset;
	if (length <= 0) return;
	if (firstContent) {
		firstContent = false;
		// Replace the waiting line instead of letting it linger above the first message.
		process.stdout.write("\x1b[2J\x1b[H");
		emit(header());
	}
	let chunk;
	try {
		const handle = fs.openSync(sessionFile, "r");
		const buffer = Buffer.alloc(length);
		fs.readSync(handle, buffer, 0, length, offset);
		fs.closeSync(handle);
		chunk = buffer.toString("utf8");
	} catch {
		return;
	}
	offset = size;

	const text = pending + chunk;
	const lines = text.split("\n");
	pending = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		emit(renderEntry(entry));
	}
}

if (!sessionFile) {
	process.stderr.write("usage: tmux-viewer.mjs <session.jsonl> [--title <name>]\n");
	process.exit(2);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));

setInterval(() => {
	try {
		poll();
	} catch {
		// A pane must never die because one transcript line was unreadable.
	}
}, POLL_MS);
poll();
