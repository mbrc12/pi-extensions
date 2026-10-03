import { CustomEditor, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import { completeWithModelFallback } from "./shared/model-config.ts";

const WIDGET_ID = "recap";
const IDLE_MS = 30_000;
const RECAP_CONTEXT_MESSAGES = 24;

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

function stripRecapPrefix(text: string): string {
	return text.replace(/^(?:now|next)\s*:\s*/i, "").trim();
}

function oneParagraphRecap(text: string, fallback: string): string {
	// Never truncate: a clipped recap loses the part that says what comes next.
	return flattenNewlines(stripRecapPrefix(text)) || fallback;
}

/**
 * Markdown theme for the recap. The widget styles the whole line italic itself, so
 * the model's own bold and strikethrough must not punch through it: they render as
 * plain text and inherit the italic default. Emphasis already matches the widget's
 * styling, so it keeps the theme's own rendering.
 */
function recapMarkdownTheme(): MarkdownTheme {
	const base = getMarkdownTheme();
	return { ...base, bold: (text: string) => text, strikethrough: (text: string) => text };
}

function renderRecap(recap: string, theme: any): Container {
	const container = new Container();

	container.addChild(new Text(theme.fg("accent", "Recap:"), 0, 0));
	// Use Pi's Markdown component so paths, commands, symbols, and other inline
	// Markdown in the generated recap render the same way as assistant output. The
	// italic default style keeps the column italic whatever the model emitted.
	container.addChild(new Markdown(
		recap,
		0,
		0,
		recapMarkdownTheme(),
		{ italic: true },
	));
	return container;
}

function normalizeRecap(text: string, fallback: string): string {
	// Tolerate any Now/Next labels the model returns: fold them into one paragraph.
	const body = text
		.split(/\r?\n/)
		.map((line) => stripRecapPrefix(line.trim()))
		.filter(Boolean)
		.join(" ");

	return oneParagraphRecap(body, fallback);
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

	return lines.slice(-RECAP_CONTEXT_MESSAGES).join("\n\n");
}

function fallbackRecap(ctx: any): string {
	const conversation = buildConversationText(ctx);
	const lastUser = conversation.split("\n\n").reverse().find((line) => line.startsWith("User:"));
	if (!lastUser) return oneParagraphRecap("No active task yet.", "No active task yet.");
	return oneParagraphRecap(`Working on ${lastUser.replace(/^User:\s*/, "")}.`, "Continue from there.");
}

async function generateRecap(ctx: any): Promise<string> {
	const conversation = buildConversationText(ctx);
	if (!conversation.trim()) return fallbackRecap(ctx);

	const prompt = [
		"Write a short idle recap for a coding-agent terminal UI.",
		"Return only the recap text, nothing else.",
		"Give the broader objective, the key completed result or current blocker, and what happens next, in that order.",
		"Write 1.5 to 2.5 terminal lines: about 120 to 200 characters, one paragraph.",
		"Incomplete sentences, fragments, and telegraphic style are fine; complete sentences are not required.",
		"Include important files, decisions, or results when they provide needed context; omit routine commands and implementation detail.",
		"Preserve Markdown formatting for file paths, symbols, commands, and names.",
		"Do not add emphasis markers such as ** or *; the widget styles the whole line for you.",
		"Do not use Now:/Next: labels, and flatten any internal newlines into spaces.",
		"Ignore tool outputs, todo bookkeeping, meta instructions, and final status chatter.",
		"Focus on the main user/assistant work thread.",
		"Do not mention that you are summarizing.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const { response } = await completeWithModelFallback(
		ctx,
		"recapGeneration",
		{
			messages: [{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			}],
		},
		{
			signal: ctx.signal,
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

		ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) => renderRecap(recap, theme));
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
