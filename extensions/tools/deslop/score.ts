/**
 * Deterministic scorer. No model, no network, no randomness: the same text and
 * the same rule pack always produce the same number, which is what makes the
 * rewrite loop a hill climb instead of a guessing game.
 */

import { AXIS_WEIGHT, RULES, type Axis, type MetricName, type PatternRule, type Profile, type Rule, resolveProfile } from "./rules.ts";
import { maskProtected, proseView } from "./mask.ts";

export interface Metrics {
	words: number;
	sentences: number;
	meanSentence: number;
	longSentenceShare: number;
	gradeLevel: number;
	nominalizationShare: number;
	passivePer100: number;
	boldPer100: number;
	paraMax: number;
	paraMean: number;
	sectionMaxWords: number;
	bulletShortfall: number;
	sentenceLengthCV: number;
	openerRepeatShare: number;
	duplicatePhraseCount: number;
	headingEchoShare: number;
	hedgePer100: number;
	abstractOpenerShare: number;
	headingCount: number;
	paragraphCount: number;
	listItems: number;
	tableRows: number;
	boldCount: number;
	italicCount: number;
	codeBlocks: number;
	mediumKinds: number;
	parallelParagraphs: number;
	numericParagraphs: number;
	definitions: number;
	listMissed: number;
	tableMissed: number;
	boldMissing: number;
	italicMissing: number;
}

export interface RuleHit {
	id: string;
	axis: Axis;
	label: string;
	fix: string;
	penalty: number;
	count: number;
	evidence: string[];
	terms?: string[];
}

export interface ScoreReport {
	total: number;
	band: string;
	axes: Record<Axis, number>;
	hits: RuleHit[];
	metrics: Metrics;
	words: number;
	sentences: number;
	profile: string;
	/** Weighted penalty ratio before the calibration curve. 0 is clean. */
	rawX: number;
	/** Set when a single violation capped the total below the weighted average. */
	capReason?: string;
	cap?: number;
}

/**
 * A tell that is present at all costs a fixed share of the rule. The rest of the
 * penalty ramps with density, so repeated tells cost more than one.
 */
const PRESENCE = 0.35;

/**
 * Calibration curve. Fitted by least squares in log space over the anchor set in
 * deslop.test.ts, not chosen by hand:
 *
 *   tiny slop 25 · bad 35 · links 50 · wall 70 · ok 82 · good 93 · mixed 95
 *
 * Fit residual is 2.7% RMS, and the fitted exponent lands on 1.0, so the curve is
 * linear: a document loses 1.65 points per point of weighted penalty. Refit with
 * the same anchors if the rule pack changes; never tune these by eye.
 */
export const CURVE = { k: 1.65, g: 1.0 };

/**
 * A rule only carries weight when the text could break it. Rules that need
 * headings, several paragraphs, or a long document are skipped on short inputs.
 */
export function applicable(rule: Rule, metrics: Metrics, profile: Profile): boolean {
	switch (rule.id) {
		case "heading_echo":
		case "section_length":
			return metrics.headingCount >= 1;
		case "medium_variety":
			return metrics.words >= 120;
		case "bold_missing":
			return metrics.words >= 150;
		case "list_opportunity":
		case "table_opportunity":
			return metrics.words >= 100;
		case "italic_terms":
			return metrics.definitions >= 1;
		case "duplicate_phrases":
			return metrics.words >= 150;
		case "sentence_rhythm":
		case "repeated_openers":
			return metrics.sentences >= 5;
		case "paragraph_length":
		case "paragraph_mean":
			return metrics.paragraphCount >= 3;
		case "emoji_decoration":
		case "bold_decoration":
		case "listicle_stem":
			return true;
		default:
			return true;
	}
}

/**
 * Only content defects can cap a score. Missing bold or a missed table is a
 * missed opportunity, not a reason to fail the document.
 */
const CAP_RULES = new Set([
	"not_x_but_y",
	"one_line_closer",
	"deep_saying",
	"staged_runup",
	"arguing_with_no_one",
	"ai_vocabulary",
	"inflated_significance",
	"borrowed_authority",
	"chat_residue",
	"paragraph_length",
	"medium_variety",
]);

const HEDGES =
	/\b(?:possibly|perhaps|potentially|arguably|somewhat|presumably|seemingly|in some cases|to some extent|generally speaking|tends? to|seems? to|appears? to)\b/gi;
