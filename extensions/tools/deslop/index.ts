/**
 * deslop: rewrite AI-shaped prose into something a person can read.
 *
 * The rewrite happens inside this extension, on a model call of its own, so the
 * caller's context only ever sees the result. The loop is measure → rewrite →
 * guard → re-measure → keep the better text; the model never grades itself.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GLOBAL_RULES } from "./global.ts";
import { analyze, summarize, type ScoreReport } from "./score.ts";
import { type DeslopEvent, type DeslopResult, reportLine, runDeslop } from "./rewrite.ts";
import { countWords } from "./text.ts";
import {
	PreviewScreen,
	ProgressScreen,
	renderExpandedDetails,
	renderProgress,
	renderSummary,
	type ProgressSnapshot,
} from "./ui.ts";

const DeslopParams = Type.Object({
	text: Type.Optional(Type.String({ description: "Text to rewrite. Omit when passing a path." })),
	path: Type.Optional(Type.String({ description: "File to rewrite, relative to the working directory." })),
	in_place: Type.Optional(Type.Boolean({ description: "Write the rewrite back to path. Returns only the report." })),
	score_only: Type.Optional(Type.Boolean({ description: "Measure only. No model call, no rewrite." })),
	target: Type.Optional(Type.Integer({ minimum: 50, maximum: 100, description: "Stop when the score reaches this. Default 90." })),
	max_passes: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "Rewrite passes to run. Default 3." })),
	force: Type.Optional(Type.Boolean({ description: "Run one pass even when the text already scores at or above the target." })),
	audit: Type.Optional(Type.Boolean({ description: "Audit the document structure before rewriting (default true for 250+ words with sections)." })),
	profile: Type.Optional(StringEnum(["general", "technical", "social", "agent", "docs"] as const)),
	voice: Type.Optional(Type.String({ description: "Path to a writing sample. Its sentence length and reading grade become the targets." })),
});

interface DeslopDetails {
	snapshot: ProgressSnapshot;
	report?: ScoreReport;
	changed?: boolean;
	path?: string;
}

function extractText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function lastAssistant(entries: any[]): { id: string; text: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractText(entry.message);
		if (text) return { id: entry.id, text };
	}
	return undefined;
}

async function readMaybe(path: string | undefined, cwd: string): Promise<{ path?: string; text: string }> {
	if (!path) return { text: "" };
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	const text = await readFile(absolute, "utf8");
	return { path: absolute, text };
}

function reportBlock(report: ScoreReport): string {
	const lines = [
		`score ${report.total.toFixed(1)} ${report.band} · plain ${report.axes.plain} · human ${report.axes.human} · structured ${report.axes.structured} · dense ${report.axes.dense}`,
		`${report.words} words · ${report.sentences} sentences · grade ${report.metrics.gradeLevel} (FK${report.metrics.meanSentence < 14 ? ", short sentences" : ""}) · mean ${report.metrics.meanSentence} words/sentence`,
	];
	if (report.capReason) lines.push(`capped at ${report.cap} by: ${report.capReason}`);
	const hits = report.hits.slice(0, 6);
	if (hits.length) {
		lines.push("failing rules:");
		for (const hit of hits) {
			const evidence = hit.evidence[0] ? ` — ${hit.evidence[0]}` : "";
			lines.push(`- ${hit.label} (${Math.round(hit.penalty * 100)}%)${evidence}`);
		}
	} else {
		lines.push("no failing rules");
	}
	return lines.join("\n");
}

/** Why the output is (or is not) different, in one line. Shared by the preview and headless runs. */
/** Document-audit line, empty when the audit did not run. */
function auditSummary(result: DeslopResult): string {
	const parts: string[] = [];
	if (result.audit) {
		if (result.audit.findings.length) {
			const labels = result.audit.findings
				.slice(0, 4)
				.map((finding) => GLOBAL_RULES.find((rule) => rule.id === finding.rule)?.label ?? finding.rule);
			parts.push(`document: ${labels.join(", ")}`);
			for (const finding of result.audit.findings.filter((entry) => entry.severity >= 2).slice(0, 3)) {
				if (finding.evidence) parts.push(`  - ${finding.rule}: ${finding.evidence}`);
			}
		} else parts.push("document: no global findings");
	}
	if (result.structural?.applied.length) parts.push(`structure: ${result.structural.applied.join(" · ")}`);
	if (result.structural?.rejected.length) parts.push(`structure held back: ${result.structural.rejected.join(" · ")}`);
	return parts.join("\n");
}

