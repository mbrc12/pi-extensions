/**
 * Fidelity guard. A rewrite is only accepted when every fact in the original
 * survives: numbers, names, links, paths, and the protected spans themselves.
 * The guard runs on the restored text, so it also catches a rewriter that ate a
 * token.
 */

import { restoreProtected } from "./mask.ts";
import { countWords } from "./text.ts";

/**
 * Spelled-out numbers count as numbers. Without this, "four minutes" rewritten
 * as "4 minutes" looks like an invented fact, and "11" invented from nothing
 * looks like a harmless spelling change.
 */
const NUMBER_WORDS: Record<string, string> = {
	two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
	ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
	sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
	thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80",
	ninety: "90", hundred: "100", thousand: "1000", million: "1000000", billion: "1000000000",
};

function normalizeNumbers(text: string): Set<string> {
	const expanded = text.replace(
		/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/gi,
		(match) => NUMBER_WORDS[match.toLowerCase()] ?? match,
	);
	const values = new Set<string>();
	for (const match of expanded.matchAll(/(?<![\w.[\]])-?\d+(?:[.,]\d+)*%?/g)) {
		values.add(match[0].replace(/,/g, "").replace(/%$/, ""));
	}
	return values;
}

export interface Facts {
	numbers: Set<string>;
	entities: Set<string>;
	links: Set<string>;
}

const STOP_ENTITIES = new Set(["The", "This", "That", "These", "Those", "There", "It", "If", "When", "But", "And", "If", "One", "Two", "Three"]);

/** Offsets where a capitalized word is a sentence opener, not a name. */
function sentenceStarts(text: string): Set<number> {
	const starts = new Set<number>();
	let offset = 0;
	for (const line of text.split("\n")) {
		const opener = line.match(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+\.\s+)?/);
		const firstNonSpace = line.search(/\S/);
		if (firstNonSpace >= 0) starts.add(offset + (opener?.[0].length ?? 0));
		for (const match of line.matchAll(/[.!?:]\s+/g)) {
			starts.add(offset + (match.index ?? 0) + match[0].length);
		}
		offset += line.length + 1;
	}
	return starts;
}

export function collectFacts(text: string): Facts {
	// Headings and code are structure, not claims: a rewrite may restyle them.
	const withoutCode = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]+`/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+.*$/gm, " ");

	const numbers = normalizeNumbers(withoutCode);
	const starts = sentenceStarts(withoutCode);

	const entities = new Set<string>();
	for (const match of withoutCode.matchAll(/(?<![\w-])[A-Z][A-Za-z0-9]{1,}/g)) {
		if (starts.has(match.index ?? -1)) continue;
		if (STOP_ENTITIES.has(match[0])) continue;
		entities.add(match[0]);
	}

	const links = new Set<string>();
	for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) links.add(match[0]);
	for (const match of text.matchAll(/\]\(([^)\n]+)\)/g)) links.add(match[1]);

	return { numbers, entities, links };
}

export interface GuardResult {
	ok: boolean;
	restored: string;
	missing: string[];
	added: string[];
	warnings: string[];
	reason?: string;
}

export interface GuardOptions {
	/** Allowed word-count change, as a fraction of the original. */
	tolerance?: number;
	/**
	 * Tighter ceiling than floor. Adding words is always a regression; cutting
	 * verbose prose by up to 30% is normal editing. Facts are guarded separately,
	 * so the floor exists only to stop the optimizer from deleting the document.
	 */
	minRatio?: number;
	maxRatio?: number;
	/** Lower the bar for very short inputs, where one number is a large share. */
	strictEntities?: boolean;
}

export function guardRewrite(
	original: string,
	draftMasked: string,
	spans: string[],
	options: GuardOptions = {},
): GuardResult {
	const warnings: string[] = [];
	const tolerance = options.tolerance ?? 0.3;
	const minRatio = options.minRatio ?? 1 - tolerance;
	const maxRatio = options.maxRatio ?? 1 + Math.min(tolerance, 0.15);

	const restored = restoreProtected(draftMasked, spans);
	if (restored.missing.length || restored.duplicated.length || restored.unknownTokens.length) {
		const parts: string[] = [];
		if (restored.missing.length) parts.push(`${restored.missing.length} lost placeholder(s)`);
		if (restored.duplicated.length) parts.push(`${restored.duplicated.length} duplicated placeholder(s)`);
		if (restored.unknownTokens.length) parts.push(`unknown token ${restored.unknownTokens[0]}`);
		return { ok: false, restored: restored.text, missing: [], added: [], warnings, reason: parts.join(", ") };
	}

	const before = collectFacts(original);
	const after = collectFacts(restored.text);

	const missingNumbers = [...before.numbers].filter((value) => !after.numbers.has(value));
	const missingEntities = [...before.entities].filter((value) => !after.entities.has(value));
	const missingLinks = [...before.links].filter((value) => !after.links.has(value));
	const addedNumbers = [...after.numbers].filter((value) => !before.numbers.has(value));

	const missing = [
		...missingNumbers.map((value) => `number ${value}`),
		...missingEntities.map((value) => `name ${value}`),
		...missingLinks.map((value) => `link ${value}`),
	];
	const added = [...addedNumbers.map((value) => `number ${value}`)];

	const originalWords = countWords(original);
	const draftWords = countWords(restored.text);
	const ratio = originalWords ? draftWords / originalWords : 1;

	// Facts first: "dropped 1400" is more useful than "length 75%".
	if (draftWords === 0) {
		return { ok: false, restored: restored.text, missing, added, warnings, reason: "empty rewrite" };
	}
	if (missing.length) {
		return { ok: false, restored: restored.text, missing, added, warnings, reason: `dropped ${missing.slice(0, 3).join(", ")}` };
	}
	if (added.length) {
		return { ok: false, restored: restored.text, missing, added, warnings, reason: `invented ${added.slice(0, 3).join(", ")}` };
	}
	if (ratio < minRatio || ratio > maxRatio) {
		return {
			ok: false,
			restored: restored.text,
			missing,
			added,
			warnings,
			reason: `length ${Math.round(ratio * 100)}% of original`,
		};
	}

	const negationsBefore = (original.match(/\b(?:not|never|no|cannot|can't|don't|doesn't|didn't|won't|isn't|aren't)\b/gi) ?? []).length;
	const negationsAfter = (restored.text.match(/\b(?:not|never|no|cannot|can't|don't|doesn't|didn't|won't|isn't|aren't)\b/gi) ?? []).length;
	if (Math.abs(negationsBefore - negationsAfter) > 2) {
		warnings.push(`negations ${negationsBefore} → ${negationsAfter}`);
	}

	return { ok: true, restored: restored.text, missing, added, warnings };
}
