/**
 * The spine: what a document says, section by section, without its sentences.
 *
 * A global audit cannot read 5,000 words and stay consistent. It reads this
 * instead: heading, first sentence, last sentence, numbers, length. Ten words per
 * section, enough to see order, balance, promises, and repetition.
 *
 * Every operation here works on section ids and preserves the exact section text,
 * so nothing is rewritten and the guard can prove nothing was lost.
 */

import { contentWords } from "./rules.ts";
import { countWords, sentences, truncate } from "./text.ts";

export interface SpineSection {
	id: string;
	heading: string;
	body: string;
	/** Heading plus body, byte-exact from the source. */
	raw: string;
	first: string;
	last: string;
	numbers: string[];
	words: number;
}

export interface Spine {
	title: string;
	opening: string;
	closing: string;
	promises: string[];
	sections: SpineSection[];
	words: number;
}

const PROMISE = /\b(?:this (?:document|note|post|guide|report|page|section)|the following|below|we(?:'ll| will)|i(?:'ll| will)|covers?|explains?|walks? through|\d+ (?:things|steps|parts|sections|ways))\b/i;

function numbersIn(text: string): string[] {
	const found = text.match(/(?<![\w.[\]])-?\d+(?:[.,]\d+)*%?/g) ?? [];
	return [...new Set(found)].slice(0, 6);
}

/** Split on headings, keeping heading and body separate and the source exact. */
export function buildSpine(text: string): Spine {
	const lines = text.split("\n");
	const groups: string[][] = [[]];
	for (const line of lines) {
		if (/^\s{0,3}#{1,6}\s+/.test(line) && groups[groups.length - 1].length) groups.push([]);
		groups[groups.length - 1].push(line);
	}

	const sections: SpineSection[] = [];
	let index = 0;
	for (const group of groups) {
		const raw = group.join("\n");
		if (!raw.trim()) continue;
		const headingMatch = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/m);
		const heading = headingMatch ? headingMatch[1].trim() : "";
		const body = headingMatch ? raw.slice((headingMatch.index ?? 0) + headingMatch[0].length).trim() : raw.trim();
		const bodySentences = sentences(body);
		sections.push({
			id: `s${index++}`,
			heading,
			body,
			raw,
			first: truncate(bodySentences[0] ?? "", 160),
			last: truncate(bodySentences[bodySentences.length - 1] ?? "", 160),
			numbers: numbersIn(body),
			words: countWords(raw),
		});
	}

	const prose = sections.find((section) => !section.heading) ?? sections[0];
	const openingSentences = sentences(prose?.body ?? "");
	const promises = openingSentences.filter((sentence) => PROMISE.test(sentence)).slice(0, 5);

	return {
		title: sections.find((section) => section.heading)?.heading ?? "",
		opening: truncate(openingSentences.slice(0, 3).join(" "), 400),
		closing: truncate(sentences(sections[sections.length - 1]?.body ?? "").slice(-2).join(" "), 300),
		promises,
		sections,
		words: countWords(text),
	};
}

/**
 * Section pairs worth comparing, measured rather than guessed.
 *
 * Containment (shared words over the smaller section) is a weak signal on its
 * own, so it is offered to the auditor as an observation, never acted on
 * directly. Pairs involving the untitled opening are skipped: an intro shares
 * vocabulary with every section it introduces.
 */
export function pairHints(spine: Spine): Array<{ a: string; b: string; overlap: number }> {
	const candidates = spine.sections.filter((section) => section.heading);
	const sets = candidates.map((section) => new Set(contentWords(section.body)));
	const hints: Array<{ a: string; b: string; overlap: number }> = [];
	for (let i = 0; i < candidates.length; i += 1) {
		for (let j = i + 1; j < candidates.length; j += 1) {
			const left = sets[i];
			const right = sets[j];
			if (!left.size || !right.size) continue;
			let shared = 0;
			for (const word of left) if (right.has(word)) shared += 1;
			const overlap = shared / Math.min(left.size, right.size);
			if (overlap >= 0.35) hints.push({ a: candidates[i].id, b: candidates[j].id, overlap: Math.round(overlap * 100) / 100 });
		}
	}
	return hints.sort((left, right) => right.overlap - left.overlap).slice(0, 3);
}

