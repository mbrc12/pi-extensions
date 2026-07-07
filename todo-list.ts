/**
 * Todo-List Extension (simplified plan mode)
 *
 * A persistent todo list the model is *forced* to consult.
 *
 * The crucial behavior — "the model auto-asks the todo list for jobs left and
 * does not ignore it" — is achieved by layering four reinforcement mechanisms:
 *
 *  1. promptGuidelines on the `todo` tool: tells the model to call
 *     `todo({ action: "list" })` at the start of every turn, to mark jobs
 *     complete as it finishes them, and to clear the list once every job is
 *     done. This is the "auto-ask".
 *  2. before_agent_start injection: every turn, a hidden message re-states the
 *     remaining todos (or reminds the model to clear the list when all are
 *     complete) so they are never out of the model's context.
 *  3. agent_end watchdog: if todos remain incomplete and the last turn made no
 *     progress, automatically send a follow-up user message (triggerTurn: true)
 *     that tells the model to continue. Capped at MAX_NUDGES consecutive
 *     no-progress turns to avoid loops, after which the user is notified.
 *  4. agent_end clear-nudge: if the model stops after all todos are marked
 *     complete but the list itself is not empty, send a single follow-up telling
 *     it to call `todo({ action: "clear" })` so stale completed todos are not
 *     left behind.
 *
 * State lives in tool-result details (not external files), so branching keeps
 * the correct todo state for that point in history — same approach as the
 * bundled todo.ts example.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoDetails {
	action: "list" | "add" | "complete" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "complete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Job text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Job ID (for complete)" })),
});
export type TodoInput = Static<typeof TodoParams>;

// Stop auto-continuing after this many consecutive no-progress turns.
const MAX_NUDGES = 3;

export default function todoListExtension(pi: ExtensionAPI): void {
	let todos: Todo[] = [];
	let nextId = 1;

	// Watchdog state
	let lastIncompleteCount = 0;
	let nudgeCount = 0;

	const remaining = (): Todo[] => todos.filter((t) => !t.done);

	function renderList(): string {
		if (todos.length === 0) return "(empty)";
		return todos
			.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`)
			.join("\n");
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (todos.length === 0) {
			ctx.ui.setStatus("todo-list", undefined);
			ctx.ui.setWidget("todo-list", undefined);
			return;
		}
		const done = todos.filter((t) => t.done).length;
		const total = todos.length;
		ctx.ui.setStatus(
			"todo-list",
			ctx.ui.theme.fg("accent", `📋 ${done}/${total}`),
		);
		const lines = todos.map((t) =>
			t.done
				? ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
				: ctx.ui.theme.fg("muted", "☐ ") + ctx.ui.theme.fg("text", t.text),
		);
		ctx.ui.setWidget("todo-list", lines);
	}

	/** Rebuild in-memory state from session entries on the current branch. */
	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = (entry as { message: { role?: string; toolName?: string; details?: unknown } }).message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details && Array.isArray(details.todos)) {
				todos = details.todos;
				nextId = details.nextId ?? nextId;
			}
		}
		lastIncompleteCount = remaining().length;
		nudgeCount = 0;
		updateWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// --- The todo tool -------------------------------------------------------
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the persistent job todo list. Actions: list (show all), add (text), complete (id), clear (only allowed when all todos are complete; otherwise use /todo-clear as the user).",
		// One-liner shown in "Available tools"
		promptSnippet: "Manage a persistent job todo list (list/add/complete/clear)",
		// Bullets appended to the Guidelines section while the tool is active.
		// Each bullet must name the tool explicitly.
		promptGuidelines: [
			"At the start of EVERY turn, call todo with action \"list\" to check which jobs remain before doing anything else. Do not skip this even if you think you remember the list.",
			"When you finish a job, immediately call todo with action \"complete\" and that job's id to mark it done.",
			"Do not end your turn while incomplete todos remain. Pick the next remaining job and continue working on it. Only stop if the user asked you to stop or you are blocked and need user input.",
			"If the list is empty and the user gives you a multi-step task, call todo with action \"add\" for each step first, then work through them.",
			"Do NOT call todo with action \"clear\" while incomplete todos remain — it is blocked.",
			"When every todo is marked complete and the user's request is fully addressed, you MUST call todo with action \"clear\" in that same turn to clear the list. Do not leave completed todos behind and do not end the turn until the list is cleared.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [
							{
								type: "text",
								text:
									(todos.length ? renderList() : "(empty)") +
									`\n\n${remaining().length} job(s) remaining.`,
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text?.trim()) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: {
								action: "add",
								todos: [...todos],
								nextId,
								error: "text required",
							} as TodoDetails,
						};
					}
					const t: Todo = { id: nextId++, text: params.text.trim(), done: false };
					todos.push(t);
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: `Added #${t.id}: ${t.text}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "complete": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for complete" }],
							details: {
								action: "complete",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const t = todos.find((x) => x.id === params.id);
					if (!t) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "complete",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					t.done = true;
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: `Completed #${t.id}: ${t.text}` }],
						details: { action: "complete", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					lastIncompleteCount = 0;
					nudgeCount = 0;
					updateWidget(ctx);
					return {
						content: [{ type: "text", text: `Cleared ${count} todo(s)` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},
	});

	// --- Guard: model cannot clear while incomplete todos remain --------------
	// `clear` is a destructive blunt instrument. The model may only call it
	// when no incomplete jobs remain (i.e. the list is fully done) — letting it
	// tidy up completed items. To wipe a list that still has open jobs, the
	// user runs /todo-clear.
	pi.on("tool_call", async (event) => {
		if (!isToolCallEventType<"todo", TodoInput>("todo", event)) return;
		if (event.input.action !== "clear") return;
		if (remaining().length > 0) {
			return {
				block: true,
				reason:
					"todo 'clear' is blocked while incomplete todos remain. Finish them first, or ask the user to run /todo-clear.",
			};
		}
	});

	// --- Per-turn reminder injection -----------------------------------------
	// - List empty (cleared): inject nothing.
	// - All complete but not cleared: show the completed list and suggest clearing.
	// - Incomplete todos remain: show the remaining list and instruct to continue.
	pi.on("before_agent_start", async () => {
		if (todos.length === 0) return;
		const rem = remaining();
		if (rem.length === 0) {
			const doneList = todos.map((t) => `- ✓ #${t.id}: ${t.text}`).join("\n");
			return {
				message: {
					customType: "todo-list-reminder",
					content:
						`[TODO LIST — all ${todos.length} job(s) complete]\n${doneList}\n\nAll todos are complete. The user's request appears fully addressed. You may call todo with action "clear" to tidy up the list; otherwise it will stay visible. Only call todo with action "add" if the user has given you a new multi-step task.`,
					display: false,
				},
			};
		}
		const list = rem.map((t) => `- #${t.id}: ${t.text}`).join("\n");
		return {
			message: {
				customType: "todo-list-reminder",
				content: `[TODO LIST — ${rem.length} job(s) remaining]
${list}

Before doing anything else this turn, call todo with action "list" to confirm the current state. Then work on the next remaining job. Mark it complete with todo action "complete" when finished. Do not stop while jobs remain unless the user asked you to stop.`,
				display: false,
			},
		};
	});

	// --- Watchdog: auto-continue when the model stops early ------------------
	pi.on("agent_end", async (_event, ctx) => {
		const rem = remaining();
		if (rem.length === 0) {
			lastIncompleteCount = 0;
			nudgeCount = 0;
			// All jobs are done but the model left completed todos in the list.
			// Nudge it once to clear them out rather than leaving stale state.
			if (todos.length > 0) {
				pi.sendUserMessage(
					"All todos are complete, but the list has not been cleared yet. " +
						'Call todo with action "clear" now to empty the list. Do not reply to the user until the todo list is empty.',
					{ deliverAs: "followUp" },
				);
			}
			return;
		}

		// Made progress this turn? Reset the nudge counter.
		if (rem.length < lastIncompleteCount) {
			nudgeCount = 0;
		} else {
			nudgeCount += 1;
		}
		lastIncompleteCount = rem.length;

		// Loop guard: after MAX_NUDGES consecutive no-progress turns, hand
		// back to the user instead of burning more tokens.
		if (nudgeCount >= MAX_NUDGES) {
			ctx.ui.notify(
				`Todo list has ${rem.length} incomplete job(s) and the agent stalled for ${nudgeCount} turns. Resuming requires your input.`,
				"warning",
			);
			return;
		}

		const next = rem[0];
		const list = rem.map((t) => `- #${t.id}: ${t.text}`).join("\n");
		// Send an actual user message so it triggers a new turn. followUp
		// ensures it's delivered only once the agent is idle.
		pi.sendUserMessage(
			`You still have ${rem.length} incomplete todo(s):\n${list}\n\n` +
				`Continue now. Start by calling todo with action "list", then work on ` +
				`#${next.id}: "${next.text}". Do not stop until all todos are complete or you need my input.`,
			{ deliverAs: "followUp" },
		);
	});

	// --- User-facing commands ------------------------------------------------
	pi.registerCommand("todo-clear", {
		description: "Clear all todos (manual override; the model cannot clear while incomplete todos remain)",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("Todo list is already empty.", "info");
				return;
			}
			const ok = await ctx.ui.confirm("Clear todos?", `Remove all ${todos.length} todo(s)?`);
			if (!ok) return;
			const count = todos.length;
			todos = [];
			nextId = 1;
			lastIncompleteCount = 0;
			nudgeCount = 0;
			updateWidget(ctx);
			ctx.ui.notify(`Cleared ${count} todo(s).`, "info");
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			if (todos.length === 0) {
				ctx.ui.notify("No todos. Ask the agent to plan a task and add todos.", "info");
				return;
			}
			const list = todos
				.map((t) => `${t.done ? "✓" : "○"} #${t.id}: ${t.text}`)
				.join("\n");
			ctx.ui.notify(`Todo list:\n${list}`, "info");
		},
	});
}
