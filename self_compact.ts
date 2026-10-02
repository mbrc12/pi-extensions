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
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TOOL_NAME = "self_compact";
const CUSTOM_TYPE = "self_compact";
const MAX_NOTE_CHARS = 20_000;
const MAX_INSTRUCTIONS_CHARS = 2_000;

interface PendingRequest {
	id: string;
	message: string;
	instructions?: string;
}

interface NoteDetails {
	id: string;
	status: "compacted" | "skipped";
	error?: string;
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

export default function (pi: ExtensionAPI) {
	let pending: PendingRequest | undefined;

	pi.on("session_start", () => {
		pending = undefined;
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
		const skipped = details?.status === "skipped";
		const heading = skipped ? "self_compact skipped" : "self_compact note";
		const headingLine = theme.fg(skipped ? "warning" : "accent", theme.bold(heading));
		const body = stringContent(message.content);
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${headingLine}\n${body}`, 1, 0));
		return box;
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Self compact",
		description:
			"Compact the conversation context at the end of this turn and receive a note you write to yourself. " +
			"Call this when you reach a natural boundary: a unit of work is finished, the context is large, and you want to " +
			"continue with more room. The conversation is summarized by Pi's normal compaction, and your note is delivered as " +
			"the first message of the new context. Everything summarized away stays stored in the session and remains " +
			"searchable with the context_recall tool, so the note only needs the goal, decisions, and next steps you need to " +
			"keep acting. Do not call this in the middle of a step you cannot describe in the note.",
		promptSnippet:
			"Compact the context at a natural boundary and receive a note you write to yourself afterwards.",
		promptGuidelines: [
			"Call self_compact only at a natural boundary, after finishing a step of work and before starting the next one.",
			"The note you pass to self_compact is your only context after compaction; include the goal, decisions, and next steps.",
			"The full history stays available through the context_recall tool even after compaction.",
		],
		parameters: Type.Object({
			message: Type.String({
				minLength: 1,
				maxLength: MAX_NOTE_CHARS,
				description:
					"Note to your future self. It is delivered as the first message after compaction, so include the current goal, decisions, and next steps.",
			}),
			instructions: Type.Optional(
				Type.String({
					maxLength: MAX_INSTRUCTIONS_CHARS,
					description:
						"Optional extra focus for the summarizer, for example which files, constraints, or open questions matter most.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
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
		const request = pending;
		if (!request) return;
		pending = undefined;
		// A user interrupt must not silently start a new turn after compaction.
		if (event.outcome !== "completed") return;
		startCompaction(pi, ctx, request);
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
