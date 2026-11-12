import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRewrite } from "./guard.ts";
import { maskProtected, restoreProtected } from "./mask.ts";
import { splitSections } from "./sections.ts";
import { GLOBAL_RULES, validateAudit } from "./global.ts";
import { factsPreserved } from "./guard.ts";
import { loadHousePolicy, policyBlock } from "./policy.ts";
import { attemptSection } from "./attempt.ts";
import { mapLimit, repairMessage } from "./retry.ts";
import { splitSections } from "./sections.ts";
import { applyStructural, buildSpine, reassemble } from "./spine.ts";
import { analyze, topFixes } from "./score.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "deslop");
const bad = readFileSync(join(fixtures, "bad.md"), "utf8");
const good = readFileSync(join(fixtures, "good.md"), "utf8");
const ok = readFileSync(join(fixtures, "ok.md"), "utf8");
const links = readFileSync(join(fixtures, "links.md"), "utf8");
const wall = readFileSync(join(fixtures, "wall.md"), "utf8");
const mixed = readFileSync(join(fixtures, "mixed.md"), "utf8");
const tiny = "In today's fast-paced world, it's not just a tool, it's a paradigm shift. Let that sink in.";

describe("score", () => {
	test("lands on the calibration anchors", () => {
		// These six are the fit set for CURVE in score.ts. The tolerance covers the
		// 2.7% RMS fit residual; wall.md is the worst point at 4 points off.
		const anchors: Array<[string, string, number]> = [
			[tiny, "tiny slop, 17 words", 25],
			[bad, "bad.md", 35],
			[links, "links.md", 50],
			[mixed, "mixed.md", 95],
			[ok, "ok.md", 82],
			[good, "good.md", 93],
		];
		for (const [text, name, expected] of anchors) {
			const score = analyze(text, "docs").total;
			expect(Math.abs(score - expected), `${name}: ${score} vs ${expected}`).toBeLessThanOrEqual(8);
		}
	});

	test("two sentences of pure slop cannot score as an A", () => {
		expect(analyze(tiny, "docs").total).toBeLessThan(35);
	});

	test("rewards using the medium for the same content", () => {
		const wallReport = analyze(wall, "docs");
		const mixedReport = analyze(mixed, "docs");
		expect(mixedReport.total - wallReport.total).toBeGreaterThan(12);
		expect(wallReport.metrics.mediumKinds).toBe(0);
		expect(mixedReport.metrics.mediumKinds).toBeGreaterThanOrEqual(3);
		expect(mixedReport.structured ?? mixedReport.axes.structured).toBeGreaterThan(90);
		expect(wallReport.axes.structured).toBeLessThan(20);
	});

	test("does not count a numbered list as one long paragraph", () => {
		const list = "Intro line.\n\n1. One item here.\n2. Another item here.\n3. Third item here.\n4. Fourth item here.\n5. Fifth item here.\n6. Sixth item here.";
		const report = analyze(list, "docs");
		expect(report.metrics.paraMax).toBeLessThan(3);
		expect(report.hits.map((hit) => hit.id)).not.toContain("paragraph_length");
	});

	test("does not excuse a wall of prose", () => {
		const wallReport = analyze(wall, "docs");
		const ids = wallReport.hits.map((hit) => hit.id);
		expect(ids).toContain("medium_variety");
		expect(wallReport.capReason).toBe("one format for the whole document");
	});

	test("separates AI-shaped prose from clean prose", () => {
		const badReport = analyze(bad, "docs");
		const goodReport = analyze(good, "docs");
		expect(badReport.total).toBeLessThan(50);
		expect(goodReport.total).toBeGreaterThan(90);
		expect(goodReport.total - badReport.total).toBeGreaterThan(50);
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

	test("does not treat a line-opening word as a name", () => {
		const original = "Removing the per-row forks. The script ran once per popup.";
		const { masked, spans } = maskProtected(original);
		const draft = masked.replace("Removing the per-row forks.", "We removed the per-row forks.");
		const result = guardRewrite(original, draft, spans);
		expect(result.ok).toBe(true);
	});

	test("does not treat a heading word as a name", () => {
		const original = "## Removing the forks\n\nThe script ran once per popup and cost 35 ms.";
		const { spans } = maskProtected(original);
		const draft = "## Fewer forks\n\nThe script ran once per popup and cost 35 ms.";
		const result = guardRewrite(original, draft, spans);
		expect(result.ok).toBe(true);
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

describe("spine", () => {
	test("splits a document into sections and reassembles it exactly", () => {
		const spine = buildSpine(good);
		expect(spine.sections.length).toBeGreaterThan(3);
		expect(reassemble(spine)).toBe(good);
		expect(spine.sections[0].heading).toBe("Continuous integration");
		expect(spine.sections[0].first.length).toBeGreaterThan(10);
		expect(spine.words).toBeGreaterThan(100);
	});

	test("collects promises from the opening", () => {
		const spine = buildSpine(`This document covers the pipeline, the cache, and the rollback path.\n\n${good}`);
		expect(spine.promises.length).toBeGreaterThan(0);
	});

	test("reorders by section id", () => {
		const spine = buildSpine(good);
		const order = [...spine.sections.map((section) => section.id)].reverse();
		const result = applyStructural(spine, [{ kind: "reorder", order }]);
		expect(result.rejected).toEqual([]);
		expect(result.text).toBe([...spine.sections].reverse().map((section) => section.raw).join("\n"));
	});

	test("rejects an order that misses a section", () => {
		const spine = buildSpine(good);
		const result = applyStructural(spine, [{ kind: "reorder", order: [spine.sections[0].id] }]);
		expect(result.applied).toEqual([]);
		expect(result.rejected[0]).toContain("every section");
	});

	test("merges one section into another without losing text", () => {
		const spine = buildSpine(good);
		const [first, second] = spine.sections;
		const result = applyStructural(spine, [{ kind: "merge", from: second.id, into: first.id }]);
		expect(result.text).toContain(first.body);
		expect(result.text).toContain(second.body);
		expect(buildSpine(result.text).sections.length).toBe(spine.sections.length - 1);
	});

	test("refuses a deletion that names no surviving section", () => {
		const spine = buildSpine(good);
		const result = applyStructural(spine, [{ kind: "delete", id: spine.sections[1].id }]);
		expect(result.applied).toEqual([]);
		expect(result.rejected[0]).toContain("no surviving section");
	});

	test("facts survive reordering", () => {
		const spine = buildSpine(good);
		const result = applyStructural(spine, [{ kind: "reorder", order: [...spine.sections.map((s) => s.id)].reverse() }]);
		expect(factsPreserved(good, result.text).ok).toBe(true);
	});
});

describe("retry with the criterion named", () => {
	const original = "The migration moved 1400 rows in 3 passes. We ran it on Linux and it took 11 minutes.";

	/** A section whose spans and masking come from the real pipeline. */
	function sectionOf(text: string) {
		return splitSections(text)[0];
	}

	test("retries an invalid answer and names what it dropped", async () => {
		const section = sectionOf(original);
		const requests: string[] = [];
		let call = 0;
		const complete = async (request: any) => {
			requests.push(JSON.stringify(request.messages));
			call += 1;
			// First answer loses 1400; second answer is faithful.
			return call === 1
				? "The migration moved rows in 3 passes. We ran it on Linux and it took 11 minutes."
				: "We moved 1400 rows in 3 passes on Linux. It took 11 minutes.";
		};
		const first = await attemptSection(complete as any, section, "system");
		expect(first.status).toBe("invalid");
		expect(first.reason).toBe("dropped_fact");
		expect(repairMessage(first)).toContain("1400");

		const second = await attemptSection(complete as any, section, "system", repairMessage(first));
		expect(second.status).toBe("accepted");
		// The retry prompt carries the criterion, not just "try again".
		expect(requests[1]).toContain("1400");
		expect(requests[1]).toContain("Keep every number");
	});

	test("retries a length failure with the actual ratio", async () => {
		const section = sectionOf(original);
		const complete = async () =>
			"The migration moved 1400 rows in 3 passes on Linux and it took 11 minutes in total for the whole run across the cluster.";
		const result = await attemptSection(complete as any, section, "system");
		expect(result.status).toBe("invalid");
		expect(result.reason).toBe("length");
		expect(repairMessage(result)).toMatch(/%/);
	});

	test("an empty answer is retried, not accepted", async () => {
		const section = sectionOf(original);
		const result = await attemptSection(async () => "", section, "system");
		expect(result.status).toBe("invalid");
		expect(result.reason).toBe("empty");
	});
});

describe("concurrency", () => {
	test("runs workers in parallel and keeps the input order", async () => {
		const started = Date.now();
		const results = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 4, async (value) => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return value * 2;
		});
		const elapsed = Date.now() - started;
		expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
		// Serial would be 320 ms. Four at a time is two rounds, about 80 ms.
		expect(elapsed).toBeLessThan(220);
	});

	test("never exceeds the ceiling", async () => {
		let live = 0;
		let peak = 0;
		await mapLimit(Array.from({ length: 12 }, (_, index) => index), 3, async () => {
			live += 1;
			peak = Math.max(peak, live);
			await new Promise((resolve) => setTimeout(resolve, 10));
			live -= 1;
			return 0;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});
});

describe("retry guidance", () => {
	test("names the criterion that was broken", () => {
		expect(repairMessage({ status: "invalid", text: "", reason: "placeholder" })).toContain("[[n]]");
		expect(repairMessage({ status: "invalid", text: "", reason: "dropped_fact", detail: "number 1400" })).toContain("number 1400");
		expect(repairMessage({ status: "invalid", text: "", reason: "invented_number", detail: "11" })).toContain("11");
		expect(repairMessage({ status: "invalid", text: "", reason: "length", detail: "58%" })).toContain("58%");
		expect(repairMessage({ status: "invalid", text: "", reason: "empty" })).toContain("empty");
		expect(repairMessage({ status: "unchanged", text: "", reason: "unchanged" })).toContain("identical");
	});
});

describe("audit validation", () => {
	const allowed = GLOBAL_RULES;

	test("keeps findings that name known rules and sections", () => {
		const spine = buildSpine(good);
		const raw = JSON.stringify({
			summary: "order serves the author",
			findings: [{ rule: "dependency_order", severity: 2, sections: [spine.sections[1].id], evidence: "the cache section comes before what it serves", action: "none" }],
		});
		const result = validateAudit(raw, spine, allowed);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].rule).toBe("dependency_order");
	});

	test("drops invented rules, sections, and severities", () => {
		const spine = buildSpine(good);
		const raw = JSON.stringify({
			findings: [
				{ rule: "vibes", severity: 2, sections: ["s0"], evidence: "x", action: "none" },
				{ rule: "redundancy", severity: 2, sections: ["s99"], evidence: "y", action: "none" },
				{ rule: "redundancy", severity: 9, sections: ["s0"], evidence: "z", action: "none" },
			],
		});
		const result = validateAudit(raw, spine, allowed);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].sections).toEqual([]);
	});

	test("turns merge and reorder answers into operations", () => {
		const spine = buildSpine(good);
		const [a, b] = spine.sections;
		const raw = JSON.stringify({
			findings: [{ rule: "redundancy", severity: 2, sections: [a.id, b.id], evidence: "same claim", action: "merge" }],
			order: [...spine.sections.map((section) => section.id)].reverse(),
		});
		const result = validateAudit(raw, spine, allowed);
		expect(result.ops).toContainEqual({ kind: "merge", from: b.id, into: a.id });
		expect(result.ops.some((op) => op.kind === "reorder")).toBe(true);
	});

	test("ignores an order that changes nothing", () => {
		const spine = buildSpine(good);
		const order = spine.sections.map((section) => section.id);
		const raw = JSON.stringify({ findings: [], order });
		expect(validateAudit(raw, spine, allowed).ops).toEqual([]);
	});

	test("survives a model that answers with prose", () => {
		const spine = buildSpine(good);
		const result = validateAudit("I think the order is fine, but section two is weak.", spine, allowed);
		expect(result.findings).toEqual([]);
		expect(result.ops).toEqual([]);
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