const PASSIVE =
	/\b(?:is|are|was|were|be|been|being|has been|have been|had been)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi;

function words(text: string): string[] {
	return text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
}

function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])[ \t]+|\n+/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => words(sentence).length > 0);
}

function syllables(word: string): number {
	let clean = word.toLowerCase().replace(/[^a-z]/g, "");
	if (!clean) return 0;
	if (clean.length <= 3) return 1;
	clean = clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
	const groups = clean.match(/[aeiouy]{1,2}/g);
	return Math.max(1, groups ? groups.length : 1);
}

function mean(values: number[]): number {
	return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values: number[]): number {
	if (values.length < 2) return 0;
	const avg = mean(values);
	return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function round(value: number, places = 2): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

function firstWord(sentence: string): string {
	return (sentence.match(/[A-Za-z']+/) ?? [""])[0].toLowerCase();
}

function countBlocks(original: string): { listItems: number; tableRows: number; boldCount: number; italicCount: number; codeBlocks: number } {
	const lines = original.split("\n");
	const listItems = lines.filter((line) => /^\s{0,3}(?:[-*+]|\d+\.)\s+\S/.test(line)).length;
	const tableRows = original
		.split("\n")
		.filter((line) => /^\s*\|.*\|\s*$/.test(line) || /[│┃]/.test(line)).length;
	const boldCount = (original.match(/\*\*[^*\n]{1,80}\*\*/g) ?? []).length;
	const italics = (original.match(/(?<![*_\w])(?:\*[^*\n]{1,80}\*|_[^_\n]{1,80}_)(?![*_\w])/g) ?? []).length;
	const codeBlocks = Math.floor(((original.match(/^\s*```/gm) ?? []).length) / 2);
	return { listItems, tableRows, boldCount, italicCount: italics, codeBlocks };
}

function computeMetrics(masked: string, original: string, profile: Profile): Metrics {
	const prose = proseView(masked);
	const tokens = words(prose);
	const list = sentences(prose);
	const wordCount = tokens.length;
	const sentenceCount = list.length;
	const lengths = list.map((sentence) => words(sentence).length).filter((length) => length > 0);
	const per100 = (count: number) => (wordCount ? (count * 100) / wordCount : 0);

	const syllableTotal = tokens.reduce((sum, token) => sum + syllables(token), 0);
	const gradeLevel =
		wordCount && sentenceCount
			? 0.39 * (wordCount / sentenceCount) + 11.8 * (syllableTotal / wordCount) - 15.59
			: 0;

	const nominalizations = tokens.filter((token) => /(?:tion|sion|ment|ance|ence|ity|ness)$/i.test(token)).length;
	const hedges = (prose.match(HEDGES) ?? []).length;
	const passives = (masked.match(PASSIVE) ?? []).length;
	const boldCount = (masked.match(/\*\*[^*\n]+\*\*/g) ?? []).length;

	const paragraphs = masked
		.split(/\n\s*\n/)
		.filter((block) => {
			// A list is not a paragraph. Counting six numbered items as one
			// fourteen-sentence paragraph invents a defect the text does not have.
			const lines = block.split("\n").filter((line) => line.trim());
			if (!lines.length) return false;
			const listish = lines.filter((line) => /^\s{0,3}(?:[-*+]|\d+\.)\s+/.test(line)).length;
			return listish / lines.length < 0.6;
		})
		.map((block) => proseView(block))
		.filter((block) => words(block).length > 0);
	const paragraphSentences = paragraphs.map((block) => sentences(block).length).filter((count) => count > 0);

	const sections = masked.split(/^\s{0,3}#{1,6}\s+.*$/m).slice(1);
	const sectionWords = sections.map((section) => words(proseView(section)).length);

	const nonEmptyLines = masked.split("\n").filter((line) => line.trim()).length;
	const bulletLines = (masked.match(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm) ?? []).length;
	const bulletShare = nonEmptyLines ? bulletLines / nonEmptyLines : 0;
	const bulletShortfall = wordCount >= 300 && profile.minBulletShare > 0 && bulletShare < profile.minBulletShare ? 1 : 0;

	const cv = sentenceCount && mean(lengths) ? stdev(lengths) / mean(lengths) : 0;

	let openerRepeats = 0;
	for (let index = 1; index < list.length; index += 1) {
		const previous = firstWord(list[index - 1]);
		if (previous && previous === firstWord(list[index])) openerRepeats += 1;
	}
	const openerRepeatShare = list.length > 1 ? openerRepeats / (list.length - 1) : 0;

	const seenGrams = new Map<string, number>();
	let duplicatePhraseCount = 0;
	for (const sentence of list) {
		const sentenceWords = words(sentence).map((word) => word.toLowerCase());
		for (let index = 0; index + 4 < sentenceWords.length; index += 1) {
			const gram = sentenceWords.slice(index, index + 5).join(" ");
			const previous = seenGrams.get(gram) ?? 0;
			if (previous > 0) duplicatePhraseCount += 1;
			seenGrams.set(gram, previous + 1);
		}
	}

	const blocks = countBlocks(original);

	// A paragraph of parallel statements or of compared numbers wants a list or a
	// table. Detect the opportunity only when none was taken.
	let parallelParagraphs = 0;
	let numericParagraphs = 0;
	for (const block of masked.split(/\n\s*\n/)) {
		const prose = proseView(block);
		const list = sentences(prose);
		if (list.length < 3) continue;
		const withNumbers = list.filter((sentence) => /\d/.test(sentence)).length;
		const labelled = list.filter((sentence) => /^[A-Z][^.:\n]{0,40}:\s/.test(sentence)).length;
		if (withNumbers >= 3 || labelled >= 2) parallelParagraphs += 1;
		const numbersInBlock = (prose.match(/\d+(?:[.,]\d+)*/g) ?? []).length;
		if (numbersInBlock >= 4) numericParagraphs += 1;
	}

	const definitions = sentences(prose).filter((sentence) =>
		/(?:^|[.!?]\s+)[A-Za-z][\w-]{1,20}\s+(?:is|are)\s+(?:a|an|the)\s/i.test(sentence),
	).length;

	const headingEchoShare = computeHeadingEcho(masked);
	const abstractOpeners = list.filter((sentence) =>
		/^(?:it|there|this|that|these|those|one)\s+(?:is|are|was|were|has|have|had|can|may|might|will|would|should)\b/i.test(sentence),
	).length;

	return {
		words: wordCount,
		sentences: sentenceCount,
		meanSentence: round(mean(lengths)),
		longSentenceShare: round(lengths.filter((length) => length > 35).length / Math.max(1, lengths.length)),
		gradeLevel: round(Math.max(0, gradeLevel), 1),
		nominalizationShare: round(nominalizations / Math.max(1, wordCount), 3),
		passivePer100: round(per100(passives)),
		boldPer100: round(per100(boldCount)),
		paraMax: Math.max(0, ...paragraphSentences),
		paraMean: round(mean(paragraphSentences), 1),
		sectionMaxWords: Math.max(0, ...sectionWords),
		bulletShortfall,
		sentenceLengthCV: round(cv),
		openerRepeatShare: round(openerRepeatShare),
		duplicatePhraseCount,
		headingEchoShare: round(headingEchoShare),
		hedgePer100: round(per100(hedges)),
		abstractOpenerShare: round(abstractOpeners / Math.max(1, sentenceCount)),
		headingCount: (masked.match(/^\s{0,3}#{1,6}\s+\S/gm) ?? []).length,
		paragraphCount: paragraphSentences.length,
		...blocks,
		mediumKinds: [
			(masked.match(/^\s{0,3}#{1,6}\s+\S/gm) ?? []).length > 0,
			blocks.listItems > 0,
			blocks.tableRows > 0,
			blocks.codeBlocks > 0,
			blocks.boldCount > 0,
			blocks.italicCount > 0,
		].filter(Boolean).length,
		parallelParagraphs,
		numericParagraphs,
		definitions,
		listMissed: wordCount >= 100 && blocks.listItems === 0 ? round(Math.min(1, parallelParagraphs / 2)) : 0,
		tableMissed: wordCount >= 100 && blocks.tableRows === 0 ? round(Math.min(1, numericParagraphs / 2)) : 0,
		boldMissing: wordCount >= 150 && blocks.boldCount === 0 ? 1 : 0,
		italicMissing: definitions >= 1 && blocks.italicCount === 0 ? 1 : 0,
	};
}

function computeHeadingEcho(masked: string): number {
	const blocks = masked.split(/^\s{0,3}(#{1,6})\s+(.+)$/m);
	let headings = 0;
	let echoes = 0;
	for (let index = 1; index < blocks.length - 1; index += 2) {
		const heading = blocks[index + 1] ?? "";
		const body = blocks[index + 2] ?? "";
		const headingWords = heading
			.toLowerCase()
			.match(/[a-z][a-z'-]{2,}/g)
			?.filter((word) => !/^(?:the|and|for|with|that|this|your|our|you|are|was|its|from|into|how|why|what)$/.test(word));
		if (!headingWords || headingWords.length < 2) continue;
		const firstSentence = sentences(proseView(body))[0];
		if (!firstSentence) continue;
		const first = firstSentence.toLowerCase();
		const shared = headingWords.filter((word) => first.includes(word)).length;
		headings += 1;
		if (shared / headingWords.length >= 0.6) echoes += 1;
	}
	return headings ? echoes / headings : 0;
}

function patternHits(rule: PatternRule, prose: string): { count: number; evidence: string[]; terms?: string[] } {
	const regex = new RegExp(rule.source, rule.flags.includes("g") ? rule.flags : `${rule.flags}g`);
	const evidence: string[] = [];
	const terms = new Set<string>();
	let count = 0;
	for (const match of prose.matchAll(regex)) {
		count += 1;
		if (rule.terms) terms.add(match[0].toLowerCase());
		if (evidence.length < 3) {
			const start = Math.max(0, (match.index ?? 0) - 30);
			const end = Math.min(prose.length, (match.index ?? 0) + match[0].length + 30);
			evidence.push(`${start > 0 ? "…" : ""}${prose.slice(start, end).replace(/\s+/g, " ").trim()}${end < prose.length ? "…" : ""}`);
		}
	}
	return { count, evidence, terms: rule.terms ? [...terms].slice(0, 14) : undefined };
}

function metricPenalty(rule: Rule, metrics: Metrics, profile: Profile): number {
	if (rule.kind !== "metric") return 0;
	const value = metrics[rule.metric as MetricName];
	let good = rule.good;
	let bad = rule.bad;
	if (rule.profileKey === "maxSentence") {
		good = profile.maxSentence - 6;
		bad = profile.maxSentence + 7;
	} else if (rule.profileKey === "maxGrade") {
		good = profile.maxGrade - 1;
		bad = profile.maxGrade + 4;
	} else if (rule.profileKey === "maxParaSentences") {
		good = profile.maxParaSentences;
		bad = profile.maxParaSentences + 4;
	}
	if (good === bad) return 0;
	const penalty = (value - good) / (bad - good);
	return clamp01(penalty);
}

export function analyze(text: string, profileName: string | Profile = "general"): ScoreReport {
	const profile = resolveProfile(profileName);
	const { masked } = maskProtected(text);
	const prose = proseView(masked);
	const metrics = computeMetrics(masked, text, profile);
	const hits: RuleHit[] = [];

	for (const rule of RULES) {
		// A rule that cannot apply to this text must not produce a hit either,
		// otherwise short inputs are punished for rules they never faced.
		if (!applicable(rule, metrics, profile)) continue;
		if (rule.kind === "pattern") {
			const { count, evidence, terms } = patternHits(rule, prose);
			// Density, not a flat per-hit cost: one tell in 200 words is a
			// different document from one tell in 2,000.
			const rate = (count * 100) / Math.max(60, metrics.words);
			const penalty = count === 0 ? 0 : clamp01(PRESENCE + (1 - PRESENCE) * (rate / rule.density));
			if (penalty > 0) {
				hits.push({ id: rule.id, axis: rule.axis, label: rule.label, fix: rule.fix, penalty, count, evidence, terms });
			}
			continue;
		}
		const penalty = metricPenalty(rule, metrics, profile);
		if (penalty > 0.02) {
			const value = metrics[rule.metric as MetricName];
			hits.push({
				id: rule.id,
				axis: rule.axis,
				label: rule.label,
				fix: rule.fix,
				penalty,
				count: 1,
				evidence: [`${rule.metric} = ${value}`],
			});
		}
	}

	const axes: Record<Axis, number> = { plain: 100, human: 100, structured: 100, dense: 100 };
	// Opportunity: a 40-word sample cannot demonstrate eighteen tells, so the
	// denominator scales with how much text the rules had to work with. Without
	// this, short slop samples score as if they passed rules they never faced.
	const opportunity = Math.min(1, Math.max(0.2, metrics.words / 250));

	let rawX = 0;
	let effectiveWeight = 0;
	let effectiveTotal = 0;
	for (const axis of Object.keys(axes) as Axis[]) {
		const allRules = RULES.filter((rule) => rule.axis === axis);
		const axisRules = allRules.filter((rule) => applicable(rule, metrics, profile));
		const fullWeight = allRules.reduce((sum, rule) => sum + rule.weight, 0);
		const applicableWeight = axisRules.reduce((sum, rule) => sum + rule.weight, 0);
		if (applicableWeight === 0) {
			axes[axis] = 100;
			continue;
		}
		const weightedPenalty = hits
			.filter((hit) => hit.axis === axis)
			.reduce((sum, hit) => {
				const rule = RULES.find((candidate) => candidate.id === hit.id);
				return sum + (rule?.weight ?? 0) * hit.penalty;
			}, 0);
		const share = weightedPenalty / (applicableWeight * opportunity);
		axes[axis] = round(Math.max(0, 100 * Math.max(0, 1 - CURVE.k * share) ** CURVE.g), 1);

		// An axis the text cannot be judged on contributes little, and the total is
		// renormalised over the weight that remains.
		const axisWeight = AXIS_WEIGHT[axis] * (applicableWeight / fullWeight);
		effectiveWeight += axisWeight;
		effectiveTotal += axes[axis] * axisWeight;
		rawX += axisWeight * share;
	}

	const averaged = effectiveWeight > 0 ? effectiveTotal / effectiveWeight : 100;

	// One severe violation is a verdict, not a rounding error. A document with a
	// 14-sentence paragraph, or with a strong tell left in, cannot be an A no
	// matter how clean the other axes are: averaging over ten rules per axis
	// would let it through.
	let cap = 100;
	let capReason: string | undefined;
	for (const hit of hits) {
		if (!CAP_RULES.has(hit.id)) continue;
		const rule = RULES.find((candidate) => candidate.id === hit.id);
		if (!rule) continue;
		const ceiling = hit.penalty >= 0.85 && rule.weight >= 8 ? 74 : hit.penalty >= 0.8 ? 79 : 100;
		if (ceiling < cap) {
			cap = ceiling;
			capReason = hit.label;
		}
	}

	const total = round(Math.min(averaged, cap), 1);

	hits.sort((left, right) => right.penalty - left.penalty || right.count - left.count);

	return {
		total,
		band: bandFor(total),
		axes,
		hits,
		metrics,
		words: metrics.words,
		sentences: metrics.sentences,
		profile: profile.name,
		rawX: round(rawX, 4),
		cap: cap < 100 ? cap : undefined,
		capReason,
	};
}

export function bandFor(total: number): string {
	if (total >= 90) return "A";
	if (total >= 80) return "B";
	if (total >= 70) return "C";
	if (total >= 60) return "D";
	if (total >= 50) return "E";
	return "F";
}

/** Rules worth sending to the rewriter: the highest weight times penalty. */
export function topFixes(report: ScoreReport, limit = 8): RuleHit[] {
	const weightOf = (id: string) => RULES.find((rule) => rule.id === id)?.weight ?? 1;
	return [...report.hits]
		.filter((hit) => hit.axis !== "dense" || hit.penalty > 0.2)
		.sort((left, right) => weightOf(right.id) * right.penalty - weightOf(left.id) * left.penalty)
		.slice(0, limit);
}

export function summarize(report: ScoreReport): string {
	const remaining = report.hits.slice(0, 3).map((hit) => hit.label);
	const tail = remaining.length ? ` · left: ${remaining.join(", ")}` : "";
	const cap = report.capReason ? ` · capped at ${report.cap} by ${report.capReason}` : "";
	return `${report.total.toFixed(1)} ${report.band} (plain ${report.axes.plain} · human ${report.axes.human} · structured ${report.axes.structured} · dense ${report.axes.dense})${cap}${tail}`;
}
