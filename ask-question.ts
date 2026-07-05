/**
 * ask_question — Structured user-question tool
 *
 * Lets the model ask the user a question in a structured, interactive format
 * rather than dumping a wall of text and waiting for the user to phrase an
 * answer. Supports three selection modes:
 *
 *   - "single"    : choose exactly one option   (radio buttons)
 *   - "multiple"  : choose one or more options  (checkboxes)
 *   - "text"      : free-form typed answer
 *
 * All modes optionally support a "Type something..." fallback so the user is
 * never locked into the model's suggested choices.
 *
 * Replaces ad-hoc "please reply with X or Y" prompts with a proper UI: the
 * user moves with arrow keys, selects with Space/Enter, and submits. The
 * structured answer is returned to the model as the tool result.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SelectionMode = "single" | "multiple" | "text";

interface ToolOption {
	label: string;
	description?: string;
}

interface DisplayOption extends ToolOption {
	isOther?: boolean;
	isCustom?: boolean; // user-added via "Type something" in multiple mode
}

interface AskDetails {
	question: string;
	selection_mode: SelectionMode;
	options: string[];
	answers: string[];
	cancelled: boolean;
	got_custom: boolean;
}

interface AskResult {
	answers: string[];
	cancelled: boolean;
	got_custom: boolean;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this choice" }),
	description: Type.Optional(
		Type.String({ description: "Optional short description shown below the label" }),
	),
});

const AskQuestionParams = Type.Object({
	question: Type.String({
		description:
			"The question to ask the user. Phrase it as a complete question, e.g. 'Which database should I use for the new service?'",
	}),
	selection_mode: StringEnum(["single", "multiple", "text"] as const, {
		description:
			"'single' = user picks exactly one option (radio). 'multiple' = user picks one or more options (checkboxes). 'text' = free-form typed answer. Defaults to 'single'.",
	}),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Available choices. Required for 'single' and 'multiple', ignored for 'text'. Include 2–8 well-distinguished options; avoid redundant or overlapping choices.",
		}),
	),
	allow_other: Type.Optional(
		Type.Boolean({
			description:
				"If true, add a 'Type something...' choice so the user can write a custom answer not in the list. Defaults to true.",
		}),
	),
	min_select: Type.Optional(
		Type.Integer({
			description:
				"For 'multiple' mode: minimum number of options the user must select before submitting. Defaults to 1.",
		}),
	),
	max_select: Type.Optional(
		Type.Integer({
			description:
				"For 'multiple' mode: maximum number of options the user may select. 0 or omitted means no limit.",
		}),
	),
	placeholder: Type.Optional(
		Type.String({
			description: "For 'text' mode: placeholder text shown in the input editor.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResult(message: string, question: string, mode: SelectionMode): {
	content: { type: "text"; text: string }[];
	details: AskDetails;
} {
	return {
		content: [{ type: "text", text: message }],
		details: {
			question,
			selection_mode: mode,
			options: [],
			answers: [],
			cancelled: true,
			got_custom: false,
		},
	};
}

/**
 * Custom TUI component that renders the question, an options list, and an
 * inline editor for "Type something...". Returns the chosen answers or null
 * if the user cancelled.
 */
