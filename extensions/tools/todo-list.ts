/**
 * Todo-List Extension (simplified plan mode)
 *
 * A persistent todo list with optional per-turn model-context injection.
 *
 * The extension provides:
 *
 *  1. promptGuidelines on the `todo` tool: one instruction to update the list as
 *     appropriate when one exists. It does not tell the model when to start or
 *     stop working.
 *  2. Optional before_agent_start system-prompt injection: when enabled with
 *     `/todo-inject on`, the per-turn system prompt re-states the remaining and
 *     completed todos without adding a transcript message. Injection is off by
 *     default and can be disabled with `/todo-inject off`.
 *
 * The extension never nudges the model or re-prompts it.
 *
 * Tool actions persist state in tool-result details. User commands persist
 * state in custom session entries because commands do not produce tool
 * results. Both entry types are branch-aware, so each branch restores the
 * correct todo state.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
	completedAt?: number;
}

interface TodoDetails {
	action: "list" | "add" | "complete" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

interface TodoStateEntryData {
	todos: Todo[];
	nextId: number;
}

interface TodoInjectStateEntryData {
	enabled: boolean;
}

const TODO_STATE_ENTRY_TYPE = "todo-list-state";
const TODO_INJECT_STATE_ENTRY_TYPE = "todo-list-inject-state";

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "complete", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Job text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Job ID (for complete)" })),
});
export type TodoInput = Static<typeof TodoParams>;

const COMPLETED_DISPLAY_MS = 10_000;
const WIDGET_REFRESH_MS = 100;
const MAX_WIDGET_ITEMS = 5;
export default function todoListExtension(pi: ExtensionAPI): void {
	let todos: Todo[] = [];
	let nextId = 1;
	let injectEnabled = false;

	let widgetRefreshTimer: ReturnType<typeof setInterval> | undefined;
	let widgetContext: ExtensionContext | undefined;

	const remaining = (): Todo[] => todos.filter((t) => !t.done);
	const completed = (): Todo[] => todos.filter((t) => t.done);

	function renderList(): string {
		if (todos.length === 0) return "(empty)";
		return todos
			.map((t) => `${t.done ? "🟢" : "⭕"} #${t.id}: ${t.text}`)
			.join("\n");
	}

	function renderTodoSystemPrompt(): string {
		const rem = remaining();
		const done = completed();
		const remainingList = rem.length
			? rem.map((t) => `- ⭕ #${t.id}: ${t.text}`).join("\n")
			: "- (none)";
		const completedList = done.length
			? done.map((t) => `- 🟢 #${t.id}: ${t.text}`).join("\n")
			: "- (none)";
		const instructions =
			"If a todo list exists, call todo to update it as appropriate as you work.";

		return `<todo_state>\n[TODO STATE — ${rem.length} remaining, ${done.length} completed, ${todos.length} total]\n\nRemaining:\n${remainingList}\n\nCompleted:\n${completedList}\n\n${instructions}\n</todo_state>`;
	}

	function stopWidgetRefresh(): void {
		if (widgetRefreshTimer) {
			clearInterval(widgetRefreshTimer);
			widgetRefreshTimer = undefined;
		}
		widgetContext = undefined;
	}

	function hasFadingCompletedTodos(now = Date.now()): boolean {
		return todos.some(
			(t) =>
				t.done &&
				typeof t.completedAt === "number" &&
				t.completedAt > 0 &&
				t.completedAt + COMPLETED_DISPLAY_MS > now,
		);
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
			ctx.ui.theme.fg("accent", `📋 ${done}/${total}${injectEnabled ? " 📌" : ""}`),
		);

		const now = Date.now();
		const lines = todos.flatMap((t) => {
			if (!t.done) {
				return [ctx.ui.theme.fg("muted", "⭕ ") + ctx.ui.theme.fg("text", t.text)];
			}

			const expiresAt = t.completedAt ? t.completedAt + COMPLETED_DISPLAY_MS : 0;
			const remainingMs = expiresAt - now;
			if (remainingMs <= 0) return [];

			const fraction = Math.min(1, remainingMs / COMPLETED_DISPLAY_MS);
			const barWidth = 5;
			const filled = Math.max(1, Math.ceil(fraction * barWidth));
			const bar = "━".repeat(filled) + "─".repeat(barWidth - filled);
			return [
				ctx.ui.theme.fg("success", "🟢 ") +
					ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text)) +
					ctx.ui.theme.fg("warning", ` ${bar}`),
			];
		}).slice(0, MAX_WIDGET_ITEMS);
		ctx.ui.setWidget("todo-list", lines.length > 0 ? lines : undefined);
	}

	function refreshWidget(ctx: ExtensionContext): void {
		updateWidget(ctx);
		const now = Date.now();
		if (!hasFadingCompletedTodos(now)) {
			stopWidgetRefresh();
			return;
		}
		widgetContext = ctx;
		if (!widgetRefreshTimer) {
			widgetRefreshTimer = setInterval(() => {
				if (!widgetContext) return;
				updateWidget(widgetContext);
				if (!hasFadingCompletedTodos()) stopWidgetRefresh();
			}, WIDGET_REFRESH_MS);
		}
	}

	/** Rebuild in-memory state from session entries on the current branch. */
	function reconstructState(ctx: ExtensionContext): void {
		todos = [];
		nextId = 1;
		injectEnabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			let state: TodoStateEntryData | undefined;

			if (entry.type === "message") {
				const msg = (entry as { message: { role?: string; toolName?: string; details?: unknown } }).message;
				if (msg.role === "toolResult" && msg.toolName === "todo") {
					state = msg.details as TodoDetails | undefined;
				}
			} else if (entry.type === "custom") {
				if (entry.customType === TODO_STATE_ENTRY_TYPE) {
					state = entry.data as TodoStateEntryData | undefined;
				} else if (entry.customType === TODO_INJECT_STATE_ENTRY_TYPE) {
					const injectState = entry.data as { enabled?: unknown } | undefined;
					if (typeof injectState?.enabled === "boolean") injectEnabled = injectState.enabled;
				}
			}

			if (state && Array.isArray(state.todos)) {
				todos = state.todos;
				nextId = state.nextId ?? nextId;
			}
		}
		refreshWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_shutdown", () => {
		stopWidgetRefresh();
	});

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
			"If a todo list exists, call todo to update it as appropriate as you work.",
		],
		parameters: TodoParams,
		// Todo mutations are bookkeeping. Keep their tool rows out of the transcript;
		// the todo widget and `/todos` command are the user-facing list.
		renderShell: "self",
		renderCall: () => new Container(),
		renderResult: () => new Container(),

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
					refreshWidget(ctx);
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
					t.completedAt = Date.now();
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Completed #${t.id}: ${t.text}` }],
						details: { action: "complete", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					stopWidgetRefresh();
					refreshWidget(ctx);
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
					"todo 'clear' is blocked while incomplete todos remain. To wipe the list, ask the user to run /todo-clear.",
			};
		}
	});

	// --- Per-turn system-prompt injection -------------------------------------
	// - List empty (cleared): inject nothing.
	// - List non-empty: inject the current list and a neutral update instruction.
	pi.on("before_agent_start", async (event) => {
		if (!injectEnabled || todos.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${renderTodoSystemPrompt()}` };
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
			stopWidgetRefresh();
			refreshWidget(ctx);
			pi.appendEntry<TodoStateEntryData>(TODO_STATE_ENTRY_TYPE, { todos: [], nextId: 1 });
			ctx.ui.notify(`Cleared ${count} todo(s).`, "info");
		},
	});

	pi.registerCommand("todo-inject", {
		description: "Toggle per-turn todo-list context injection with /todo-inject on|off",
		getArgumentCompletions: (prefix) => {
			const options = [
				{ value: "on", label: "on", description: "Inject the current todo list each turn" },
				{ value: "off", label: "off", description: "Do not inject the todo list each turn" },
			];
			const matches = options.filter((option) => option.value.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /todo-inject on|off", "warning");
				return;
			}
			injectEnabled = value === "on";
			refreshWidget(ctx);
			pi.appendEntry<TodoInjectStateEntryData>(TODO_INJECT_STATE_ENTRY_TYPE, {
				enabled: injectEnabled,
			});
			ctx.ui.notify(`Todo-list injection ${injectEnabled ? "enabled" : "disabled"}.`, "info");
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
				.map((t) => `${t.done ? "🟢" : "⭕"} #${t.id}: ${t.text}`)
				.join("\n");
			ctx.ui.notify(`Todo list:\n${list}`, "info");
		},
	});
}
