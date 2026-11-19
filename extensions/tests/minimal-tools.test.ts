import { beforeAll, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const codingAgent = await import(`${piDir}/dist/index.js`);
const tui = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
const typebox = await import(requireFromPi.resolve("typebox"));
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
mock.module("@earendil-works/pi-tui", () => tui);
mock.module("typebox", () => typebox);

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

let tools: Map<string, any>;
beforeAll(async () => {
	const { default: register } = await import("../tui/minimal-tools.ts");
	tools = new Map();
	register({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
});

/** Render a captured tool result, the way pi calls the renderer. */
function render(tool: string, result: any, expanded: boolean, args: any = {}) {
	const component = tools.get(tool).renderResult(result, { expanded, isPartial: false }, theme, {
		args,
		isError: (result as { isError?: boolean }).isError === true,
	});
	// Another test file may have replaced the Text component with a stub that has no render().
	return typeof component.render === "function" ? component.render(200).join("\n") : String(component.text ?? "");
}

const textResult = (text: string) => ({ content: [{ type: "text", text }], details: {} });

/** A failed call: pi sends the error message as content and sets isError. */
const failedResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text", text }], details, isError: true });

describe("bash contract", () => {
	test("the schema requires timeout and description", () => {
		const bash = tools.get("bash");
		expect(bash.parameters.required).toEqual(["command", "timeout", "description"]);
		expect(bash.parameters.properties.timeout.description).toContain("Required");
		expect(bash.parameters.properties.description.description).toContain("One short sentence");
	});

	test("the tool description states both requirements", () => {
		const description: string = tools.get("bash").description;
		expect(description).toContain("A timeout in seconds and a one-sentence description are required.");
		expect(description).not.toContain("Optionally provide a timeout");
	});

	test("the guidelines ask for a description on every call", () => {
		const guidelines: string[] = tools.get("bash").promptGuidelines ?? [];
		expect(guidelines.some((line) => line.includes("one-sentence description on every bash call"))).toBe(true);
	});

	test("execute refuses a call without a positive timeout", async () => {
		const bash = tools.get("bash");
		await expect(bash.execute("id", { command: "true", description: "x" }, undefined, undefined)).rejects.toThrow("positive timeout");
		await expect(bash.execute("id", { command: "true", timeout: 0, description: "x" }, undefined, undefined)).rejects.toThrow("positive timeout");
	});

	test("execute refuses a call without a description", async () => {
		const bash = tools.get("bash");
		await expect(bash.execute("id", { command: "true", timeout: 5 }, undefined, undefined)).rejects.toThrow("description");
		await expect(bash.execute("id", { command: "true", timeout: 5, description: "   " }, undefined, undefined)).rejects.toThrow("description");
	});
});

describe("minimal tool renderers", () => {
	test("read shows file content only when expanded", () => {
		const file = Array.from({ length: 60 }, (_unused, index) => `line-${index}`).join("\n");
		const collapsed = render("read", textResult(file), false);
		const expanded = render("read", textResult(file), true);
		expect(collapsed).toContain("✓ 60 lines");
		expect(collapsed).not.toContain("line-0");
		expect(expanded).toContain("line-0");
		expect(expanded).toContain("… 20 more lines");
	});

	test("write reveals what it wrote when expanded", () => {
		const written = Array.from({ length: 5 }, (_unused, index) => `write-${index}`).join("\n");
		const collapsed = render("write", textResult("Wrote file"), false, { path: "/tmp/x", content: written });
		const expanded = render("write", textResult("Wrote file"), true, { path: "/tmp/x", content: written });
		expect(collapsed).toContain("✓ written");
		expect(collapsed).not.toContain("write-0");
		expect(expanded).toContain("write-0");
		expect(expanded).toContain("write-4");
	});

	test("bash expanded shows the tail, where failures land", () => {
		const output = Array.from({ length: 30 }, (_unused, index) => `out-${index}`).join("\n");
		const collapsed = render("bash", textResult(output), false);
		const expanded = render("bash", textResult(output), true);
		expect(collapsed).not.toContain("out-29");
		expect(expanded).toContain("out-29");
		expect(expanded).not.toContain("out-0\n");
		expect(expanded).toContain("… 10 earlier lines");
	});

	test("edit expanded keeps context lines and reports the remainder", () => {
		const diff = ["@@ -1,3 +1,3 @@", " keep", "-old", "+new", ...Array.from({ length: 50 }, (_unused, index) => `+extra-${index}`)].join("\n");
		const collapsed = render("edit", { content: [{ type: "text", text: "ok" }], details: { diff } }, false);
		const expanded = render("edit", { content: [{ type: "text", text: "ok" }], details: { diff } }, true);
		expect(collapsed).toContain("+51");
		expect(collapsed).not.toContain(" keep");
		expect(expanded).toContain(" keep");
		expect(expanded).toContain("more diff lines");
	});

	test("a failed read stays on one row until expanded", () => {
		const error = `ENOENT: no such file or directory, open '/tmp/missing' ${"detail ".repeat(30)}tail-of-error`;
		const collapsed = render("read", failedResult(error), false);
		const expanded = render("read", failedResult(error), true);
		expect(collapsed).toContain("✗");
		expect(collapsed).toContain("ENOENT");
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("…");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("tail-of-error");
		expect(expanded).toContain("tail-of-error");
	});

	test("a failing command reports its exit code without dumping output", () => {
		const output = ["out-0", "out-1", "Command exited with code 3"].join("\n");
		const collapsed = render("bash", failedResult(output), false);
		expect(collapsed).toContain("✗ 3");
		expect(collapsed).not.toContain("out-0");
		expect(render("bash", failedResult(output), true)).toContain("out-0");
	});

	test("a timeout without an exit code still reads as a failure", () => {
		const collapsed = render("bash", failedResult("Command timed out after 5 seconds"), false);
		expect(collapsed).toContain("✗");
		expect(collapsed).not.toContain("✓");
	});

	test("failed find, grep, and ls stay folded", () => {
		const error = `Error: ripgrep is not installed ${"hint ".repeat(30)}last-hint`;
		for (const tool of ["find", "grep", "ls"]) {
			const collapsed = render(tool, failedResult(error), false);
			expect(collapsed).toContain("✗");
			expect(collapsed.split("\n")).toHaveLength(1);
			expect(collapsed).not.toContain("last-hint");
			expect(render(tool, failedResult(error), true)).toContain("last-hint");
		}
	});

	test("find, grep, and ls report what the expanded view cut", () => {
		const lines = Array.from({ length: 25 }, (_unused, index) => `/tmp/file-${index}.ts`).join("\n");
		expect(render("find", textResult(lines), true)).toContain("… 15 more lines");
		expect(render("grep", textResult(lines), true)).toContain("… 15 more lines");
		expect(render("ls", textResult(lines), true)).toContain("… 10 more lines");
		expect(render("grep", textResult(lines), false)).not.toContain("file-0");
	});
});

describe("bash call rendering", () => {
	/** Render a call the way pi does: renderCall(args, theme, context). */
	function renderCall(args: any, expanded: boolean) {
		const context = { expanded, executionStarted: false, state: {} as Record<string, unknown> };
		const component = tools.get("bash").renderCall(args, theme, context);
		return typeof component.render === "function" ? component.render(200).join("\n") : String(component.text ?? "");
	}

	test("the description is shown under the command", () => {
		const text = renderCall(
			{ command: "grep -rn policy src", timeout: 30, description: "Find every policy reference before editing" },
			false,
		);
		expect(text).toContain("Find every policy reference before editing");
		expect(text).toContain("grep -rn policy src");
	});

	test("a call without a description still renders the command", () => {
		const text = renderCall({ command: "ls", timeout: 10 }, false);
		expect(text).toContain("ls");
		expect(text.split("\n").length).toBe(1);
	});
});