function askViaUI(
	params: {
		question: string;
		mode: SelectionMode;
		options: ToolOption[];
		allowOther: boolean;
		minSelect: number;
		maxSelect: number;
		placeholder?: string;
	},
	uiCtx: { ui: any; signal?: AbortSignal },
): Promise<AskResult | null> {
	// Ring the terminal bell so tmux can flag the window as alerted (requires
	// tmux `bell-action` to be on; default `any`).
	process.stdout.write("\x07");

	return uiCtx.ui.custom<AskResult | null>((tui: any, theme: any, _kb: any, done: (v: AskResult | null) => void) => {
		const { question, mode, allowOther, minSelect, maxSelect, placeholder } = params;

		// Build the option list. The list is rebuilt whenever a custom option is
		// added (multiple mode), so keep a mutable base and recompute on changes.
		let baseOptions: DisplayOption[] = [...params.options];
		const customOptions: DisplayOption[] = []; // user-added in multiple mode
		let cursor = 0; // highlighted row across options + submit row (multiple)
		let editMode = false; // typing a custom answer
		let cachedLines: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s: string) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// Selected state:
		//  - single mode: selectedIndices has at most 1 entry
		//  - multiple mode: a Set of indices into the combined option list
		const selected = new Set<number>();

		function currentOptions(): DisplayOption[] {
			const list = [...baseOptions, ...customOptions];
			if (allowOther) list.push({ label: "Type something...", isOther: true });
			return list;
		}

		function optionCount(): number {
			return baseOptions.length + customOptions.length + (allowOther ? 1 : 0);
		}

		// Number of rows the cursor can move over. In multiple mode there is an
		// extra "Submit" row at the bottom.
		function rowCount(): number {
			return mode === "multiple" ? optionCount() + 1 : optionCount();
		}

		const submitRowIndex = () => optionCount(); // only valid in multiple mode

		function selectedCount(): number {
			return selected.size;
		}

		function canSubmit(): boolean {
			if (mode === "multiple") return selectedCount() >= minSelect && (maxSelect <= 0 || selectedCount() <= maxSelect);
			return true;
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function finish(cancelled: boolean, answers: string[], gotCustom: boolean) {
			done({ answers, cancelled, got_custom: gotCustom });
		}

		// --- Editor (custom text input) ---
		editor.onSubmit = (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) {
				// empty: bail out of edit mode
				editMode = false;
				editor.setText("");
				refresh();
				return;
			}

			if (mode === "single") {
				finish(false, [trimmed], true);
				return;
			}

			if (mode === "text") {
				finish(false, [trimmed], true);
				return;
			}

			// multiple: add as a checked custom option, stay in the list so the
			// user can pick more or submit.
			customOptions.push({ label: trimmed, isCustom: true });
			const idx = baseOptions.length + customOptions.length - 1;
			if (maxSelect <= 0 || selectedCount() < maxSelect) selected.add(idx);
			editMode = false;
			editor.setText("");
			refresh();
		};

		// --- Input handling ---
		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// text mode: the editor is the whole UI
			if (mode === "text") {
				if (matchesKey(data, Key.escape)) {
					finish(true, [], false);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const rows = rowCount();

			if (matchesKey(data, Key.up)) {
				cursor = (cursor - 1 + rows) % rows;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = (cursor + 1) % rows;
				refresh();
				return;
			}

			// Submit row (multiple only)
			if (mode === "multiple" && cursor === submitRowIndex()) {
				if (matchesKey(data, Key.enter) && canSubmit()) {
					const opts = currentOptions();
					const answers = Array.from(selected)
						.sort((a, b) => a - b)
						.map((i) => opts[i].label);
					const gotCustom = Array.from(selected).some((i) => opts[i].isCustom);
					finish(false, answers, gotCustom);
					return;
				}
				if (matchesKey(data, Key.escape)) finish(true, [], false);
				return;
			}

			// An option row
			const opts = currentOptions();
			const opt = opts[cursor];

			if (mode === "single") {
				if (matchesKey(data, Key.enter)) {
					if (opt.isOther) {
						editMode = true;
						editor.setText("");
						refresh();
						return;
					}
					finish(false, [opt.label], false);
					return;
					// (space also selects in single mode for convenience)
				}
				if (matchesKey(data, Key.space) && !opt.isOther) {
					finish(false, [opt.label], false);
					return;
				}
			} else {
				// multiple mode
				if (matchesKey(data, Key.space) && !opt.isOther) {
					if (selected.has(cursor)) {
						selected.delete(cursor);
					} else if (maxSelect <= 0 || selectedCount() < maxSelect) {
						selected.add(cursor);
					}
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (opt.isOther) {
						editMode = true;
						editor.setText("");
						refresh();
						return;
					}
					// Enter also toggles in multiple mode
					if (selected.has(cursor)) {
						selected.delete(cursor);
					} else if (maxSelect <= 0 || selectedCount() < maxSelect) {
						selected.add(cursor);
					}
					refresh();
					return;
				}
			}

			if (matchesKey(data, Key.escape)) finish(true, [], false);
		}

		// --- Rendering ---
		function addWrapped(lines: string[], text: string, width: number) {
			lines.push(...wrapTextWithAnsi(text, width));
		}

		function addWithPrefix(lines: string[], prefix: string, text: string, width: number) {
			const pw = visibleWidth(prefix);
			if (pw >= width) {
				addWrapped(lines, prefix + text, width);
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - pw);
			const cont = " ".repeat(pw);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const w = Math.max(1, width);
			const opts = currentOptions();

			lines.push(theme.fg("accent", "─".repeat(w)));
			// Mode tag
			const tag =
				mode === "single"
					? "choose one"
					: mode === "multiple"
						? `choose multiple${minSelect > 1 ? ` (min ${minSelect})` : ""}${maxSelect > 0 ? ` (max ${maxSelect})` : ""}`
						: "free text";
			addWithPrefix(lines, " ", theme.fg("dim", `[ ${tag} ]`), w);
			lines.push("");
			addWithPrefix(lines, " ", theme.fg("text", theme.bold(question)), w);
			lines.push("");

			if (mode === "text") {
				for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
				lines.push("");
				addWithPrefix(lines, " ", theme.fg("dim", "Enter to submit • Esc to cancel"), w);
				lines.push(theme.fg("accent", "─".repeat(w)));
				cachedLines = lines;
				return lines;
			}

			// Option rows
			for (let i = 0; i < opts.length; i++) {
				const opt = opts[i];
				const isCursor = i === cursor;
				const checked = selected.has(i);

				let box: string;
				if (mode === "single") {
					box = checked ? theme.fg("accent", "(●)") : theme.fg("dim", "( )");
				} else {
					box = checked ? theme.fg("accent", "[x]") : theme.fg("dim", "[ ]");
				}
				const curPrefix = isCursor ? theme.fg("accent", "> ") : "  ";
				const num = `${i + 1}.`;
				let label = opt.label;
				if (opt.isOther && editMode) label += " ✎";
				if (opt.isCustom) label = `${label} ${theme.fg("dim", "(custom)")}`;
				const color = isCursor || (opt.isOther && editMode) ? "accent" : "text";
				const row = `${box} ${theme.fg("dim", num)} ${theme.fg(color, label)}`;
				addWithPrefix(lines, curPrefix, row, w);
				if (opt.description) addWithPrefix(lines, "       ", theme.fg("muted", opt.description), w);
			}

			// Submit row (multiple only)
			if (mode === "multiple") {
				const isCursor = cursor === submitRowIndex();
				const curPrefix = isCursor ? theme.fg("accent", "> ") : "  ";
				const ready = canSubmit();
				const submitText = ready
					? theme.fg("success", `✓ Submit (${selectedCount()} selected)`)
					: theme.fg("dim", `✓ Submit (${selectedCount()}/${minSelect} needed)`);
				addWithPrefix(lines, curPrefix, submitText, w);
			}

			lines.push("");
			if (editMode) {
				addWithPrefix(lines, " ", theme.fg("muted", "Your answer:"), w);
				for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
				lines.push("");
				addWithPrefix(lines, " ", theme.fg("dim", "Enter to submit • Esc to go back"), w);
			} else {
				const help =
					mode === "single"
						? "↑↓ navigate • Enter select • Esc cancel"
						: "↑↓ navigate • Space/Enter toggle • Esc cancel";
				addWithPrefix(lines, " ", theme.fg("dim", help), w);
			}
			lines.push(theme.fg("accent", "─".repeat(w)));

			cachedLines = lines;
			return lines;
		}

		// Initialize editor with placeholder for text mode
		if (mode === "text" && placeholder) editor.setText(placeholder);

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a question in a structured interactive UI. Supports choosing one option (single), multiple options (multiple), or free-form text. This is the PREFERRED way to ask the user any question that needs a decision, preference, or clarification — instead of asking them to reply in plain text. Returns the user's answer(s) to the model.",
		promptSnippet: "Ask the user a structured question (single-choice, multi-choice, or free text)",
		// This tool opens an interactive TUI component, so sibling tool calls from
		// the same assistant message must not run concurrently. Sequential mode
		// lets the model emit multiple ask_question calls in one response and have
		// them appear one after another instead of racing/hanging.
		executionMode: "sequential",
		promptGuidelines: [
			"Use ask_question as the PREFERRED way to ask the user any question that needs a decision, preference, or clarification. Do not ask the user to reply in plain text when ask_question is available.",
			"Use ask_question with selection_mode 'single' when the user must pick exactly one option, and 'multiple' when more than one option may apply. Use selection_mode 'text' only for open-ended answers.",
			"When calling ask_question, provide 2–8 well-distinguished, non-overlapping options that cover the realistic choices. Keep option labels short; use the description field for extra context.",
			"Set allow_other=true (the default) so the user can write a custom answer if none of the offered options fit.",
			"Only fall back to asking the user a plain-text question if ask_question is unavailable (e.g. in non-interactive/print mode).",
		],
		parameters: AskQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mode: SelectionMode = (params.selection_mode as SelectionMode) ?? "single";
			const allowOther = params.allow_other !== false;
			const minSelect = params.min_select ?? 1;
			const maxSelect = params.max_select ?? 0;
			const placeholder = params.placeholder;

			// Validate
			if (mode !== "single" && mode !== "multiple" && mode !== "text") {
				return errorResult(`Error: invalid selection_mode '${mode}'`, params.question, "single");
			}
			if (mode === "text") {
				// options ignored; require interactive UI
			} else if (!params.options || params.options.length < 2) {
				return errorResult(
					`Error: selection_mode '${mode}' requires at least 2 options`,
					params.question,
					mode,
				);
			}
			if (mode === "multiple") {
				if (minSelect < 1) return errorResult("Error: min_select must be >= 1", params.question, mode);
				if (maxSelect > 0 && maxSelect < minSelect) {
					return errorResult("Error: max_select must be >= min_select", params.question, mode);
				}
			}

			// Non-interactive fallback
			if (ctx.mode !== "tui") {
				// In RPC mode we could use ctx.ui.select for single, but multi/text
				// have no good fallback. Surface a clear error to the model so it
				// can adapt (e.g. ask in plain text).
				const optList = (params.options ?? []).map((o) => `- ${o.label}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `ask_question requires interactive (TUI) mode; current mode is '${ctx.mode}'. Question was: "${params.question}". Options:\n${optList}\n\nPlease ask the user directly in plain text instead.`,
						},
					],
					details: {
						question: params.question,
						selection_mode: mode,
						options: (params.options ?? []).map((o) => o.label),
						answers: [],
						cancelled: true,
						got_custom: false,
					} as AskDetails,
				};
			}

			const result = await askViaUI(
				{
					question: params.question,
					mode,
					options: (params.options ?? []) as ToolOption[],
					allowOther,
					minSelect,
					maxSelect,
					placeholder,
				},
				{ ui: ctx.ui, signal: ctx.signal },
			);

			const simpleOptions = (params.options ?? []).map((o) => o.label);

			if (!result || result.cancelled) {
				// Throw so pi treats this as an operation cancellation (aborts the
				// current model turn) instead of returning a "cancelled" tool result
				// that the model would then process.
				throw new Error("User cancelled the question.");
			}

			const summary =
				result.answers.length === 0
					? "User submitted with no selection."
					: result.answers
							.map((a, i) => `${i + 1}. ${a}`)
							.join("\n");
			const gotCustom = result.got_custom;

			return {
				content: [
					{
						type: "text",
						text: gotCustom
							? `User answered (includes custom answer):\n${summary}`
							: `User answered:\n${summary}`,
					},
				],
				details: {
					question: params.question,
					selection_mode: mode,
					options: simpleOptions,
					answers: result.answers,
					cancelled: false,
					got_custom: gotCustom,
				} as AskDetails,
			};
		},

		// --- Custom TUI rendering of the tool call / result ---

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("ask_question "));
			text += theme.fg("muted", args.selection_mode ?? "single");
			text += " " + theme.fg("text", args.question);
			const opts = Array.isArray(args.options) ? (args.options as ToolOption[]) : [];
			if (opts.length) {
				const labels = opts.map((o, i) => `${i + 1}. ${o.label}`);
				text += `\n${theme.fg("dim", "  Options: " + labels.join("   "))}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				const isCustom = details.got_custom && !details.options.includes(a);
				const idx = details.options.indexOf(a);
				const display = idx >= 0 ? `${idx + 1}. ${a}` : `${a} ${theme.fg("dim", "(custom)")}`;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", display)}${isCustom ? "" : ""}`;
			});
			return new Text(lines.length ? lines.join("\n") : theme.fg("dim", "(no selection)"), 0, 0);
		},
	});
}