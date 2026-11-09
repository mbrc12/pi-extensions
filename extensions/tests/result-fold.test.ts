import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const codingAgent = await import(`${piDir}/dist/index.js`);
const tui = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
mock.module("@earendil-works/pi-tui", () => tui);

const { clipLine, foldedResult, resultText } = await import("../shared/result-fold.ts");

const theme = { fg: (_color: string, text: string) => text };
/** Rendered rows, trailing padding removed. */
const plain = (component: any) =>
	(typeof component.render === "function" ? component.render(400) : [String(component.text ?? "")])
		.map((line: string) => line.trimEnd())
		.join("\n");
const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], isError });

describe("result fold", () => {
	test("clipLine flattens whitespace and clips with an ellipsis", () => {
		expect(clipLine("a\n\n b\tc")).toBe("a b c");
		expect(clipLine("x".repeat(50), 20)).toHaveLength(20);
		expect(clipLine("x".repeat(50), 20).endsWith("…")).toBe(true);
	});

	test("resultText joins text parts and drops trailing whitespace", () => {
		expect(resultText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two\n" }] })).toBe("one\ntwo");
		expect(resultText(undefined)).toBe("");
	});

	test("collapsed marks a failure and hides the tail", () => {
		const line = plain(foldedResult(text(`${"boom ".repeat(60)}tail`, true), theme));
		expect(line.startsWith("✗ ")).toBe(true);
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("to expand");
		expect(line).not.toContain("tail");
	});

	test("expanded shows every line with no hint", () => {
		const line = plain(foldedResult(text(`first line\n${"boom ".repeat(60)}tail`), theme, { expanded: true }));
		expect(line).toContain("first line");
		expect(line).toContain("tail");
		expect(line.split("\n").length).toBeGreaterThan(1);
		expect(line).not.toContain("to expand");
	});

	test("a short result needs no expand hint", () => {
		expect(plain(foldedResult(text("too short", true), theme))).toBe("✗ too short");
		expect(plain(foldedResult(text("plain reply"), theme))).toBe("→ plain reply");
	});

	test("empty content still renders a row", () => {
		expect(plain(foldedResult(text(""), theme))).toBe("—");
		expect(plain(foldedResult(text("", true), theme))).toBe("✗ failed");
	});
});
