import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No module mocks here on purpose: the banner's layout and counting logic imports
// nothing from Pi, so this file stays independent of every other test file.
import {
	applyExtensionPatterns,
	bannerLines,
	contextFilePaths,
	countExtensions,
	displayPath,
	discoverExtensions,
	globMatches,
	ICON_WIDTH,
} from "../tui/banner-data.ts";

const root = mkdtempSync(join(tmpdir(), "banner-test-"));
const agentDir = join(root, "agent");
const extensionsDir = join(agentDir, "extensions");
const projectDir = join(root, "project");

function writeFile(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

const EXTENSION = "export default () => {};\n";
writeFile(join(extensionsDir, "top.ts"), EXTENSION);
writeFile(join(extensionsDir, "second.ts"), EXTENSION);
writeFile(join(extensionsDir, "group", "index.ts"), EXTENSION);
writeFile(join(extensionsDir, "listed", "a.ts"), EXTENSION);
writeFile(join(extensionsDir, "listed", "b.ts"), EXTENSION);
writeFile(
	join(extensionsDir, "listed", "package.json"),
	`${JSON.stringify({ pi: { extensions: ["./a.ts", "./b.ts"] } }, null, 2)}\n`,
);
writeFile(join(projectDir, ".pi", "extensions", "project.ts"), EXTENSION);
writeFile(join(agentDir, "APPEND_SYSTEM.md"), "append\n");
writeFile(join(projectDir, ".pi", "SYSTEM.md"), "system\n");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const theme = {
	fg: (_color: "accent" | "muted" | "dim", text: string) => text,
	bold: (text: string) => text,
};

const data = {
	version: "1.4.0",
	contextFiles: ["~/.pi/agent/AGENTS.md", "AGENTS.md"],
	counts: { skills: 10, extensions: 30, prompts: 3 },
};

/** Plain-text stand-in for Pi's truncateToWidth: the real one handles ANSI. */
const truncate = (text: string, width: number, ellipsis = "…") =>
	text.length <= width ? text : `${text.slice(0, Math.max(0, width - ellipsis.length))}${ellipsis}`;

const render = (
	overrides: Partial<typeof data> = {},
	options: { width?: number; iconTop?: string; iconBottom?: string } = {},
) =>
	bannerLines(
		{ ...data, ...overrides },
		theme,
		options.width ?? 120,
		{
			iconTop: options.iconTop ?? "ICON ",
			iconBottom: options.iconBottom ?? "ICON2",
			truncate,
		},
	);

describe("banner layout", () => {
	test("draws two lines", () => {
		expect(render()).toHaveLength(2);
	});

	test("shows the version, all three counts, and the context files", () => {
		const plain = render().join("\n");
		expect(plain).toContain("v1.4.0");
		expect(plain).toContain("10 skills");
		expect(plain).toContain("30 extensions");
		expect(plain).toContain("3 prompts");
		expect(plain).toContain("context ~/.pi/agent/AGENTS.md · AGENTS.md");
	});

	test("does not repeat the product name beside the icon", () => {
		expect(render().join("\n")).not.toContain("pi v1.4.0");
	});

	test("truncates instead of overflowing a narrow terminal", () => {
		for (const line of render({}, { width: 16 })) {
			expect(line.length).toBeLessThanOrEqual(16);
			expect(line).toContain("…");
		}
	});

	test("says so when no context file was loaded", () => {
		expect(render({ contextFiles: [] }).join("\n")).toContain("no context files");
	});

	test("uses singular nouns for single items", () => {
		const plain = render({ counts: { skills: 1, extensions: 1, prompts: 1 } }).join("\n");
		expect(plain).toContain("1 skill ");
		expect(plain).toContain("1 extension ");
		expect(plain).toContain("1 prompt");
		expect(plain).not.toContain("1 skills");
	});

	test("keeps both text columns aligned to the icon width", () => {
		const [first, second] = render({ contextFiles: ["A"] }, { iconTop: "X".repeat(ICON_WIDTH), iconBottom: "Y".repeat(ICON_WIDTH) });
		expect(first!.indexOf("v1.4.0")).toBe(ICON_WIDTH + 2);
		expect(second!.indexOf("context")).toBe(ICON_WIDTH + 2);
	});
});

describe("extension discovery", () => {
	test("finds scripts, index entries, and package manifests", () => {
		const found = discoverExtensions(extensionsDir).map((path) => displayPath(path, { cwd: extensionsDir }));
		expect(found.sort()).toEqual(["group/index.ts", "listed/a.ts", "listed/b.ts", "second.ts", "top.ts"]);
	});

	test("missing directories yield nothing", () => {
		expect(discoverExtensions(join(agentDir, "nope"))).toEqual([]);
	});

	test("counts agent extensions and, when trusted, project extensions", () => {
		const base = { agentDir, cwd: projectDir, patterns: [], configDirName: ".pi" };
		expect(countExtensions({ ...base, projectTrusted: false })).toBe(5);
		expect(countExtensions({ ...base, projectTrusted: true })).toBe(6);
	});

	test("applies exclusions from settings.json", () => {
		const discovered = discoverExtensions(extensionsDir);
		const excluded = applyExtensionPatterns(discovered, ["!extensions/second.ts"], agentDir);
		expect(excluded).toHaveLength(4);
		expect(excluded.map((path) => displayPath(path, { cwd: extensionsDir }))).not.toContain("second.ts");
	});

	test("force-includes and force-excludes beat ordinary patterns", () => {
		const discovered = discoverExtensions(extensionsDir);
		const kept = applyExtensionPatterns(
			discovered,
			["!extensions/second.ts", "+extensions/second.ts", "-extensions/top.ts", "extensions/group"],
			agentDir,
		);
		const relative = kept.map((path) => displayPath(path, { cwd: extensionsDir })).sort();
		expect(relative).toContain("second.ts");
		expect(relative).toContain("group/index.ts");
		expect(relative).not.toContain("top.ts");
	});
});

describe("path matching", () => {
	test("matches plain names, relative paths, and globs", () => {
		expect(globMatches("quiz.ts", "quiz.ts")).toBe(true);
		expect(globMatches("extensions/tools/quiz.ts", "extensions/tools/quiz.ts")).toBe(true);
		expect(globMatches("extensions/tools/quiz.ts", "extensions/tools/*.ts")).toBe(true);
		expect(globMatches("extensions/tools/quiz.ts", "extensions/**/quiz.ts")).toBe(true);
		expect(globMatches("extensions/tools/quiz.ts", "extensions/tools/recap.ts")).toBe(false);
		expect(globMatches("extensions/tools/deep/quiz.ts", "extensions/*/quiz.ts")).toBe(false);
	});

	test("shortens home and cwd paths for display", () => {
		const home = process.env.HOME ?? "";
		if (home) expect(displayPath(join(home, "AGENTS.md"))).toBe("~/AGENTS.md");
		expect(displayPath(join(projectDir, "AGENTS.md"), { cwd: projectDir })).toBe("AGENTS.md");
		expect(displayPath("/elsewhere/AGENTS.md")).toBe("/elsewhere/AGENTS.md");
	});
});

describe("context files", () => {
	const agentsFiles = [join(agentDir, "AGENTS.md")];

	test("lists the append-system file, then the agent files", () => {
		const paths = contextFilePaths({ agentDir, cwd: projectDir, configDirName: ".pi", projectTrusted: false, agentsFiles });
		expect(paths).toEqual([join(agentDir, "APPEND_SYSTEM.md"), join(agentDir, "AGENTS.md")]);
	});

	test("prefers a trusted project system prompt over the agent one", () => {
		const paths = contextFilePaths({ agentDir, cwd: projectDir, configDirName: ".pi", projectTrusted: true, agentsFiles });
		expect(paths[0]).toBe(join(projectDir, ".pi", "SYSTEM.md"));
		expect(paths).toContain(join(agentDir, "APPEND_SYSTEM.md"));
	});

	test("ignores an untrusted project system prompt", () => {
		const paths = contextFilePaths({ agentDir, cwd: projectDir, configDirName: ".pi", projectTrusted: false, agentsFiles });
		expect(paths).not.toContain(join(projectDir, ".pi", "SYSTEM.md"));
	});
});
