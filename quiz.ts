/**
 * quiz — ask the user a question with a known correct answer, and grade it.
 *
 * This is for TESTING: the model has a correct answer in mind (the `correct`
 * field) and the user answers inline in the terminal. The UI is exactly the
 * same interactive component as `ask_question` (arrow keys, Space/Enter,
 * "Type something...", Esc to cancel), except the result is graded green ✓ /
 * red ✗ and the answer key is revealed after grading.
 *
 * Deliberately separate from `ask_question`: quiz tests recall with a known
 * answer; ask_question gathers decisions/preferences with no fixed answer.
 *
 * The answer key (`correct`) is hidden from the rendered tool call so the user
 * does not see it before answering. Esc cancels the question and aborts the
 * turn (the model never answers for the user).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { promptWait } from "./notify-on-idle";
import { askViaUI, type ToolOption } from "./ask-question";

function normalize(s: string, loose: boolean): string {
	let out = s.trim().toLowerCase();
	if (loose) out = out.replace(/[^a-z0-9]/g, "");
	return out;
}

interface QuizDetails {
	question: string;
	mode: "choice" | "type";
	options: string[];
	given: string | null;
	cancelled: boolean;
	correct: boolean;
	correctAnswer: string;
	explanation?: string;
}

function errorResult(message: string, params: Record<string, unknown>): {
	content: { type: "text"; text: string }[];
	details: QuizDetails;
} {
	return {
		content: [{ type: "text", text: message }],
		details: {
			question: String(params.question ?? ""),
			mode: (params.mode as "choice" | "type") ?? "choice",
			options: Array.isArray(params.options)
				? (params.options as { label?: string }[]).map((o) => o.label ?? "")
				: [],
			given: null,
			cancelled: true,
			correct: false,
			correctAnswer: String(params.correct ?? ""),
			explanation: params.explanation ? String(params.explanation) : undefined,
		},
	};
}

export default function quiz(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "Quiz",
		description:
			"Ask the user a question for which YOU already know the answer, and grade their reply. Use when testing recall or understanding. The UI works exactly like ask_question (arrow keys, Space/Enter, Type something..., Esc to cancel); it grades the reply green (right) or red (wrong), reports the result back to you, and reveals the answer. Choice mode offers options; type mode takes free text. Do NOT reveal the correct answer to the user before they answer.",
		promptSnippet: "Ask a graded quiz question (known answer) to test the user",
		promptGuidelines: [
			"Use quiz to TEST the user with a known answer; use ask_question for decisions/preferences (no fixed answer).",
			"Keep the correct answer in the correct field and do not reveal it before the user answers.",
			"Reveal the answer and explanation after grading so the user can learn from a miss.",
			"If the user cancels (Esc) a quiz, do not fill in an answer for them — move on or rephrase.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The quiz question" }),
			mode: Type.Optional(
				StringEnum(["choice", "type"] as const, {
					description: "'choice' = the user picks from options; 'type' = the user types a free-text answer. Defaults to 'choice'.",
				}),
			),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Choice label" }),
						description: Type.Optional(Type.String({ description: "Optional short description shown below the label" })),
					}),
					{
						description:
							"Available choices; required for mode=choice. Include 2–8 well-distinguished options; the correct one should be one of these.",
					},
				),
			),
			correct: Type.String({
				description: "The correct choice label (for choice) or the expected answer text (for type)",
			}),
			match: Type.Optional(
				StringEnum(["exact", "loose"] as const, {
					description:
						"How to grade a typed/custom answer. exact = case/space sensitive; loose = ignores case and punctuation (default loose).",
				}),
			),
			explanation: Type.Optional(
				Type.String({ description: "Short explanation to show after the user answers" }),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mode: "choice" | "type" = (params.mode as "choice" | "type") ?? "choice";
			const loose = (params.match as string | undefined) !== "exact";
			const options = (params.options ?? []) as ToolOption[];

			if (mode === "choice" && options.length < 2) {
				return errorResult("Error: mode=choice requires at least 2 options", params as Record<string, unknown>);
			}

			if (ctx.mode !== "tui") {
				const optList = options.map((o) => `- ${o.label}`).join("\n");
				return {
					content: [
						{
							type: "text",
							text: `quiz requires interactive (TUI) mode; current mode is '${ctx.mode}'. Question: "${params.question}". Options:\n${optList}\n\nAsk the user directly in plain text instead.`,
						},
					],
					details: {
						question: params.question,
						mode,
						options: options.map((o) => o.label),
						given: null,
						cancelled: true,
						correct: false,
						correctAnswer: params.correct,
						explanation: params.explanation,
					} as QuizDetails,
				};
			}

			promptWait(pi, { title: "Quiz", body: params.question });

			// Same interactive component as ask_question (choice -> single,
			// type -> free text), with the "Type something..." fallback enabled.
			const result = await askViaUI(
				{
					question: params.question,
					mode: mode === "choice" ? "single" : "text",
					options,
					allowOther: true,
					minSelect: 1,
					maxSelect: 0,
					placeholder: undefined,
				},
				{ ui: ctx.ui, signal: ctx.signal },
			);

			if (!result || result.cancelled) {
				// Esc / cancel: abort the turn cleanly; never answer for the user.
				throw new Error("User cancelled the quiz.");
			}

			const given = result.answers[0] ?? null;
			const correct = given != null && normalize(given, loose) === normalize(params.correct, loose);

			const details: QuizDetails = {
				question: params.question,
				mode,
				options: options.map((o) => o.label),
				given,
				cancelled: false,
				correct,
				correctAnswer: params.correct,
				explanation: params.explanation,
			};

			const verdict = correct ? "correct" : "incorrect";
			return {
				content: [
					{
						type: "text",
						text: `Quiz "${params.question}" -> user answered ${given == null ? "(none)" : `"${given}"`}; ${verdict}. Correct answer: ${params.correct}.`,
					},
				],
				details,
			};
		},

		renderCall(args, theme, _context) {
			// Deliberately does NOT show `correct` (the answer key).
			const opts = Array.isArray(args.options) ? (args.options as ToolOption[]) : [];
			let text =
				theme.fg("toolTitle", theme.bold("quiz ")) +
				theme.fg("accent", args.mode === "type" ? "type-in" : "multiple-choice") +
				"\n" +
				theme.fg("text", args.question);
			if (opts.length) {
				text += "\n" + theme.fg("dim", opts.map((o, i) => `${i + 1}. ${o.label}`).join("   "));
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuizDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "✗ Quiz cancelled"), 0, 0);
			}
			const mark = details.correct ? "✓ Correct" : "✗ Incorrect";
			const color = details.correct ? "success" : "error";
			let text = `${theme.fg(color, mark)} — ${theme.fg("accent", details.given ?? "")}`;
			text += "\n" + theme.fg("dim", `Key: ${details.correctAnswer}`);
			if (details.explanation) {
				text += "\n" + theme.fg("muted", details.explanation);
			}
			return new Text(text, 0, 0);
		},
	});
}
