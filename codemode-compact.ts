import { keyHint, type ExtensionAPI, type ToolRenderContext, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const MAX_CALLS = 6;
const VIEW = Symbol("codemode-compact-view");
type Theme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Call = { name: string; args: string; status: string; durationMs?: number; error?: string; cost?: number };
type Snapshot = { calls: Call[]; partial: boolean; error: boolean; duration?: number; failure?: string; fullOutputPath?: string; cost: number };

/** One physical line per item, even for wide characters and long arguments. */
class CompactLines implements Component {
	constructor(private readonly build: (width: number) => string[]) {}
	render(width: number): string[] {
		if (width <= 0) return [];
		return this.build(width).map((line) => truncateToWidth(line, width, "…"));
	}
	invalidate(): void {}
}

function plain(value: unknown): string {
	return typeof value === "string"
		? stripTerminalSequences(value).replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").replace(/ {2,}/g, " ").trim()
		: "";
}

function duration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function shortPath(value: string, cwd: string): string {
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	if (value.startsWith(prefix)) return value.slice(prefix.length);
	const home = process.env.HOME;
	return home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

/** Recover useful small fields even when Pi truncated the argument JSON. */
function argumentFields(raw: string): Record<string, unknown> {
	try {
		const value = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
	} catch { /* A large content/code field can truncate the JSON preview. */ }
	const fields: Record<string, unknown> = Object.create(null);
	const source = raw.trimStart();
	if (!source.startsWith("{")) return fields;
	let depth = 1;
	let quoted = false;
	let escaped = false;
	let start = 1;
	for (let index = 1; index < source.length; index++) {
		const character = source[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') { quoted = true; continue; }
		if (character === "{" || character === "[") depth++;
		if (character === "}" || character === "]") depth--;
		if ((character === "," && depth === 1) || (character === "}" && depth === 0)) {
			try {
				const field = JSON.parse(`{${source.slice(start, index)}}`);
				for (const [key, value] of Object.entries(field)) fields[key] = value;
			} catch { break; }
			start = index + 1;
		}
		if (depth <= 0) break;
	}
	// Ignore an incomplete final field. Never scan inside its string or nested value.
	return fields;
}

function callArgumentParts(call: Call, cwd: string): string[] {
	const fields = argumentFields(call.args || "");
	const path = shortPath(plain(fields.path), cwd);
	const query = plain(fields.pattern) || plain(fields.query);
	if (query) return path ? [`“${query}”`, path] : [`“${query}”`];
	if (path) return [path];
	if (plain(fields.command)) return [plain(fields.command)];
	if (plain(fields.url)) return [plain(fields.url)];
	if (plain(fields.name)) return plain(fields.agent) ? [plain(fields.name), plain(fields.agent)] : [plain(fields.name)];
	for (const key of ["action", "mode", "agent", "id"]) {
		if (plain(fields[key])) return [plain(fields[key])];
	}
	// Model calls carry provider/model text rather than argument JSON.
	if (call.name.startsWith("models.")) return [plain(call.args)];
	// Never show source, written content, prompts, or arbitrary JSON in the compact view.
	return [];
}

// A short fragment such as "r…" says nothing, so a secondary part must keep at
// least this many visible columns or it is dropped from the row.
const MIN_ARGUMENT_PART = 6;

/** Fit argument parts into the row, keeping each shown part readable. */
function fitArgument(parts: string[], width: number): string {
	if (width < 2 || parts.length === 0) return "";
	if (parts.length === 1) return truncateToWidth(parts[0], width, "…");
	const separator = " · ";
	const primaryWidth = width - Math.max(MIN_ARGUMENT_PART, Math.floor(width * 0.35)) - visibleWidth(separator);
	if (primaryWidth < MIN_ARGUMENT_PART) return truncateToWidth(parts[0], width, "…");
	const primary = truncateToWidth(parts[0], primaryWidth, "…");
	const remaining = width - visibleWidth(primary) - visibleWidth(separator);
	if (remaining < MIN_ARGUMENT_PART) return primary;
	return `${primary}${separator}${truncateToWidth(parts[1], remaining, "…")}`;
}

function scriptFailure(result: Result): string | undefined {
	const texts = result.content.filter((part) => part.type === "text").map((part) => part.text);
	for (let index = texts.length - 1; index >= 0; index--) {
		const marker = texts[index].lastIndexOf("Script error:");
		if (marker !== -1) return plain(texts[index].slice(marker + "Script error:".length).trim().split(/\r?\n/)[0]);
	}
	// Invalid options or arguments can fail before the normal script header exists.
	if (texts[0] && !texts[0].startsWith("Script completed\n") && !texts[0].startsWith("Script failed\n")) {
		return plain(texts[0].trim().split(/\r?\n/)[0]);
	}
	return undefined;
}

function snapshot(result: Result, partial: boolean, context: ToolRenderContext): Snapshot {
	const details = result.details as { calls?: Call[]; fullOutputPath?: string } | undefined;
	const calls = Array.isArray(details?.calls) ? details.calls : [];
	const header = result.content.find((part) => part.type === "text")?.text || "";
	const seconds = /^Script (?:completed|failed)\nWall time ([\d.]+) seconds\n/.exec(header)?.[1];
	const error = context.isError || /^Script failed\n/.test(header);
	return {
		calls, partial, error,
		duration: context.durationMs ?? (seconds !== undefined ? Number(seconds) * 1000 : undefined),
		failure: !partial && error ? scriptFailure(result) : undefined,
		fullOutputPath: details?.fullOutputPath,
		cost: calls.reduce((total, call) => total + (Number.isFinite(call.cost) && (call.cost ?? 0) > 0 ? call.cost! : 0), 0),
	};
}

function title(theme: Theme, context: ToolRenderContext): string {
	const view = context.state[VIEW] as Snapshot | undefined;
	let line = theme.fg("toolTitle", theme.bold("codemode"));
	if (!view) {
		return `${line} ${theme.fg("muted", context.executionStarted ? "· running" : "· preparing")}`;
	}
	const failed = view.calls.filter((call) => call.status === "error").length;
	const status = view.partial ? "running" : view.error ? "failed" : "done";
	const parts = [`${view.calls.length} ${view.calls.length === 1 ? "call" : "calls"}`, status];
	if (failed) parts.push(`${failed} failed ${failed === 1 ? "call" : "calls"}`);
	const elapsed = duration(view.duration);
	if (elapsed) parts.push(elapsed);
	if (view.cost) parts.push(`$${view.cost >= 0.01 ? view.cost.toFixed(2) : view.cost.toPrecision(2)}`);
	line += theme.fg(view.error ? "error" : "muted", ` · ${parts.join(" · ")}`);
	return line;
}

/** Prioritize failures and running calls; preserve execution order among shown rows. */
function visibleCalls(calls: Call[]): Call[] {
	const selected = new Set<number>();
	for (const status of ["error", "running", "cancelled", "ok"]) {
		for (let index = calls.length - 1; index >= 0 && selected.size < MAX_CALLS; index--) {
			if (calls[index].status === status) selected.add(index);
		}
	}
	for (let index = calls.length - 1; index >= 0 && selected.size < MAX_CALLS; index--) selected.add(index);
	return [...selected].sort((a, b) => a - b).map((index) => calls[index]);
}

function callLine(call: Call, theme: Theme, width: number, cwd: string): string {
	const [icon, color] = call.status === "ok" ? ["✓", "success"] as const
		: call.status === "error" ? ["✗", "error"] as const
		: call.status === "cancelled" ? ["⊘", "muted"] as const : ["…", "warning"] as const;
	const nameWidth = Math.min(24, Math.max(4, Math.floor(width / 3)));
	const name = truncateToWidth(plain(call.name), nameWidth, "…");
	let prefix = `  ${theme.fg(color, icon)} ${theme.fg("toolTitle", name)}`;
	const error = call.status === "error" ? plain(call.error) : "";
	const suffix = error ? ` · ${truncateToWidth(error, Math.max(12, Math.floor(width / 2)), "…")}`
		: duration(call.durationMs) ? ` · ${duration(call.durationMs)}` : "";
	const argumentWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix) - 1);
	const argument = argumentWidth > 2 ? fitArgument(callArgumentParts(call, cwd), argumentWidth) : "";
	if (argument) prefix += ` ${theme.fg("muted", argument)}`;
	return prefix + theme.fg(error ? "error" : "dim", suffix);
}

export default function codemodeCompact(pi: ExtensionAPI): void {
	pi.registerToolRenderer((name, next) => {
		const native = next();
		if (name !== "codemode") return native;
		return {
			...native,
			renderCall(args, theme, context) {
				if (context.expanded) {
					const nativeContext = { ...context, lastComponent: context.lastComponent instanceof CompactLines ? undefined : context.lastComponent };
					return native?.renderCall?.(args, theme, nativeContext) ?? new Text(`codemode\n${args?.code || ""}`, 0, 0);
				}
				// Result rendering fills shared state before the component's render() runs.
				return new CompactLines(() => [title(theme, context)]);
			},
			renderResult(result, options, theme, context) {
				const view = snapshot(result, options.isPartial, context);
				context.state[VIEW] = view;
				if (options.expanded) {
					const nativeContext = { ...context, lastComponent: context.lastComponent instanceof CompactLines ? undefined : context.lastComponent };
					return native?.renderResult?.(result, options, theme, nativeContext)
						?? new Text(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), 0, 0);
				}
				return new CompactLines((width) => {
					const shown = visibleCalls(view.calls);
					const lines = shown.map((call) => callLine(call, theme, width, context.cwd));
					const hidden = view.calls.length - shown.length;
					if (hidden) {
						const omitted = view.calls.filter((call) => !shown.includes(call));
						const failures = omitted.filter((call) => call.status === "error").length;
						lines.push(theme.fg("muted", `  + ${hidden} more calls${failures ? ` (${failures} failed)` : ""} · `) + keyHint("app.tools.expand", "to expand"));
					}
					if (view.failure) lines.push(theme.fg("error", `  Error: ${view.failure}`));
					if (view.fullOutputPath) lines.push(theme.fg("muted", `  Full output: ${shortPath(plain(view.fullOutputPath), context.cwd)}`));
					return lines;
				});
			},
		};
	});
}
