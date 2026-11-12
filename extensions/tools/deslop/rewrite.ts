/**
 * The rewrite engine: measure, rewrite the sections that lose the reader, guard
 * the result, re-measure, keep the better text. The model never decides whether
 * it improved anything; the deterministic score does.
 */

import { appendFileSync } from "node:fs";
import type { ModelCompletionContext } from "../../shared/model-config.ts";
import { completeWithModelFallback } from "../../shared/model-config.ts";
import { auditDocument, type AuditResult } from "./audit.ts";
import { factsPreserved, guardRewrite } from "./guard.ts";
import { applyStructural, buildSpine, joinSections } from "./spine.ts";
import { type HousePolicy, loadHousePolicy, policyBlock } from "./policy.ts";
import { splitSections, type Section } from "./sections.ts";
import { attemptSection, type Complete } from "./attempt.ts";
import { mapLimit, repairMessage } from "./retry.ts";
import { countWords } from "./text.ts";
import { replaceHint, resolveProfile, type Profile } from "./rules.ts";
import { analyze, summarize, topFixes, type RuleHit, type ScoreReport } from "./score.ts";

/** DESLOP_DEBUG=1 appends prompts and guard verdicts to /tmp/deslop-debug.log. */
const START = Date.now();

function debug(label: string, body: string): void {
	if (!process.env.DESLOP_DEBUG) return;
	try {
		appendFileSync("/tmp/deslop-debug.log", `\n===== ${label} (+${Date.now() - START}ms) =====\n${body}\n`);
	} catch {
		// logging must never break a run
	}
}

const MAX_ATTEMPTS = 3;

export interface DeslopOptions {
	profile?: string | Profile;
	target?: number;
	maxPasses?: number;
	/** Run one pass even when the text already scores at or above the target. */
	force?: boolean;
	/** Run the document-level audit and apply structural edits. Default true. */
	audit?: boolean;
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
	| { kind: "audit_start"; sections: number }
	| { kind: "audit_done"; findings: number; worst: number; ops: number; summary: string }
	| { kind: "restructure"; applied: string[]; rejected: string[]; before: number; after: number }
	| { kind: "pass_start"; pass: number; passes: number; sections: number; rules: number }
	| { kind: "section_done"; pass: number; attempt: number; done: number; total: number; accepted: boolean; note?: string }
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
	audit?: AuditResult;
	structural?: { applied: string[]; rejected: string[] };
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

function buildSystemPrompt(
	policy: HousePolicy,
	profileName: string | Profile,
	hits: RuleHit[],
	instructions: string[] = [],
): string {
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
		instructions.length ? `Document-level findings to address here:\n${instructions.map((line) => `- ${line}`).join("\n")}` : "",
		"",
		"Findings to fix, strongest first:",
		findings,
	]
		.filter((line) => line !== "")
		.join("\n");
}

function extractText(response: any): string {
	if (!response || !Array.isArray(response.content)) return "";
	return response.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

/** Adapt the configured model fallback chain into the completer attemptSection expects. */
function makeCompleter(ctx: ModelCompletionContext, signal?: AbortSignal): Complete {
	return async (request, options) => {
		const { response } = await completeWithModelFallback(
			ctx,
			"deslopRewrite",
			request as any,
			{ ...options, signal, cacheRetention: "short" },
			{},
		);
		return extractText(response);
	};
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
	const concurrency = Math.max(1, Math.min(6, options.concurrency ?? 4));
	const complete = makeCompleter(ctx, options.signal);

	let current = input;
	// The length band is anchored to the original, never to the previous pass.
	// Otherwise three passes at 80% each quietly delete half the document.
	const originalWords = Math.max(1, countWords(input));
	let best = analyze(current, profile);
	const notes: string[] = [];
	emit({ kind: "measure", report: best, label: "before" });

	// ---- document audit ------------------------------------------------------
	// One call over the spine, before any sentence is touched. Structural edits are
	// applied by section id and fact-checked; everything else becomes an instruction
	// for the rewrite pass.
	let audit: AuditResult | undefined;
	let auditInstructions: string[] = [];
	let structural: { applied: string[]; rejected: string[] } | undefined;

	if (options.audit !== false && countWords(current) >= 150) {
		const spine = buildSpine(current);
		if (spine.sections.length >= 2) {
			emit({ kind: "audit_start", sections: spine.sections.length });
			audit = await auditDocument(ctx, spine, { signal: options.signal });
			const worst = audit.findings.reduce((max, finding) => Math.max(max, finding.severity), 0);
			emit({ kind: "audit_done", findings: audit.findings.length, worst, ops: audit.ops.length, summary: audit.summary });
			auditInstructions = audit.instructions;

			if (audit.ops.length) {
				const beforeTotal = best.total;
				const applied = applyStructural(spine, audit.ops);
				const facts = factsPreserved(current, applied.text);
				const shrink = countWords(applied.text) / originalWords;
				if (!applied.applied.length) {
					structural = { applied: [], rejected: applied.rejected };
				} else if (!facts.ok) {
					structural = { applied: [], rejected: [...applied.rejected, `not applied: ${facts.missing.slice(0, 2).join(", ")} would be lost`] };
				} else if (shrink < 0.7) {
					structural = { applied: [], rejected: [...applied.rejected, `not applied: would remove ${Math.round((1 - shrink) * 100)}% of the words`] };
				} else {
					current = applied.text;
					best = analyze(current, profile);
					structural = { applied: applied.applied, rejected: applied.rejected };
					emit({ kind: "restructure", applied: applied.applied, rejected: applied.rejected, before: beforeTotal, after: best.total });
				}
			}
		}
	}

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

		// Only sections with findings are worth a call. A clean section is returned
		// untouched; the audit may still force the opening section on pass one.
		const targets = sections
			.map((section, index) => ({ index, section, hits: sectionHits[index] }))
			.filter((item, index) => item.hits.length > 0 || (passes === 1 && index === 0 && auditInstructions.length > 0));

		const rewritten = sections.map((section) => section.raw);
		let pending = targets.map((item) => ({ ...item, feedback: "" }));
		let done = 0;

		// Waves, not per-section retries: every section that failed gets its retry at
		// the same time, with the criterion it broke named in the prompt.
		for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length; attempt += 1) {
			if (options.signal?.aborted) break;
			const round = await mapLimit(pending, concurrency, async (item) => {
				const systemPrompt = buildSystemPrompt(policy, profile, item.hits, passes === 1 ? auditInstructions : []);
				debug("dispatch", `${item.section.words} words${item.feedback ? " (retry)" : ""}`);
				return { item, result: await attemptSection(complete, item.section, systemPrompt, item.feedback) };
			});

			const next: typeof pending = [];
			for (const { item, result } of round) {
				done += 1;
				if (result.status === "accepted") {
					rewritten[item.index] = result.text;
				} else if (attempt < MAX_ATTEMPTS && result.status === "invalid") {
					next.push({ ...item, feedback: repairMessage(result) });
				} else {
					sectionNotes.push(`section ${item.index + 1}: ${result.reason === "api" ? result.detail : result.reason} after ${attempt} attempt${attempt === 1 ? "" : "s"}`);
				}
				emit({
					kind: "section_done",
					pass: passes,
					attempt,
					done,
					total: targets.length,
					accepted: result.status === "accepted",
					note: result.status === "accepted" ? undefined : result.reason,
				});
			}
			pending = next;
		}

		const candidate = joinSections(rewritten, current.endsWith("\n"));
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
		audit,
		structural,
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
