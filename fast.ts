import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "openai-fast-mode-state";
const STATUS_ID = "openai-fast-mode";
const PRIORITY_SERVICE_TIER = "priority";

type FastModeState = {
	enabled: boolean;
};

type ModelRef = {
	provider: string;
};

function isOpenAIProvider(model: ModelRef | undefined): boolean {
	if (!model) return false;
	return model.provider === "openai" || /^openai-codex(?:-\d+)?$/.test(model.provider);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreState(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const state = entry.data as Partial<FastModeState> | undefined;
		if (typeof state?.enabled === "boolean") enabled = state.enabled;
	}
	return enabled;
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = false;

	function updateStatus(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.setStatus(STATUS_ID, undefined);
			return;
		}
		ctx.ui.setStatus(
			STATUS_ID,
			isOpenAIProvider(ctx.model) ? "fast:⚡" : "fast:standby",
		);
	}

	function describeState(ctx: ExtensionContext): string {
		if (!enabled) return "OpenAI fast mode is off.";
		if (isOpenAIProvider(ctx.model)) {
			return "OpenAI fast mode is on. Requests use the priority service tier.";
		}
		return "OpenAI fast mode is on and will apply when an OpenAI or OpenAI Codex model is selected.";
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority processing with /fast [on|off|status]",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on", description: "Use OpenAI priority processing" },
				{ value: "off", label: "off", description: "Use the normal service tier" },
				{ value: "status", label: "status", description: "Show the current fast-mode state" },
			];
			const query = prefix.trim().toLowerCase();
			const matches = options.filter((option) => option.value.startsWith(query));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "status") {
				ctx.ui.notify(describeState(ctx), "info");
				return;
			}
			if (value && value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			enabled = value === "on" || (value === "" && !enabled);
			pi.appendEntry<FastModeState>(STATE_ENTRY_TYPE, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(describeState(ctx), "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		enabled = restoreState(ctx);
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!enabled || !isOpenAIProvider(ctx.model) || !isRecord(event.payload)) return;
		return { ...event.payload, service_tier: PRIORITY_SERVICE_TIER };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus(STATUS_ID, undefined);
	});
}
