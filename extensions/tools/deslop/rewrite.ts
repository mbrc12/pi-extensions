/**
 * The rewrite engine: measure, rewrite the sections that lose the reader, guard
 * the result, re-measure, keep the better text. The model never decides whether
 * it improved anything; the deterministic score does.
 */

import { appendFileSync } from "node:fs";
import type { ModelCompletionContext } from "../../shared/model-config.ts";
import { completeWithModelFallback } from "../../shared/model-config.ts";
import { guardRewrite } from "./guard.ts";
import { type HousePolicy, loadHousePolicy, policyBlock } from "./policy.ts";
import { splitSections, type Section } from "./sections.ts";
import { countWords } from "./text.ts";
import { replaceHint, resolveProfile, type Profile } from "./rules.ts";
import { analyze, summarize, topFixes, type RuleHit, type ScoreReport } from "./score.ts";

/** DESLOP_DEBUG=1 appends prompts and guard verdicts to /tmp/deslop-debug.log. */
function debug(label: string, body: string): void {
	if (!process.env.DESLOP_DEBUG) return;
	try {
		appendFileSync("/tmp/deslop-debug.log", `\n===== ${label} =====\n${body}\n`);
	} catch {
		// logging must never break a run
	}
}

export interface DeslopOptions {
	profile?: string | Profile;
	target?: number;
	maxPasses?: number;
	/** Run one pass even when the text already scores at or above the target. */
	force?: boolean;
	concurrency?: number;
	minGain?: number;
	cwd: string;
	fileTarget?: boolean;
	agentDir?: string;
	policy?: HousePolicy;
	modelOverride?: string;
	signal?: AbortSignal;
	onEvent?: (event: DeslopEvent) => void;
}

export type DeslopEvent =
	| { kind: "measure"; report: ScoreReport; label: string }
	| { kind: "pass_start"; pass: number; passes: number; sections: number; rules: number }
	| { kind: "section_done"; pass: number; done: number; total: number; accepted: boolean; note?: string }
	| { kind: "pass_end"; pass: number; before: number; after: number; accepted: boolean; note?: string }
	| { kind: "done"; report: ScoreReport; passes: number; fixes: number; notes: string[] };

export interface DeslopResult {
	text: string;
	before: ScoreReport;
	after: ScoreReport;
	passes: number;
	fixes: number;
	notes: string[];
	policy: HousePolicy;
	model?: string;
}

/** Name the number behind a metric finding so the model knows what to change. */
function measuredLine(ruleId: string, profile: Profile): string | undefined {
	switch (ruleId) {
		case "paragraph_length":
			return `currently over ${profile.maxParaSentences} sentences in one paragraph, limit ${profile.maxParaSentences}`;
		case "mean_sentence":
			return `average above ${profile.maxSentence} words, limit ${profile.maxSentence}`;
		case "grade_level":
			return `reading grade above ${profile.maxGrade}, limit ${profile.maxGrade}`;
		case "medium_variety":
			return "fewer than two formats in use: headings, lists, tables, code, bold, italics";
		case "list_opportunity":
			return "a paragraph of parallel items with no bullet list";
		case "table_opportunity":
			return "numbers compared in prose with no table";
		default:
			return undefined;
	}
}