function outcomeStatus(result: DeslopResult, input: string, target: number): string {
	if (result.text !== input) {
		const kept = result.notes.filter((note) => note.startsWith("section")).length;
		const edited = `${result.passes} pass${result.passes === 1 ? "" : "es"} · ${result.fixes} fixes${kept ? ` · ${kept} section${kept === 1 ? "" : "s"} left alone` : ""}`;
		// Text changed but the number did not: a cap is holding it down. Say which.
		if (result.after.capReason && Math.abs(result.after.total - result.before.total) < 0.05) {
			return `edited, score held at ${result.after.total.toFixed(1)} by ${result.after.capReason} — ${edited}`;
		}
		return edited;
	}
	if (result.before.total >= target) {
		return `unchanged — already scores ${result.before.total.toFixed(1)}, at or above target ${target}. Use force to push one more pass, or raise the target.`;
	}
	// Prefer the section-level reason: "dropped a name" explains more than "no gain".
	const section = result.notes.find((note) => note.startsWith("section"));
	const pass = result.notes.find((note) => !note.includes("no pass improved") && !note.startsWith("section"));
	return `unchanged — ${section ?? pass ?? "no pass improved the score"}`;
}

function snapshotFromEvent(event: DeslopEvent, label: string, profile: string): ProgressSnapshot {
	switch (event.kind) {
		case "measure":
			return { phase: "measure", label, profile, score: event.report.total, report: event.report };
		case "audit_start":
			return { phase: "audit", label, profile, sections: event.sections };
		case "audit_done":
			return {
				phase: "audit",
				label,
				profile,
				score: undefined,
				audit: event.findings ? `${event.findings} finding${event.findings === 1 ? "" : "s"} (worst ${event.worst}/3)` : "no global findings",
			};
		case "restructure":
			return {
				phase: "audit",
				label,
				profile,
				score: event.after,
				previous: event.before,
				audit: event.applied.length ? event.applied.join(" · ") : undefined,
			};
		case "pass_start":
			return {
				phase: "pass",
				label,
				profile,
				pass: event.pass,
				passes: event.passes,
				sections: event.sections,
				sectionsDone: 0,
				rules: event.rules,
			};
		case "section_done":
			return {
				phase: "pass",
				label,
				profile,
				pass: event.pass,
				sections: event.total,
				sectionsDone: event.done,
				message: event.note && !event.accepted ? `section kept: ${event.note}` : undefined,
			};
		case "pass_end":
			return {
				phase: "pass",
				label,
				profile,
				score: event.after,
				previous: event.before,
				pass: event.pass,
				sectionsDone: 0,
				message: event.accepted ? undefined : `pass rejected: ${event.note ?? "no gain"}`,
			};
		default:
			return { phase: "done", label, profile, score: event.report.total, report: event.report };
	}
}

async function voiceProfile(cwd: string, voicePath: string | undefined) {
	if (!voicePath) return undefined;
	const absolute = isAbsolute(voicePath) ? voicePath : resolve(cwd, voicePath);
	const sample = await readFile(absolute, "utf8");
	const report = analyze(sample, "general");
	return {
		name: "voice",
		maxSentence: Math.max(12, Math.round(report.metrics.meanSentence + 3)),
		maxGrade: Math.max(6, Math.ceil(report.metrics.gradeLevel) + 1),
		maxParaSentences: Math.max(2, Math.round(report.metrics.paraMean) + 1),
		minBulletShare: 0,
	};
}

