import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRewrite } from "./guard.ts";
import { maskProtected, restoreProtected } from "./mask.ts";
import { splitSections } from "./sections.ts";
import { loadHousePolicy, policyBlock } from "./policy.ts";
import { analyze, topFixes } from "./score.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "deslop");
const bad = readFileSync(join(fixtures, "bad.md"), "utf8");
const good = readFileSync(join(fixtures, "good.md"), "utf8");

describe("score", () => {
	test("separates AI-shaped prose from clean prose", () => {
		const badReport = analyze(bad, "docs");
		const goodReport = analyze(good, "docs");
		expect(badReport.total).toBeLessThan(75);
		expect(goodReport.total).toBeGreaterThan(90);
		expect(goodReport.total - badReport.total).toBeGreaterThan(20);
	});

	test("finds the strong tells", () => {
		const ids = analyze(bad, "docs").hits.map((hit) => hit.id);
		expect(ids).toContain("ai_vocabulary");
		expect(ids).toContain("not_x_but_y");
		expect(ids).toContain("one_line_closer");
		expect(ids).toContain("staged_runup");
	});

	test("ranks fixes by weight times penalty", () => {
		const fixes = topFixes(analyze(bad, "docs"), 3);
		expect(fixes.length).toBe(3);
		expect(fixes[0].penalty).toBeGreaterThanOrEqual(fixes[2].penalty);
	});

	test("is deterministic", () => {
		expect(analyze(bad, "docs").total).toBe(analyze(bad, "docs").total);
	});

	test("ignores code, tables, and links in the score", () => {
		const prose = "The build runs. It fails on the second step.";
		const withNoise = `${prose}\n\n\`\`\`\ndelve testament robust\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
		expect(analyze(withNoise, "docs").total).toBe(analyze(prose, "docs").total);
	});
});

describe("mask", () => {
	test("round-trips protected spans", () => {
		const text = "Read [the guide](https://example.com/a) and run `bun test` before 10:30.\n\n```sh\nnpm i\n```\n";
		const { masked, spans } = maskProtected(text);
		expect(masked).not.toContain("https://example.com");
		const restored = restoreProtected(masked, spans);
		expect(restored.missing).toEqual([]);
		expect(restored.text).toBe(text);
	});

	test("reports a lost placeholder", () => {
		const { masked, spans } = maskProtected("Keep [the link](https://example.com) here.");
		const damaged = masked.replace(/\[\[\d+\]\]/, "");
		const restored = restoreProtected(damaged, spans);
		expect(restored.missing.length).toBe(1);
	});
});

describe("guard", () => {
	test("accepts a faithful rewrite", () => {
		const original = "The migration moved 1400 rows in 3 passes and left the index intact.";
		const { masked, spans } = maskProtected(original);
		const draft = "We moved 1400 rows in 3 passes. The index was left intact.";
		const result = guardRewrite(original, draft + "", spans);
		expect(result.ok).toBe(true);
	});

	test("rejects a dropped number", () => {
		const original = "The migration moved 1400 rows in 3 passes.";
		const { spans } = maskProtected(original);
		const result = guardRewrite(original, "We moved rows in three passes.", spans);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("number 1400");
	});

	test("rejects an invented number", () => {
		const original = "The run took four minutes.";
		const { spans } = maskProtected(original);
		const result = guardRewrite(original, "The run took 4 minutes, down from 11.", spans);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("11");
	});

	test("rejects a dropped name", () => {
		const original = "The pipeline runs on Linux and deploys with Kustomize.";
		const { spans } = maskProtected(original);
		const result = guardRewrite(original, "The pipeline runs on Linux and deploys with a tool.", spans);
		expect(result.ok).toBe(false);
	});

	test("rejects a rewrite that deleted half the content", () => {
		const original = "We moved the cache to the runner and it halved the build time for the main branch, which had been slow for months.";
		const { spans } = maskProtected(original);
		const result = guardRewrite(original, "We moved the cache to the runner.", spans);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("length");
	});

	test("rejects a rewrite that grew too far", () => {
		const original = "We moved the cache to the runner. It halved the build time. Nobody asked why.";
		const { spans } = maskProtected(original);
		const draft = `${original} ${original} ${original} ${original}`;
		const result = guardRewrite(original, draft, spans);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("length");
	});
});

describe("guard: links", () => {
	test("rejects a rewrite that drops a link", () => {
		const original = "Read the [pipeline notes](https://example.com/notes) before the change.";
		const { masked, spans } = maskProtected(original);
		expect(masked).toContain("[[0]]");
		const result = guardRewrite(original, "Read the pipeline notes before the change.", spans);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("placeholder");
	});

	test("keeps a link intact through a rewrite", () => {
		const original = "Read the [pipeline notes](https://example.com/notes) before the change.";
		const { masked, spans } = maskProtected(original);
		const draft = masked.replace("before the change", "first");
		const result = guardRewrite(original, draft, spans);
		expect(result.ok).toBe(true);
		expect(result.restored).toContain("[pipeline notes](https://example.com/notes)");
	});
});

describe("policy", () => {
	test("lifts the document rules from AGENTS.md and skips agent instructions", () => {
		const policy = loadHousePolicy(join(fixtures, "agents"), { fileTarget: true });
		expect(policy.preferBullets).toBe(true);
		expect(policy.preserveLinks).toBe(true);
		expect(policy.latexForFiles).toBe(true);
		const block = policyBlock(policy);
		expect(block).toContain("bullets");
		expect(block).toContain("Keep every link");
		expect(block).not.toContain("serv.app");
	});
});

describe("splitSections", () => {
	test("reassembles the document exactly", () => {
		expect(splitSections(bad).map((section) => section.raw).join("\n")).toBe(bad);
		expect(splitSections(good).map((section) => section.raw).join("\n")).toBe(good);
	});

	test("splits on headings", () => {
		expect(splitSections(good).length).toBeGreaterThan(3);
	});

	test("keeps headings with their body", () => {
		const sections = splitSections(good);
		expect(sections[1].raw.startsWith("## What the pipeline does")).toBe(true);
	});
});
