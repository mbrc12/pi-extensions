import { complete } from "@earendil-works/pi-ai/compat";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const WIDGET_ID = "recap";
const IDLE_MS = 30_000;
const MAX_TEXT = 120;
const RECAP_PROVIDER = "opencode-go";
const RECAP_MODEL_ID = "deepseek-v4-pro";

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

function clean(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " code block ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[#*_>\-[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function brief(text: string, max = MAX_TEXT): string {
	const cleaned = clean(text);
	if (!cleaned) return "";
	return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}


function isHousekeepingUser(text: string): boolean {
	const t = clean(text).toLowerCase();
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
	const t = clean(text).toLowerCase();
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
			const text = clean(textFromContent(message.content));
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
	if (!lastUser) return "No active task yet.";
	return brief(`We were working on ${lastUser.replace(/^User:\s*/, "")}. Next, continue from there.`, 260);
}

async function generateRecap(ctx: any): Promise<string> {
	const conversation = buildConversationText(ctx);
	if (!conversation.trim()) return "No active task yet.";

	const model = ctx.modelRegistry.find(RECAP_PROVIDER, RECAP_MODEL_ID);
	const auth = model ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : undefined;
	if (!model || !auth?.ok || !auth.apiKey) return fallbackRecap(ctx);

	const prompt = [
		"Write a very brief idle recap for a coding-agent terminal UI.",
		"Use exactly one natural sentence, no headings or labels.",
		"Say what we were doing and what should happen next.",
		"Ignore tool outputs, todo bookkeeping, meta instructions, and final status chatter.",
		"Focus on the main user/assistant work thread.",
		"Do not mention that you are summarizing.",
		"Keep it under 35 words.",
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

	return brief(text || fallbackRecap(ctx), 260);
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
				const title = theme.fg("accent", "Recap") + theme.fg("dim", " — idle 30s");
				const recapLines = wrapTextWithAnsi(recap, width).slice(0, 4);
				return [
					truncateToWidth(title, width, theme.fg("dim", "…")),
					...recapLines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…"))),
				];
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