function parseCommandArgs(args: string): {
	path?: string;
	profile?: string;
	target?: number;
	editorOnly: boolean;
	inPlace: boolean;
	scoreOnly: boolean;
	force: boolean;
	audit: boolean;
	savePath?: string;
} {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	// /deslop is an explicit request, so it always runs at least one pass. Use
	// --score for a free check first; the tool keeps the cheap target-gated default.
	const options: ReturnType<typeof parseCommandArgs> = { editorOnly: false, inPlace: false, scoreOnly: false, force: true, audit: true };
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--file" || part === "-f") options.path = parts[++index];
		else if (part === "--profile" || part === "-p") options.profile = parts[++index];
		else if (part === "--target" || part === "-t") options.target = Number(parts[++index]);
		else if (part === "--save" || part === "-s") options.savePath = parts[++index];
		else if (part === "--editor" || part === "-e") options.editorOnly = true;
		else if (part === "--in-place" || part === "-i") options.inPlace = true;
		else if (part === "--score") options.scoreOnly = true;
		else if (part === "--force" || part === "-F") options.force = true;
		else if (part === "--no-audit") options.audit = false;
		else if (!part.startsWith("-") && !options.path) options.path = part;
	}
	return options;
}

export default function deslopExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "deslop",
		label: "deslop",
		description:
			"Rewrite text or a Markdown file into clearer prose. Runs its own isolated loop: audits the document structure first (order, redundancy, proportion, promises), then measures the text against a 43-rule readability pack, rewrites only the sections that fail, keeps every fact, number, name, link, and code span, re-measures, and keeps the better version. Returns the rewritten text, or writes it back with in_place. Use score_only to measure without spending a model call.",
		promptSnippet: "Rewrite dense or AI-shaped prose into readable prose, or score it",
		promptGuidelines: [
			"Use deslop instead of rewriting prose yourself when the user asks for clearer, less AI-sounding text. It keeps the rewrite out of your context and returns the result.",
			"Call deslop with score_only first when you want to know whether the text needs work before spending a model call.",
			"Pass in_place: true to overwrite the file; otherwise the rewritten text comes back in the result.",
			"Set audit: false to skip the document-level audit and spend only the rewrite calls.",
		],
		parameters: DeslopParams,

		async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const cwd = ctx.cwd;
			const started = Date.now();
			const label = params.path ?? "text";
			const profileName = params.profile ?? (params.path ? "docs" : "general");

			let input = params.text ?? "";
			let absolutePath: string | undefined;
			if (params.path) {
				const file = await readMaybe(params.path, cwd);
				input = file.text;
				absolutePath = file.path;
			}
			if (!input.trim()) {
				return {
					content: [{ type: "text" as const, text: "deslop needs text or a readable path." }],
					details: { snapshot: { phase: "error", label, profile: profileName, message: "no input" } } as DeslopDetails,
					isError: true,
				};
			}
			if (params.in_place && !absolutePath) {
				return {
					content: [{ type: "text" as const, text: "in_place needs a path." }],
					details: { snapshot: { phase: "error", label, profile: profileName, message: "in_place without path" } } as DeslopDetails,
					isError: true,
				};
			}

			// ---- score only -------------------------------------------------
			if (params.score_only) {
				const report = analyze(input, profileName);
				const snapshot: ProgressSnapshot = { phase: "done", label, profile: profileName, score: report.total, report, elapsedMs: Date.now() - started };
				if (ctx.hasUI) ctx.ui.setStatus("deslop", `deslop ${report.total.toFixed(1)}`);
				return {
					content: [{ type: "text" as const, text: reportBlock(report) }],
					details: { snapshot, report, changed: false, path: absolutePath } as DeslopDetails,
				};
			}

			// ---- rewrite ----------------------------------------------------
			const voice = await voiceProfile(cwd, params.voice).catch(() => undefined);
			let snapshot: ProgressSnapshot = { phase: "measure", label, profile: voice?.name ?? profileName };
			const push = () => {
				if (!onUpdate) return;
				onUpdate({
					content: [{ type: "text" as const, text: renderPlain(snapshot) }],
					details: { snapshot } as DeslopDetails,
				});
			};

			if (ctx.hasUI) {
				ctx.ui.setStatus("deslop", `deslop ${label}`);
				ctx.ui.setWorkingMessage(`deslop: rewriting ${label}`);
			}

			try {
				const result = await runDeslop(ctx, input, {
					cwd,
					fileTarget: Boolean(absolutePath),
					agentDir: getAgentDir(),
					profile: (voice as any) ?? params.profile,
					target: params.target,
					maxPasses: params.max_passes,
					force: params.force,
					audit: params.audit,
					signal,
					onEvent: (event) => {
						snapshot = { ...snapshotFromEvent(event, label, voice?.name ?? profileName), elapsedMs: Date.now() - started };
						push();
					},
				});

				let wrote: string | undefined;
				if (params.in_place && absolutePath) {
					await withFileMutationQueue(absolutePath, async () => {
						await writeFile(absolutePath, result.text, "utf8");
					});
					wrote = absolutePath;
				}

				const finalSnapshot: ProgressSnapshot = {
					phase: "done",
					label,
					profile: voice?.name ?? profileName,
					score: result.after.total,
					previous: result.before.total,
					report: result.after,
					elapsedMs: Date.now() - started,
				};
				snapshot = finalSnapshot;
				if (ctx.hasUI) {
					ctx.ui.setStatus("deslop", `deslop ${result.after.total.toFixed(1)}`);
					ctx.ui.setWorkingMessage();
				}

				const header = [
					`deslop: ${reportLine(result)}`,
					auditSummary(result),
					`${result.before.metrics.gradeLevel} → ${result.after.metrics.gradeLevel} grade · ${result.before.metrics.meanSentence} → ${result.after.metrics.meanSentence} words/sentence · ${countWords(result.text)} words`,
					wrote ? `wrote ${relative(cwd, wrote) || wrote}` : "",
				].filter(Boolean);

				const body = wrote ? header.join("\n") : `${header.join("\n")}\n\n${result.text}`;

				return {
					content: [{ type: "text" as const, text: body }],
					details: {
						snapshot: finalSnapshot,
						report: result.after,
						changed: result.text !== input,
						path: wrote ?? absolutePath,
					} as DeslopDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (ctx.hasUI) {
					ctx.ui.setStatus("deslop", undefined);
					ctx.ui.setWorkingMessage();
				}
				return {
					content: [{ type: "text" as const, text: `deslop failed: ${message}` }],
					details: {
						snapshot: { phase: "error", label, profile: profileName, message, elapsedMs: Date.now() - started },
					} as DeslopDetails,
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const target = args.path ? args.path : `"${(args.text ?? "").slice(0, 40)}${(args.text ?? "").length > 40 ? "…" : ""}"`;
			const flags: string[] = [];
			if (args.score_only) flags.push("score");
			if (args.in_place) flags.push("in place");
			if (args.profile) flags.push(args.profile);
			if (args.target) flags.push(`target ${args.target}`);
			const suffix = flags.length ? theme.fg("dim", ` ${flags.join(" · ")}`) : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("deslop "))}${theme.fg("muted", target)}${suffix}`, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = (result as { details?: DeslopDetails }).details;
			const snapshot = details?.snapshot;
			if (!snapshot) return new Text(theme.fg("muted", "deslop"), 0, 0);
			if (isPartial || snapshot.phase === "measure" || snapshot.phase === "pass") {
				return new Text(renderProgress(snapshot, theme).join("\n"), 0, 0);
			}
			const lines = [renderSummary(snapshot, theme)];
			if (expanded && details?.report) lines.push(...renderExpandedDetails(details.report, theme));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// ---- /deslop ----------------------------------------------------------
	pi.registerCommand("deslop", {
		description: "Rewrite the last answer (or a file) into readable prose",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const options = parseCommandArgs(args ?? "");
			const cwd = ctx.cwd;

			let input = "";
			let label = "last answer";
			let absolutePath: string | undefined;
			if (options.path) {
				absolutePath = isAbsolute(options.path) ? options.path : resolve(cwd, options.path);
				input = await readFile(absolutePath, "utf8");
				label = options.path;
			} else {
				const entries = ctx.sessionManager.buildContextEntries();
				const last = lastAssistant(entries as any[]);
				if (!last) {
					ctx.ui.notify("No assistant message to rewrite", "warning");
					return;
				}
				input = last.text;
			}

			if (options.scoreOnly) {
				const report = analyze(input, options.profile ?? (absolutePath ? "docs" : "general"));
				ctx.ui.notify(summarize(report), "info");
				return;
			}

			const profileName = options.profile ?? (absolutePath ? "docs" : "general");
			const started = Date.now();
			const words = countWords(input);
			ctx.ui.notify(
				words < 25
					? `deslop: ${label} is ${words} words — short text leaves little to rewrite`
					: `deslop: rewriting ${label} (${words} words)`,
				words < 25 ? "warning" : "info",
			);

			const execute = async (onProgress?: (snapshot: ProgressSnapshot) => void, signal?: AbortSignal) => {
				return runDeslop(ctx, input, {
					cwd,
					fileTarget: Boolean(absolutePath),
					agentDir: getAgentDir(),
					profile: profileName,
					target: options.target,
					force: options.force,
					audit: options.audit,
					...(signal ? { signal } : {}),
					onEvent: (event) => {
						const snapshot = snapshotFromEvent(event, label, profileName);
						onProgress?.({ ...snapshot, elapsedMs: Date.now() - started });
					},
				});
			};

			// With a file path, -e and -i mean "write it back": an editor buffer is the
			// wrong destination when the user named a file. This must work headless too.
			const writeBack = (options.editorOnly || options.inPlace) && Boolean(absolutePath);

			const persist = async (result: DeslopResult): Promise<boolean> => {
				if (!writeBack || !absolutePath) return false;
				if (result.text === input) return false;
				await withFileMutationQueue(absolutePath, async () => {
					await writeFile(absolutePath, result.text, "utf8");
				});
				return true;
			};

			// No TUI (print or json mode): run without the progress screen.
			if (!ctx.hasUI) {
				try {
					const result = await execute();
					if (await persist(result)) {
						console.error(reportLine(result));
						console.error(`wrote ${absolutePath}`);
						return;
					}
					console.log(result.text);
					console.error(reportLine(result));
					console.error(outcomeStatus(result, input, options.target ?? 90));
				} catch (error) {
					console.error(`deslop failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return;
			}

			const controller = new AbortController();
			const runResult = await ctx.ui.custom<{ result?: DeslopResult; error?: string } | null>((tui, theme, _kb, done) => {
				const initial: ProgressSnapshot = { phase: "measure", label, profile: profileName };
				let finished = false;
				const finish = (value: { result?: DeslopResult; error?: string } | null) => {
					if (finished) return;
					finished = true;
					component.stop();
					done(value);
				};
				const component = new ProgressScreen(tui, theme, initial, () => {
					controller.abort();
					finish(null);
				});
				void (async () => {
					try {
						const result = await execute((snapshot) => component.update(snapshot), controller.signal);
						finish({ result });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						component.update({ phase: "error", label, profile: profileName, message });
						finish({ error: controller.signal.aborted ? "aborted" : message });
					}
				})();
				return component;
			});

			if (!runResult) return;
			if (runResult.error) {
				ctx.ui.notify(`deslop failed: ${runResult.error}`, "error");
				return;
			}
			const result = runResult.result!;

			if (writeBack && absolutePath) {
				if (!(await persist(result))) {
					ctx.ui.notify(`deslop: unchanged (${after.total.toFixed(1)} ${after.band}), file not written`, "warning");
					return;
				}
				ctx.ui.notify(`deslop: wrote ${relative(cwd, absolutePath) || absolutePath} · ${before.total.toFixed(1)} → ${after.total.toFixed(1)}`, "success");
				return;
			}

			if (options.editorOnly || options.inPlace) {
				ctx.ui.setEditorText(result.text);
				ctx.ui.notify(`deslop: ${reportLine(result)} — loaded into the editor`, "success");
				return;
			}

			const target = options.target ?? 90;
			const changed = result.text !== input;
			const before = result.before;
			const after = result.after;

			const buildHeader = (theme: any): string[] => {
				const tone = after.total >= 80 ? "success" : after.total >= 70 ? "warning" : "error";
				const delta = after.total - before.total;
				const sign = delta > 0 ? "+" : "";
				const scoreLine =
					`${theme.bold("deslop")}  ` +
					`${theme.fg(tone, before.total.toFixed(1))} ${theme.fg("muted", before.band)}` +
					`  →  ${theme.fg(tone, after.total.toFixed(1))} ${theme.fg("muted", after.band)}` +
					(delta === 0 ? "" : `   ${theme.fg(delta > 0 ? "success" : "error", `${sign}${delta.toFixed(1)}`)}`);

				const status = outcomeStatus(result, input, target);

				const metrics =
					`grade ${before.metrics.gradeLevel} → ${after.metrics.gradeLevel} (FK) · ` +
					`${before.metrics.meanSentence} → ${after.metrics.meanSentence} words/sentence · ` +
					`${countWords(result.text)} words · target ${target}`;

				return [
					scoreLine,
					changed ? theme.fg("muted", status) : theme.fg("warning", status),
					theme.fg("dim", metrics),
				];
			};

			const action = await ctx.ui.custom<{ action: "close" | "edit" | "save" }>((tui, theme, _kb, done) =>
				new PreviewScreen(tui, theme, buildHeader(theme), result.text, done),
			);

			ctx.ui.notify(
				changed
					? `deslop: ${before.total.toFixed(1)} → ${after.total.toFixed(1)} · ${result.passes} pass${result.passes === 1 ? "" : "es"}`
					: `deslop: unchanged (${before.total.toFixed(1)} ${before.band})`,
				changed ? "success" : "warning",
			);

			if (action?.action === "edit") {
				ctx.ui.setEditorText(result.text);
				ctx.ui.notify("deslop: loaded into the editor", "success");
			} else if (action?.action === "save") {
				const target = absolutePath ?? resolve(cwd, "deslop.md");
				await withFileMutationQueue(target, async () => {
					await writeFile(target, result.text, "utf8");
				});
				ctx.ui.notify(`deslop: wrote ${relative(cwd, target) || target}`, "success");
			}
		},
	});
}

/** Progress as plain text, used for the model-facing partial result and headless runs. */
function renderPlain(snapshot: ProgressSnapshot): string {
	const score = snapshot.score?.toFixed(1) ?? "measuring";
	if (snapshot.phase === "done") return `deslop: ${score} ${snapshot.band ?? ""}`.trim();
	const parts = [score];
	if (snapshot.pass) parts.push(`pass ${snapshot.pass}/${snapshot.passes ?? "?"}`);
	if (snapshot.sections) parts.push(`${snapshot.sectionsDone ?? 0}/${snapshot.sections} sections`);
	if (snapshot.message) parts.push(snapshot.message);
	return `deslop: ${parts.join(" · ")}`;
}
