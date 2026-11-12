/**
 * House policy: the parts of AGENTS.md that change how text is rewritten.
 *
 * Two mechanisms, kept separate on purpose:
 *   - hard invariants, enforced by the guard (links and paths are never dropped)
 *   - soft directives, passed to the rewriter as short lines (bullets, LaTeX,
 *     contractions, punctuation limits)
 *
 * Only lines that match a known concern are lifted, so an unrelated AGENTS.md
 * stays out of the prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface HousePolicy {
	preferBullets: boolean;
	preserveLinks: boolean;
	latexForFiles: boolean;
	expandContractions: boolean;
	directives: string[];
	sources: string[];
}

const KNOWN_DIRECTIVES: Array<{ test: RegExp; keep: boolean }> = [
	{ test: /\bbullet/i, keep: true },
	{ test: /\blinks?\b/i, keep: true },
	{ test: /\blatex|\bmath\b|\\mathrm|katex/i, keep: true },
	{ test: /contraction/i, keep: true },
	{ test: /em dash|semicolon|punctuation/i, keep: true },
	{ test: /\bbold\b|\bitalic\b|decoration/i, keep: true },
	{ test: /plain (?:word|english)|readab|simple english/i, keep: true },
	{ test: /one idea per sentence|sentence length|35 words/i, keep: true },
	{ test: /define (?:each|technical)|technical term/i, keep: true },
	{ test: /emit emoji|emoji/i, keep: true },
];

function candidateLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.replace(/^\s{0,3}[-*+]\s+/, "").replace(/^\s{0,3}#{1,6}\s+/, "").trim())
		.map((line) => line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"))
		.filter((line) => line.length >= 20 && line.length <= 220)
		.filter((line) => !line.startsWith("|"))
		// Instructions addressed to an agent, not rules for the text.
		.filter((line) => !/load `|read skill|localhost:1002|never (?:restart|quit|kill)|run \/reload|check extensions/i.test(line));
}

function ancestors(cwd: string): string[] {
	const found: string[] = [];
	let current = resolve(cwd);
	for (let depth = 0; depth < 6; depth += 1) {
		found.push(join(current, "AGENTS.md"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return found;
}

export function loadHousePolicy(cwd: string, options: { agentDir?: string; fileTarget?: boolean } = {}): HousePolicy {
	const policy: HousePolicy = {
		preferBullets: false,
		preserveLinks: true,
		latexForFiles: Boolean(options.fileTarget),
		expandContractions: false,
		directives: [],
		sources: [],
	};

	const paths = [...ancestors(cwd)];
	if (options.agentDir) paths.push(join(options.agentDir, "AGENTS.md"));

	const seen = new Set<string>();
	const directives: string[] = [];

	for (const path of paths) {
		if (seen.has(path) || !existsSync(path)) continue;
		seen.add(path);
		let text = "";
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		policy.sources.push(path);

		const lines = candidateLines(text);
		for (const line of lines) {
			const match = KNOWN_DIRECTIVES.find((entry) => entry.test.test(line));
			if (!match) continue;
			if (/\bbullet/i.test(line)) policy.preferBullets = true;
			if (/\blinks?\b/i.test(line)) policy.preserveLinks = true;
			if (/latex|\bmath\b/i.test(line) && options.fileTarget) policy.latexForFiles = true;
			if (/contraction/i.test(line)) policy.expandContractions = /write (?:them )?out|expand/i.test(line);
			if (directives.length < 8 && !directives.includes(line)) directives.push(line);
		}
	}

	policy.directives = directives;
	return policy;
}

export function policyBlock(policy: HousePolicy): string {
	const lines: string[] = [];
	if (policy.preferBullets) {
		lines.push("Prefer bullets for parallel items. Prose connects bullets; it does not carry the document.");
	}
	if (policy.preserveLinks) {
		lines.push("Keep every link, its text, and its target exactly as written.");
	}
	if (policy.latexForFiles) {
		lines.push("Keep math in LaTeX, keep display math on its own line, and do not convert formulas to words.");
	}
	if (policy.expandContractions) {
		lines.push("Write contractions out in full.");
	}
	lines.push("Allow at most one em dash per paragraph. Prefer a full stop.");
	for (const directive of policy.directives) {
		if (lines.length >= 10) break;
		lines.push(directive);
	}
	return lines.map((line) => `- ${line}`).join("\n");
}
