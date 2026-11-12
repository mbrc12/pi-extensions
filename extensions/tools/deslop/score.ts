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
}

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

function computeMetrics(masked: string, profile: Profile): Metrics {
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
	const metrics = computeMetrics(masked, profile);
	const hits: RuleHit[] = [];

	for (const rule of RULES) {
		if (rule.kind === "pattern") {
			const { count, evidence, terms } = patternHits(rule, prose);
			const penalty = count === 0 ? 0 : Math.min(1, count * rule.perHit);
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
	for (const axis of Object.keys(axes) as Axis[]) {
		const axisRules = RULES.filter((rule) => rule.axis === axis);
		const totalWeight = axisRules.reduce((sum, rule) => sum + rule.weight, 0);
		const weightedPenalty = hits
			.filter((hit) => hit.axis === axis)
			.reduce((sum, hit) => {
				const rule = RULES.find((candidate) => candidate.id === hit.id);
				return sum + (rule?.weight ?? 0) * hit.penalty;
			}, 0);
		axes[axis] = round(Math.max(0, 100 * (1 - weightedPenalty / Math.max(1, totalWeight))), 1);
	}

	const total = round(
		(Object.keys(axes) as Axis[]).reduce((sum, axis) => sum + axes[axis] * AXIS_WEIGHT[axis], 0),
		1,
	);

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
	return `${report.total.toFixed(1)} ${report.band} (plain ${report.axes.plain} · human ${report.axes.human} · structured ${report.axes.structured} · dense ${report.axes.dense})${tail}`;
}
