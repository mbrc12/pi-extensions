import { complete } from "@earendil-works/pi-ai/compat";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { selectConfiguredModelWithAuth } from "./shared/model-config.ts";

const WIDGET_ID = "recap";
const IDLE_MS = 30_000;
const MAX_RECAP_LINE = 160;

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: any) => {
			if (typeof part === "string") return part;
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			return "";
		})
		.join(" ");
}

function flattenNewlines(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function conciseLine(text: string, max = Number.POSITIVE_INFINITY): string {
	const flattened = flattenNewlines(text);
	if (!flattened) return "";
	return Number.isFinite(max) && flattened.length > max
		? `${flattened.slice(0, max - 1).trimEnd()}…`
		: flattened;
}

function stripRecapPrefix(text: string): string {
	return text.replace(/^(?:now|next)\s*:\s*/i, "").trim();
}

function twoLineRecap(now: string, next: string, maxLineLength?: number): string {
	return `Now: ${conciseLine(stripRecapPrefix(now), maxLineLength) || "No active task yet."}\nNext: ${conciseLine(stripRecapPrefix(next), maxLineLength) || "Wait for the next user request."}`;
}

function renderRecapLines(recap: string, width: number, theme: any): string[] {
	const label = theme.fg("accent", "Recap:");
	const [nowLine, nextLine] = recap.split("\n").slice(0, 2);
	const nowBody = nowLine ? nowLine.replace(/^Now:\s*/, "") : "";
	const nextBody = nextLine ? nextLine.replace(/^Next:\s*/, "") : "";
	const labelWidth = 7; // visible width of "Recap:" with trailing space

	const labelPrefix = label + " ";
	const now = labelPrefix + theme.fg("success", "Now:") + " " + nowBody;
	const next = " ".repeat(labelWidth) + theme.fg("warning", "Next:") + " " + nextBody;
	return [
		truncateToWidth(now, width, theme.fg("dim", "…")),
		truncateToWidth(next, width, theme.fg("dim", "…")),
	];
}

function normalizeRecap(text: string, fallback: string): string {
	const rawLines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (rawLines.length === 0) return fallback;

	const nowIndex = rawLines.findIndex((line) => /^now\s*:/i.test(line));
	const nextIndex = rawLines.findIndex((line) => /^next\s*:/i.test(line));
	if (nowIndex !== -1 && nextIndex !== -1) {
		const now = rawLines[nowIndex];
		const extraAfterNext = rawLines
			.slice(nextIndex + 1)
			.filter((line) => !/^now\s*:/i.test(line))
			.join(" ");
		const next = [rawLines[nextIndex], extraAfterNext].filter(Boolean).join(" ");
		return twoLineRecap(now, next);
	}

	if (rawLines.length >= 2) {
		return twoLineRecap(rawLines[0], rawLines.slice(1).join(" "));
	}

	return twoLineRecap(rawLines[0], "Continue from there.");
}

function isHousekeepingUser(text: string): boolean {
	const t = flattenNewlines(text).toLowerCase();
	return (
		!t ||
		t.startsWith("all todos are complete") ||
		t.includes("call todo with action") ||
		t.includes("do not reply to the user") ||
		t === "continue" ||
		t.startsWith("queued follow-up")
	);
}

function isLowSignalAssistant(text: string): boolean {
	const t = flattenNewlines(text).toLowerCase();
	return !t || t === "done." || t === "done" || t === "ok" || t === "okay";
}

function isMainThreadMessage(message: any): boolean {
	// Ignore tool results and extension/system-ish messages; recap only the visible user/assistant conversation.
	return message?.role === "user" || message?.role === "assistant";
}

function buildConversationText(ctx: any): string {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
	const lines = entries
		.map((entry: any) => entry?.type === "message" ? entry.message : entry?.message)
		.filter(isMainThreadMessage)
		.map((message: any) => {
			const text = flattenNewlines(textFromContent(message.content));
			if (!text || (message.role === "user" && isHousekeepingUser(text)) || (message.role === "assistant" && isLowSignalAssistant(text))) {
				return undefined;
			}
			return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
		})
		.filter(Boolean) as string[];

	return lines.slice(-12).join("\n\n");
}

function fallbackRecap(ctx: any): string {
	const conversation = buildConversationText(ctx);
	const lastUser = conversation.split("\n\n").reverse().find((line) => line.startsWith("User:"));
	if (!lastUser) return twoLineRecap("No active task yet.", "Wait for the next user request.", MAX_RECAP_LINE);
	return twoLineRecap(`Working on ${lastUser.replace(/^User:\s*/, "")}.`, "Continue from there.", MAX_RECAP_LINE);
}

async function generateRecap(ctx: any): Promise<string> {
	const conversation = buildConversationText(ctx);
	if (!conversation.trim()) return fallbackRecap(ctx);

	const selected = await selectConfiguredModelWithAuth(ctx, "recapGeneration");
	if (!selected) return fallbackRecap(ctx);
	const { model, auth } = selected;

	const prompt = [
		"Write a concise idle recap for a coding-agent terminal UI.",
		"Return exactly two lines and nothing else:",
		"Now: <what is currently happening or was just done>",
		"Next: <the next action to take>",
		"Keep each line concise.",
		"Preserve Markdown formatting for file paths, symbols, commands, and names.",
		"Flatten any internal newlines in the Now/Next content into spaces.",
		"Ignore tool outputs, todo bookkeeping, meta instructions, and final status chatter.",
		"Focus on the main user/assistant work thread.",
		"Do not mention that you are summarizing.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const response = await complete(
		model,
		{
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			reasoningEffort: "low",
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ");

	return normalizeRecap(text, fallbackRecap(ctx));
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let showing = false;
	let disposed = false;
	let activeCtx: any;
	let activitySeq = 0;

	function clearTimer(): void {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function hideRecap(): void {
		if (!activeCtx?.hasUI) return;
		if (showing) {
			activeCtx.ui.setWidget(WIDGET_ID, undefined);
			showing = false;
		}
	}

	async function showRecap(): Promise<void> {
		if (!enabled || disposed || !activeCtx?.hasUI) return;
		const idle = activeCtx.isIdle?.() ?? true;
		const pending = activeCtx.hasPendingMessages?.() ?? false;
		if (!idle || pending) {
			schedule();
			return;
		}

		const requestSeq = activitySeq;
		const ctx = activeCtx;
		let recap: string;
		try {
			recap = await generateRecap(ctx);
		} catch {
			recap = fallbackRecap(ctx);
		}

		if (disposed || requestSeq !== activitySeq || !(ctx.isIdle?.() ?? true) || (ctx.hasPendingMessages?.() ?? false)) {
			return;
		}

		ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) => ({
			invalidate() {},
			render(width: number): string[] {
				return renderRecapLines(recap, width, theme);
			},
		}));
		showing = true;
	}

	function schedule(): void {
		clearTimer();
		if (!enabled || disposed || !activeCtx?.hasUI) return;
		timer = setTimeout(() => void showRecap(), IDLE_MS);
	}

	function markActive(): void {
		activitySeq++;
		hideRecap();
		schedule();
	}

	class RecapActivityEditor extends CustomEditor {
		handleInput(data: string): void {
			markActive();
			super.handleInput(data);
		}
	}

	pi.on("session_start", (_event, ctx) => {
		disposed = false;
		activeCtx = ctx;
		if (ctx.hasUI) {
			const existingFactory = ctx.ui.getEditorComponent?.();
			if (!existingFactory) {
				ctx.ui.setEditorComponent((tui: any, theme: any, kb: any) => new RecapActivityEditor(tui, theme, kb));
			}
		}
		markActive();
	});

	pi.on("input", () => markActive());
	pi.on("agent_start", () => markActive());
	pi.on("agent_end", () => markActive());
	pi.on("tool_execution_start", () => markActive());
	pi.on("tool_execution_end", () => markActive());

	pi.on("session_shutdown", (_event, ctx) => {
		disposed = true;
		clearTimer();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
		showing = false;
	});

	pi.registerCommand("recap", {
		description: "Toggle/show the idle recap widget",
		handler: async (args, ctx) => {
			activeCtx = ctx;
			const arg = args.trim().toLowerCase();
			if (arg === "off" || arg === "disable") {
				enabled = false;
				hideRecap();
				clearTimer();
				ctx.ui.notify("Idle recap disabled", "info");
				return;
			}
			if (arg === "on" || arg === "enable") {
				enabled = true;
				markActive();
				ctx.ui.notify("Idle recap enabled", "info");
				return;
			}
			await showRecap();
		},
	});
}
