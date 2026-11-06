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
	const component = tools.get(tool).renderResult(result, { expanded, isPartial: false }, theme, { args });
	// Another test file may have replaced the Text component with a stub that has no render().
	return typeof component.render === "function" ? component.render(200).join("\n") : String(component.text ?? "");
}

const textResult = (text: string) => ({ content: [{ type: "text", text }], details: {} });

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

	test("find, grep, and ls report what the expanded view cut", () => {
		const lines = Array.from({ length: 25 }, (_unused, index) => `/tmp/file-${index}.ts`).join("\n");
		expect(render("find", textResult(lines), true)).toContain("… 15 more lines");
		expect(render("grep", textResult(lines), true)).toContain("… 15 more lines");
		expect(render("ls", textResult(lines), true)).toContain("… 10 more lines");
		expect(render("grep", textResult(lines), false)).not.toContain("file-0");
	});
});