function buildSystemPrompt(policy: HousePolicy, profileName: string | Profile, hits: RuleHit[]): string {
	const profile = resolveProfile(profileName);
	const findings = hits.length
		? hits
				.map((hit) => {
					const replacements = (hit.terms ?? [])
						.map((term) => {
							const replacement = replaceHint(term);
							return replacement ? `${term} → ${replacement}` : term;
						})
						.join(", ");
					const measured = measuredLine(hit.id, profile);
					if (replacements) return `- ${hit.label} (found: ${replacements}). ${hit.fix}`;
					return measured ? `- ${hit.label} (${measured}). ${hit.fix}` : `- ${hit.label}: ${hit.fix}`;
				})
				.join("\n")
		: "- No structural findings. Tighten sentences and remove filler.";
	return [
		"You are a line editor. You rewrite prose so a busy expert can read it once and act on it.",
		"",
		"Hard rules:",
		"- Keep every fact, number, name, link, and claim. Never add a claim the text does not make.",
		"- Keep the length within 10% of the original. This is editing, not summarising: do not merge, cut, or condense content.",
		"- Keep every [[n]] token exactly as it appears, unchanged and in place. Each stands for code, a link, math, a table, or a path.",
		"- Keep the heading line unchanged when the text starts with one.",
		"- Return only the rewritten text. No preamble, no commentary, no code fences.",
		"- Never swap words one at a time. Rewrite the sentence around the plain word; if the substitution reads oddly, restructure the sentence instead.",
		"",
		"Medium. Use the format the content needs:",
		"- Three or more parallel items in a paragraph become a bullet list. Keep every item and its numbers.",
		"- Three or more values compared across the same dimensions become a table with a header row.",
		"- Bold the one claim, number, or warning that matters in a section. Bold nothing else.",
		"- Italicise a term the first time you define it.",
		"- Add headings once the text passes about 300 words.",
		"",
		"House rules:",
		policyBlock(policy),
		"",
		`Target: sentences under ${profile.maxSentence} words, reading grade under ${profile.maxGrade}.`,
		"",
		"Every word listed under 'found' must be gone from the rewrite, with the meaning preserved.",
		"",
		"Findings to fix, strongest first:",
		findings,
	].join("\n");
}

/**
 * Models wrap output in a fence or prefix it with an announcement even when told
 * not to. Remove one wrapping fence and a leading announcement, and nothing else.
 */