/** The spine as the auditor sees it: compact, and impossible to confuse with prose. */
export function spineDigest(spine: Spine): string {
	const lines = [`title: ${spine.title || "(none)"}`, `words: ${spine.words}`, `opening: ${spine.opening}`];
	if (spine.promises.length) lines.push(`promises: ${spine.promises.map((p) => `"${p}"`).join(" | ")}`);
	lines.push("sections:");
	for (const section of spine.sections) {
		lines.push(
			`- ${section.id} | ${section.heading || "(untitled)"} | ${section.words}w | first: ${section.first} | numbers: ${section.numbers.join(" ") || "-"}`,
		);
	}
	lines.push(`closing: ${spine.closing}`);
	return lines.join("\n");
}

/** Join sections with exactly one blank line, and keep a trailing newline if the source had one. */
export function joinSections(parts: string[], trailingNewline: boolean): string {
	const body = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
	return trailingNewline ? `${body}\n` : body;
}

export function reassemble(spine: Spine): string {
	return spine.sections.map((section) => section.raw).join("\n");
}

export interface StructuralOp {
	kind: "reorder" | "merge" | "delete";
	order?: string[];
	from?: string;
	into?: string;
	id?: string;
	supersededBy?: string;
}

export interface ApplyResult {
	text: string;
	applied: string[];
	rejected: string[];
}

function renumber(sections: SpineSection[]): SpineSection[] {
	return sections.map((section, index) => ({ ...section, id: `s${index}` }));
}

export function applyStructural(spine: Spine, ops: StructuralOp[]): ApplyResult {
	let sections = [...spine.sections];
	const applied: string[] = [];
	const rejected: string[] = [];

	for (const op of ops) {
		if (op.kind === "reorder" && op.order) {
			const ids = sections.map((section) => section.id);
			if (op.order.join(" ") === ids.join(" ")) {
				rejected.push("reorder: the proposed order is the current order");
				continue;
			}
			const valid = op.order.length === ids.length && op.order.every((id) => ids.includes(id)) && new Set(op.order).size === ids.length;
			if (!valid) {
				rejected.push(`reorder: order does not cover every section exactly once`);
				continue;
			}
			const byId = new Map(sections.map((section) => [section.id, section]));
			sections = op.order.map((id) => byId.get(id)!);
			applied.push(`reordered ${op.order.length} sections: ${op.order.join(" ")}`);
			continue;
		}
		if (op.kind === "merge" && op.from && op.into) {
			const fromIndex = sections.findIndex((section) => section.id === op.from);
			const intoIndex = sections.findIndex((section) => section.id === op.into);
			if (fromIndex < 0 || intoIndex < 0 || fromIndex === intoIndex) {
				rejected.push(`merge: unknown section ${op.from} or ${op.into}`);
				continue;
			}
			const from = sections[fromIndex];
			const into = sections[intoIndex];
			const merged: SpineSection = {
				...into,
				body: `${into.body}\n\n${from.body}`.trim(),
				raw: `${into.raw.trimEnd()}\n\n${from.body}`.trimEnd(),
				words: into.words + from.words,
			};
			sections = sections.map((section, index) => (index === intoIndex ? merged : section)).filter((_, index) => index !== fromIndex);
			applied.push(`merged ${from.id} into ${into.id}`);
			continue;
		}
		if (op.kind === "delete" && op.id) {
			const index = sections.findIndex((section) => section.id === op.id);
			if (index < 0) {
				rejected.push(`delete: unknown section ${op.id}`);
				continue;
			}
			if (!op.supersededBy) {
				rejected.push(`delete ${op.id}: no surviving section named`);
				continue;
			}
			sections = sections.filter((_, position) => position !== index);
			applied.push(`deleted ${op.id}, superseded by ${op.supersededBy}`);
			continue;
		}
		rejected.push(`unknown operation ${JSON.stringify(op).slice(0, 60)}`);
	}

	const rebuilt: Spine = { ...spine, sections: renumber(sections) };
	return { text: reassemble(rebuilt), applied, rejected };
}
