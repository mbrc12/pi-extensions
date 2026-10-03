/**
 * Self-compaction at natural boundaries.
 *
 * The `self_compact` tool lets the model decide that the current turn is a good
 * place to compact the context. The model passes a note to its future self. Pi
 * compacts at the end of that turn, then delivers the note as the first thing
 * the model reads in the new context.
 *
 * Compaction itself is Pi's normal manual compaction, so the usual summary
 * format and the `session_before_compact` hook still apply. The note is a
 * custom message, which Pi sends to the model as a user-role message.
 *
 * Two extras keep the model informed:
 * - `status: true` on the tool reports the current context usage and schedules
 *   nothing, so the model can check the room it has left before it decides.
 * - After a turn, usage at or above the configured threshold (90% by default,
 *   set with `/self_compact <percent>`) sends the model an alert with a turn
 *   trigger, so it can write a note instead of letting Pi's silent automatic
 *   compaction drop details. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "self_compact";
const COMMAND_NAME = "self_compact";
const CUSTOM_TYPE = "self_compact";
const MAX_NOTE_CHARS = 20_000;
const MAX_INSTRUCTIONS_CHARS = 2_000;

/** Alert threshold used when the user configures nothing. */
export const DEFAULT_NOTIFY_PERCENT = 90;
/** The alert re-arms this many percentage points below the threshold. */
export const NOTIFY_HYSTERESIS = 10;

/**
 * Alert threshold for this process, or null when the alert is off.
 *
 * Pi gives extensions no way to write settings, and a preference is not worth a
 * file of its own, so the value lives in memory: it survives new sessions in
 * one running Pi, and reverts to {@link DEFAULT_NOTIFY_PERCENT} on restart.
 */
let notifyPercent: number | null = DEFAULT_NOTIFY_PERCENT;

export function getNotifyPercent(): number | null {
	return notifyPercent;
}

export function setNotifyPercent(value: number | null): void {
	notifyPercent = value;
}

/** Usage must fall below this before the alert can fire again. */
export function clearPercentFor(threshold: number): number {
	return Math.max(0, threshold - NOTIFY_HYSTERESIS);
}

/** One-line description of the current setting, used by the command's notifications. */
export function describeThreshold(threshold: number | null): string {
	return threshold === null
		? "Context alert off. Turn it on with /self_compact on, or pick a percentage from 1 to 100."
		: `Context alert at ${threshold}% usage. Run /self_compact off to disable it.`;
}

export type ThresholdCommand =
	| { kind: "show" }
	| { kind: "off" }
	| { kind: "default" }
	| { kind: "set"; percent: number }
	| { kind: "invalid"; reason: string };

/** Parse a `/self_compact` argument. */
export function parseThresholdArgument(argument: string): ThresholdCommand {
	const text = argument.trim();
	if (text === "") return { kind: "show" };
	const lower = text.toLowerCase();
	if (lower === "off" || lower === "none" || lower === "disable") return { kind: "off" };
	if (lower === "on" || lower === "default" || lower === "reset") return { kind: "default" };
	const percent = Number(text);
	if (!Number.isFinite(percent)) return { kind: "invalid", reason: `\"${text}\" is not a percentage` };
	if (percent < 1 || percent > 100) return { kind: "invalid", reason: "use a percentage from 1 to 100" };
	return { kind: "set", percent: Math.round(percent) };
}

interface PendingRequest {
	id: string;
	message: string;
	instructions?: string;
}

interface NoteDetails {
	id: string;
	status: "compacted" | "skipped" | "alert" | "status";
	error?: string;
	usage?: Usage;
}

/** Context usage as reported by Pi. */
export interface Usage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

function stringContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
		.join("");
}

/** Note the model reads after a successful compaction. */
export function buildNote(request: PendingRequest): string {
	return [
		"**Self-compaction complete.** Your context is now the summary above plus the messages you kept.",
		"",
		"Note to self:",
		"",
		request.message,
		"",
		"Details the summary dropped are still stored in the session. Use the context_recall tool to search them if you need them.",
	].join("\n");
}

/** Note the model reads when compaction did not run, so its context is unchanged. */
export function buildFailureNote(request: PendingRequest, error: string): string {
	return [
		`**Self-compaction did not run** (${error}). Your context is unchanged, so continue from here.`,
		"",
		"Note you queued before the attempt:",
		"",
		request.message,
	].join("\n");
}

/** True when a compaction error means the user or runtime cancelled it. */
export function isCancellation(error: string): boolean {
	return /\b(abort|cancel)/i.test(error);
}