function cleanOutput(text: string, hadFence: boolean): string {
	let out = text.trim();
	const fenced = out.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
	if (fenced && fenced[1].trim()) out = fenced[1];
	else if (!hadFence) {
		out = out.replace(/^(?:here(?:'s| is) the (?:rewritten|edited|revised)[^\n]*\n+)/i, "");
	}
	return out.trimEnd();
}

function extractText(response: any): string {
	if (!response || !Array.isArray(response.content)) return "";
	return response.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

async function rewriteSection(
	ctx: ModelCompletionContext,
	section: Section,
	systemPrompt: string,
	options: Required<Pick<DeslopOptions, "cwd">> & DeslopOptions,
): Promise<{ text: string; note?: string }> {
	const budget = `This section has ${section.words} words. Return between ${Math.round(section.words * 0.9)} and ${Math.round(section.words * 1.1)} words.`;

	let feedback = "";
	let lastError: string | undefined;

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const instructions = [budget, feedback].filter(Boolean).join("\n\n");
			const { response } = await completeWithModelFallback(
				ctx,
				"deslopRewrite",
				{
					systemPrompt,
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: [instructions, "", "<text>", section.masked, "</text>"].join("\n"),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 4096, signal: options.signal, cacheRetention: "none" },
				{},
			);

			if (attempt === 0) debug("system prompt", systemPrompt);
			const text = extractText(response);
			if (!text) {
				lastError = "empty response";
				continue;
			}

			const cleaned = cleanOutput(text, section.raw.includes("```"));
			const guard = guardRewrite(section.raw, cleaned, section.spans);
			debug("guard", `ok=${guard.ok} reason=${guard.reason ?? "-"} words=${countWords(cleaned)}/${section.words}`);
			if (guard.ok && guard.restored.trim() !== section.raw.trim()) {
				return { text: guard.restored, note: guard.warnings[0] };
			}

			lastError = guard.ok ? "no change" : guard.reason;
			// Tell the model what it broke. A targeted retry lands far more often
			// than a silent rejection, especially for the length constraint.
			feedback =
				guard.reason?.includes("length") && cleaned
					? `Your previous attempt was ${Math.round((countWords(cleaned) / Math.max(1, section.words)) * 100)}% of the original length. Keep every sentence's content. Do not condense, merge, or drop material.`
					: guard.reason
						? `Your previous attempt failed: ${guard.reason}. Keep every fact, number, name, and link exactly as written.`
						: "";
			if (!feedback) break;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	return { text: section.raw, note: lastError };
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}

export async function runDeslop(
	ctx: ModelCompletionContext,
	input: string,
	options: DeslopOptions,
): Promise<DeslopResult> {
	const emit = options.onEvent ?? (() => {});
	const policy = options.policy ?? loadHousePolicy(options.cwd, {
		agentDir: options.agentDir,
		fileTarget: options.fileTarget,
	});
	const profile = options.profile ?? (options.fileTarget ? "docs" : "general");
	const target = options.target ?? 90;
	const maxPasses = Math.max(1, options.maxPasses ?? 3);
	const minGain = options.minGain ?? 2;
	const concurrency = Math.max(1, options.concurrency ?? 3);

	let current = input;
	// The length band is anchored to the original, never to the previous pass.
	// Otherwise three passes at 80% each quietly delete half the document.
	const originalWords = Math.max(1, countWords(input));
	let best = analyze(current, profile);
	const notes: string[] = [];
	emit({ kind: "measure", report: best, label: "before" });

	let passes = 0;
	let fixes = 0;
	let acceptedPasses = 0;
	const sectionNotes: string[] = [];

	const shouldRun = () => best.total < target || (options.force === true && passes === 0);
	while (passes < maxPasses && shouldRun()) {
		if (options.signal?.aborted) break;
		passes += 1;

		const sections = splitSections(current);
		if (!sections.length) break;

		const sectionHits = sections.map((section) => topFixes(analyze(section.raw, profile), 8));
		const flagged = sectionHits.reduce((sum, hits) => sum + hits.length, 0);
		const ruleIds = new Set(sectionHits.flat().map((hit) => hit.id));
		emit({ kind: "pass_start", pass: passes, passes: maxPasses, sections: sections.length, rules: ruleIds.size });

		let done = 0;
		const rewritten = await mapLimit(sections, concurrency, async (section, index) => {
			const systemPrompt = buildSystemPrompt(policy, profile, sectionHits[index]);
			const result = await rewriteSection(ctx, section, systemPrompt, options);
			done += 1;
			if (result.text === section.raw && result.note) {
				sectionNotes.push(`section ${index + 1}: ${result.note}`);
			}
			emit({
				kind: "section_done",
				pass: passes,
				done,
				total: sections.length,
				accepted: result.text !== section.raw,
				note: result.note,
			});
			return result.text;
		});

		const candidate = rewritten.join("\n");
		const before = best;
		const after = analyze(candidate, profile);

		const lengthRatio = countWords(candidate) / originalWords;
		const lengthOk = lengthRatio >= 0.7 && lengthRatio <= 1.15;
		const gain = after.total - before.total;
		// Caps can hold two versions at the same total. When that happens, prefer the
		// one with the lower raw penalty instead of reporting a plateau as no gain.
		const tiebreak = Math.abs(gain) < 0.05 && after.rawX < before.rawX - 0.01;
		const accepted = (gain > 0 || tiebreak) && lengthOk;

		emit({
			kind: "pass_end",
			pass: passes,
			before: before.total,
			after: after.total,
			accepted,
			note: !lengthOk ? `length ${Math.round(lengthRatio * 100)}%` : gain <= 0 ? "no gain" : undefined,
		});

		if (!accepted) {
			// A rejected pass is never applied, even when its score rose: the score
			// can rise because content disappeared.
			notes.push(`pass ${passes} rejected (${gain <= 0 ? "no gain" : "length changed"})`);
			break;
		}

		current = candidate;
		best = after;
		acceptedPasses += 1;
		fixes += flagged;
		if (gain < minGain) break;
	}

	emit({
		kind: "done",
		report: best,
		passes,
		fixes,
		notes,
	});

	const diagnostics = [...new Set(sectionNotes)].slice(0, 4);

	return {
		text: current,
		before: analyze(input, profile),
		after: best,
		passes,
		fixes,
		notes: acceptedPasses ? [...notes, ...diagnostics] : [...notes, "kept the original: no pass improved the score", ...diagnostics],
		policy,
	};
}

export function reportLine(result: DeslopResult): string {
	const delta = result.after.total - result.before.total;
	const sign = delta >= 0 ? "+" : "";
	const notes = result.notes.length ? ` · ${result.notes.join("; ")}` : "";
	return `score ${result.before.total.toFixed(1)} → ${result.after.total.toFixed(1)} (${sign}${delta.toFixed(1)}) · ${result.passes} pass${result.passes === 1 ? "" : "es"} · ${result.fixes} fixes${notes}`;
}

export { summarize };
