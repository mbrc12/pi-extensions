/**
 * Protected spans. Code, links, math, tables, paths, and flags are lifted out of
 * the text before any rewrite, replaced by numbered tokens, and put back
 * afterwards. The rewriter is told to keep the tokens; the guard verifies it.
 */

const TOKEN = (n: number) => `[[${n}]]`;

const PATTERNS: RegExp[] = [
	/^---\n[\s\S]*?\n---\n?/, // YAML frontmatter
	/```[\s\S]*?```/g, // fenced code
	/~~~[\s\S]*?~~~/g,
	/`[^`\n]+`/g, // inline code
	/\$\$[\s\S]*?\$\$/g, // display math
	/\$[^$\n]+\$/g, // inline math
	/!?\[[^\]\n]*\]\([^)\n]*\)/g, // whole markdown link or image, text included
	/^(?:[ \t]*\|.*\|[ \t]*\n?)+/gm, // tables
	/https?:\/\/[^\s<>()]+/g, // bare URLs
	/(?:^|[\s(])(?:~\/|\/(?:[\w.-]+\/)+)[\w.-]*/g, // absolute and home paths
	/(?:^|\s)--?[a-z][\w-]*/gi, // flags
];

export interface Masked {
	masked: string;
	spans: string[];
}

export function maskProtected(text: string): Masked {
	const spans: string[] = [];
	let masked = text;
	for (const pattern of PATTERNS) {
		masked = masked.replace(pattern, (match) => {
			// Keep a leading space or paren that belongs to the surrounding sentence.
			const lead = match.match(/^[\s(]/)?.[0] ?? "";
			const body = lead ? match.slice(lead.length) : match;
			if (!body.trim()) return match;
			spans.push(body);
			return `${lead}${TOKEN(spans.length - 1)}`;
		});
	}
	return { masked, spans };
}

export interface RestoreResult {
	text: string;
	missing: number[];
	duplicated: number[];
	unknownTokens: string[];
}

export function restoreProtected(masked: string, spans: string[]): RestoreResult {
	const missing: number[] = [];
	const duplicated: number[] = [];
	const unknownTokens: string[] = [];
	const seen = new Map<number, number>();

	for (const match of masked.matchAll(/\[\[(\d+)\]\]/g)) {
		const index = Number(match[1]);
		seen.set(index, (seen.get(index) ?? 0) + 1);
		if (index >= spans.length) unknownTokens.push(match[0]);
	}
	for (let index = 0; index < spans.length; index += 1) {
		const count = seen.get(index) ?? 0;
		if (count === 0) missing.push(index);
		else if (count > 1) duplicated.push(index);
	}

	const text = masked.replace(/\[\[(\d+)\]\]/g, (whole, digits: string) => {
		const index = Number(digits);
		return index < spans.length ? spans[index] : whole;
	});

	return { text, missing, duplicated, unknownTokens };
}

/** Prose-only view for scoring: tokens, markdown syntax, and list markers removed. */
export function proseView(masked: string): string {
	return masked
		.replace(/\[\[\d+\]\]/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}[-*+]\s+/gm, "")
		.replace(/^\s{0,3}\d+\.\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, "$1")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
