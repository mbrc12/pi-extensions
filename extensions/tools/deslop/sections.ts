/** Document chunking, kept free of extension imports so it can be tested alone. */

import { maskProtected } from "./mask.ts";
import { countWords } from "./text.ts";

export interface Section {
	raw: string;
	masked: string;
	spans: string[];
	words: number;
}

export const MAX_SECTION_WORDS = 700;

/** Split on headings, then on paragraph blocks when a section is still large. */
export function splitSections(text: string): Section[] {
	const lines = text.split("\n");
	const groups: string[][] = [[]];
	for (const line of lines) {
		if (/^\s{0,3}#{1,6}\s+/.test(line) && groups[groups.length - 1].length) {
			groups.push([]);
		}
		groups[groups.length - 1].push(line);
	}

	// Attach trailing blank lines to the previous group so the join is exact.
	for (let index = groups.length - 1; index > 0; index -= 1) {
		if (groups[index].every((line) => !line.trim())) {
			groups[index - 1].push(...groups[index]);
			groups.splice(index, 1);
		}
	}

	const sections: Section[] = [];
	for (const group of groups) {
		const raw = group.join("\n");
		if (!raw.trim()) continue;
		for (const piece of splitOversize(raw)) {
			const { masked, spans } = maskProtected(piece);
			sections.push({ raw: piece, masked, spans, words: countWords(piece) });
		}
	}
	return sections;
}

function splitOversize(raw: string): string[] {
	if (countWords(raw) <= MAX_SECTION_WORDS * 1.4) return [raw];
	const blocks = raw.split(/\n\s*\n/);
	const pieces: string[] = [];
	let buffer: string[] = [];
	let bufferWords = 0;
	for (const block of blocks) {
		const blockWords = countWords(block);
		if (bufferWords + blockWords > MAX_SECTION_WORDS && buffer.length) {
			pieces.push(buffer.join("\n\n"));
			buffer = [];
			bufferWords = 0;
		}
		buffer.push(block);
		bufferWords += blockWords;
	}
	if (buffer.length) pieces.push(buffer.join("\n\n"));
	return pieces;
}