/** Compact token counts, for example `188k` or `1.2M`. */
export function formatTokens(value: number): string {
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** One-line usage summary, for example `94% of 200k tokens (188k used)`. */
export function describeUsage(usage: Usage | undefined): string {
	if (!usage || usage.percent === null || usage.tokens === null) {
		return "unknown (no assistant response since the last compaction)";
	}
	return `${usage.percent.toFixed(0)}% of ${formatTokens(usage.contextWindow)} tokens (${formatTokens(usage.tokens)} used)`;
}

/** Answer to a `status: true` call. It never compacts. */
export function buildStatusReport(
	usage: Usage | undefined,
	scheduled: boolean,
	notifyPercent: number | null = DEFAULT_NOTIFY_PERCENT,
): string {
	const lines = [`**Context usage: ${describeUsage(usage)}.**`, ""];
	if (scheduled) {
		lines.push("A compaction is already scheduled for the end of this turn.", "");
	}
	lines.push(
		notifyPercent === null
			? "The automatic high-usage alert is off."
			: `The automatic alert fires at ${notifyPercent}% usage.`,
		"",
	);
	const nearlyFull = notifyPercent !== null && usage?.percent !== null && usage?.percent !== undefined && usage.percent >= notifyPercent;
	lines.push(
		nearlyFull
			? "The context is nearly full. Compact at your next natural boundary, while still giving a note to your future self."
			: "Give a `message` note to compact at the end of this turn, or keep working if there is room.",
	);
	return lines.join("\n");
}

/** Alert the model reads when usage crosses the configured threshold. */
export function buildUsageAlert(usage: Usage, notifyPercent: number): string {
	return [
		`**Context is nearly full: ${describeUsage(usage)}.**`,
		"",
		`Once the context passes Pi's threshold, Pi compacts by itself before the next request. That automatic compaction has no note from you, so details you still need can be summarized away. The alert fires once per crossing, at ${notifyPercent}%.`,
		"",
		"If you are at a natural boundary, call self_compact now with a note holding the goal, decisions, and next steps. If you are mid-step, finish it and compact at the next boundary. Check the room left with `self_compact { status: true }`.",
	].join("\n");
}

/** True when usage is high enough to alert, and no alert is outstanding. */
export function shouldAlertUsage(
	usage: Usage | undefined,
	alreadyAlerted: boolean,
	notifyPercent: number | null = DEFAULT_NOTIFY_PERCENT,
): boolean {
	if (alreadyAlerted) return false;
	if (notifyPercent === null) return false;
	if (!usage || usage.percent === null) return false;
	return usage.percent >= notifyPercent;
}

export default function (pi: ExtensionAPI) {
	let pending: PendingRequest | undefined;
	// Set while usage stays above the alert threshold, so one crossing alerts once.
	let usageAlerted = false;

	pi.on("session_start", () => {
		pending = undefined;
		usageAlerted = false;
	});

	// Pi restores a resumed session's tool loadout from that session's transcript,
	// so a tool registered after the session was created is missing from the tool
	// list the model sees. Re-assert it on the next prompt. `getAllTools()` leaves
	// out tools that CLI flags disabled, so an explicit opt-out still wins.
	pi.on("before_agent_start", () => {
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) return;
		if (!pi.getAllTools().some((tool) => tool.name === TOOL_NAME)) return;
		pi.setActiveTools([...active, TOOL_NAME]);
	});

	pi.registerMessageRenderer(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const details = message.details as NoteDetails | undefined;
		const status = details?.status;
		const heading =
			status === "skipped" ? "self_compact skipped"
			: status === "alert" ? "context nearly full"
			: status === "status" ? "context usage"
			: "self_compact note";
		const warn = status === "skipped" || status === "alert";
		const headingLine = theme.fg(warn ? "warning" : "accent", theme.bold(heading));
		const body = stringContent(message.content);
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${headingLine}\n${body}`, 1, 0));
		return box;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: `Set the context-alert threshold: /${COMMAND_NAME} 85, /${COMMAND_NAME} off, or /${COMMAND_NAME} to show it`,
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: String(DEFAULT_NOTIFY_PERCENT), label: String(DEFAULT_NOTIFY_PERCENT), description: "Alert at this usage (default)" },
				{ value: "80", label: "80", description: "Alert earlier" },
				{ value: "95", label: "95", description: "Alert later, after Pi's own compaction starts" },
				{ value: "off", label: "off", description: "Disable the automatic alert" },
				{ value: "on", label: "on", description: "Restore the default alert" },
			];
			const normalized = prefix.trim().toLowerCase();
			return options.filter((option) => option.value.startsWith(normalized));
		},
		handler: (args, ctx) => {
			const command = parseThresholdArgument(args);
			if (command.kind === "show") {
				ctx.ui.notify(describeThreshold(getNotifyPercent()), "info");
				return;
			}
			if (command.kind === "invalid") {
				ctx.ui.notify(`/self_compact: ${command.reason}.`, "warning");
				return;
			}
			setNotifyPercent(
				command.kind === "off" ? null
				: command.kind === "default" ? DEFAULT_NOTIFY_PERCENT
				: command.percent,
			);
			// A new threshold starts a fresh episode, so the next crossing alerts again.
			usageAlerted = false;
			ctx.ui.notify(describeThreshold(getNotifyPercent()), "info");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Self compact",
		description:
			"Compact the conversation context at the end of this turn and receive a note you write to yourself, or report the " +
			"current context usage with `status: true`. Call this when you reach a natural boundary: a unit of work is finished, " +
			"the context is large, and you want to continue with more room. The conversation is summarized by Pi's normal " +
			"compaction, and your note is delivered as the first message of the new context. Everything summarized away stays " +
			"stored in the session and remains searchable with the context_recall tool, so the note only needs the goal, " +
			"decisions, and next steps you need to keep acting. Use `status: true` to check how full the context is before you " +
			"decide. Do not compact in the middle of a step you cannot describe in the note.",
		promptSnippet:
			"Compact the context at a natural boundary and receive a note you write to yourself, or report the current context usage.",
		promptGuidelines: [
			"Call self_compact only at a natural boundary, after finishing a step of work and before starting the next one.",
			"The note you pass to self_compact is your only context after compaction; include the goal, decisions, and next steps.",
			"The full history stays available through the context_recall tool even after compaction.",
			"Pass `status: true` to read the current context usage percentage without compacting.",
			"When a message warns that the context is nearly full, write your note and compact at your next natural boundary.",
		],
		parameters: Type.Object({
			message: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: MAX_NOTE_CHARS,
					description:
						"Note to your future self. It is delivered as the first message after compaction, so include the current goal, decisions, and next steps. Required unless `status` is true.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					maxLength: MAX_INSTRUCTIONS_CHARS,
					description:
						"Optional extra focus for the summarizer, for example which files, constraints, or open questions matter most.",
				}),
			),
			status: Type.Optional(
				Type.Boolean({
					description:
						"Report the current context usage and this turn's plan, without compacting. Use it to decide whether compaction is needed.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const usage: Usage | undefined = ctx?.getContextUsage?.();
			if (params.status) {
				return {
					content: [{ type: "text", text: buildStatusReport(usage, pending !== undefined, getNotifyPercent()) }],
					details: { id: "status", status: "status", usage },
				};
			}
			if (!params.message) {
				return {
					content: [
						{
							type: "text",
							text: "Pass a `message` note to schedule compaction, or `status: true` to read the context usage alone.",
						},
					],
					details: { id: "invalid", status: "skipped", error: "missing message" },
					isError: true,
				};
			}
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const request: PendingRequest = { id, message: params.message, instructions: params.instructions };
			if (pending) {
				request.message = `${pending.message}\n\n${request.message}`;
				request.instructions = params.instructions ?? pending.instructions;
			}
			pending = request;
			return {
				content: [
					{
						type: "text",
						text: "Self-compaction scheduled for the end of this turn. After it finishes you will receive your note. The conversation history stays searchable with context_recall.",
					},
				],
				details: { id, status: "scheduled" },
			};
		},
	});

	pi.on("turn_end", (event, ctx) => {
		// A queued request never carries into a later turn, and a user interrupt
		// must not silently start a new turn after compaction.
		const request = pending;
		pending = undefined;
		if (event.outcome !== "completed") return;
		if (request) {
			startCompaction(pi, ctx, request);
			return;
		}

		// Warn the model once per high-usage episode, so it can write a note
		// before Pi's own automatic compaction runs without one.
		const threshold = getNotifyPercent();
		const usage: Usage | undefined = ctx.getContextUsage?.();
		const percent = usage?.percent;
		if (threshold !== null && typeof percent === "number" && percent < clearPercentFor(threshold)) {
			usageAlerted = false;
		}
		if (!shouldAlertUsage(usage, usageAlerted, threshold)) return;
		usageAlerted = true;
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: buildUsageAlert(usage as Usage, threshold),
				display: true,
				details: { id: "usage-alert", status: "alert", usage },
			},
			{ triggerTurn: true },
		);
	});
}

function startCompaction(pi: ExtensionAPI, ctx: ExtensionContext, request: PendingRequest): void {
	const details: NoteDetails = { id: request.id, status: "compacted" };
	ctx.compact({
		customInstructions: request.instructions,
		onComplete: () => {
			pi.sendMessage({ customType: CUSTOM_TYPE, content: buildNote(request), display: true, details }, { triggerTurn: true });
		},
		onError: (error) => {
			const message = error.message || String(error);
			// Cancellation means the user stopped the run; do not start a new turn.
			if (isCancellation(message)) return;
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: buildFailureNote(request, message), display: true, details: { ...details, status: "skipped", error: message } },
				{ triggerTurn: true },
			);
		},
	});
}
