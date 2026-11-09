import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const codingAgent = await import(`${piDir}/dist/index.js`);
const tui = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
const ai = await import(`${piDir}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const typebox = await import(requireFromPi.resolve("typebox"));
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
mock.module("@earendil-works/pi-tui", () => tui);
mock.module("@earendil-works/pi-ai", () => ai);
mock.module("typebox", () => typebox);

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const tool = (() => {
	const tools = new Map<string, any>();
	const { default: register } = require("../tools/ask-question.ts");
	register({ registerTool: (registered: any) => tools.set(registered.name, registered) } as any);
	return () => tools.get("ask_question");
})();

const longQuestion = `Which database should the new service use? ${"detail ".repeat(30)}end-of-question`;
const args = {
	question: longQuestion,
	selection_mode: "single",
	options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "DuckDB" }],
};

const plain = (component: any) => typeof component.render === "function" ? component.render(400).join("\n") : String(component.text ?? "");

describe("ask_question call row", () => {
	test("collapsed shows a short preview and the option count only", () => {
		const text = plain(tool().renderCall(args, theme, { expanded: false }));
		expect(text).toContain("ask_question");
		expect(text).toContain("Which database should the new service use?");
		expect(text).toContain("3 options (Ctrl+O to expand)");
		expect(text).not.toContain("end-of-question");
		expect(text).not.toContain("Postgres");
	});

	test("expanded shows the whole question and every option", () => {
		const text = plain(tool().renderCall(args, theme, { expanded: true }));
		expect(text).toContain("end-of-question");
		expect(text).toContain("1. Postgres");
		expect(text).toContain("3. DuckDB");
	});
});

describe("ask_question failed result", () => {
	// pi sends `details: {}` for a validation error and nothing at all for a
	// thrown one. Reading `answers` unguarded would throw and lose the fold.
	const failure = (error: string, details?: unknown) => ({ content: [{ type: "text", text: error }], details, isError: true });

	test("collapsed keeps the error on one row", () => {
		const error = `ask_question failed: ${"reason ".repeat(40)}tail-of-error`;
		const text = plain(tool().renderResult(failure(error), { expanded: false }, theme, {}));
		expect(text).toContain("✗");
		expect(text).toContain("ask_question failed");
		expect(text.split("\n")).toHaveLength(1);
		expect(text).toContain("to expand");
		expect(text).not.toContain("tail-of-error");
	});

	test("expanded shows the whole error", () => {
		const error = `ask_question failed: ${"reason ".repeat(40)}tail-of-error`;
		const text = plain(tool().renderResult(failure(error), { expanded: true }, theme, {}));
		expect(text).toContain("tail-of-error");
	});

	test("an empty details object folds instead of throwing", () => {
		const error = `Validation failed for tool "ask_question": ${"detail ".repeat(30)}tail-of-error`;
		const collapsed = plain(tool().renderResult(failure(error, {}), { expanded: false }, theme, {}));
		expect(collapsed).toContain("✗");
		expect(collapsed).toContain("Validation failed");
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).not.toContain("tail-of-error");
		expect(plain(tool().renderResult(failure(error, {}), { expanded: true }, theme, {}))).toContain("tail-of-error");
	});
});
