import { describe, expect, mock, test } from "bun:test";

const tui = await import("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js");
mock.module("@earendil-works/pi-tui", () => tui);
mock.module("@earendil-works/pi-coding-agent", () => ({ keyHint: (_key: string, description: string) => `Ctrl-O ${description}` }));
const { default: register } = await import("../tui/codemode-compact.ts");

const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function harness(native?: any) {
	let resolver: any;
	register({ registerToolRenderer: (value: any) => { resolver = value; } } as any);
	const renderer = resolver("codemode", () => native);
	const context: any = {
		args: { code: "SECRET_JAVASCRIPT();" }, toolCallId: "test", state: {}, cwd: "/work",
		expanded: false, executionStarted: true, isError: false, durationMs: undefined,
	};
	function render(calls: any[], options: { error?: boolean; partial?: boolean; output?: string; fullOutputPath?: string; width?: number } = {}) {
		context.isError = options.error || false;
		const call = renderer.renderCall(context.args, theme, context);
		const result = renderer.renderResult({
			content: options.partial ? [] : [
				{ type: "text", text: `Script ${options.error ? "failed" : "completed"}\nWall time 0.8 seconds\nOutput:\n` },
				{ type: "text", text: options.output || "SECRET_RESULT_DUMP" },
			],
			details: { calls, fullOutputPath: options.fullOutputPath },
		}, { expanded: false, isPartial: options.partial || false }, theme, context);
		return { call, result, lines: [...call.render(options.width ?? 80), ...result.render(options.width ?? 80)] };
	}
	return { resolver, renderer, context, render };
}
const call = (name: string, args: unknown, status = "ok", extras = {}) => ({ name, args: JSON.stringify(args), status, durationMs: 20, ...extras });

describe("compact codemode presentation", () => {
	test("only changes codemode rendering", () => {
		const native = { renderCall: mock(() => new tui.Text("native")) };
		const h = harness(native);
		expect(h.resolver("read", () => native)).toBe(native);
		expect(h.renderer.execute).toBeUndefined();
	});

	test("shows the call list, status, and time, but no JavaScript or result dump", () => {
		const h = harness();
		const { lines } = h.render([
			call("read", { path: "/work/src/config.ts" }),
			call("grep", { pattern: "registerTool", path: "/work/src" }),
			call("bash", { command: "bun test" }),
		]);
		expect(lines[0]).toBe("codemode · 3 calls · done · 800ms");
		expect(lines.join("\n")).toContain("✓ read src/config.ts");
		expect(lines.join("\n")).toContain("“registerTool” · src");
		expect(lines.join("\n")).toContain("bun test");
		expect(lines.join("\n")).not.toContain("SECRET_");
		expect(lines).toHaveLength(4);
	});

	test("hides source while arguments stream and reports preparing versus running", () => {
		const h = harness();
		h.context.executionStarted = false;
		const component = h.renderer.renderCall(h.context.args, theme, h.context);
		expect(component.render(80)).toEqual(["codemode · preparing"]);
		h.context.executionStarted = true;
		expect(component.render(80)).toEqual(["codemode · running"]);
	});

	test("updates live status without claiming a running call is done", () => {
		const h = harness();
		const running = h.render([call("read", { path: "a.ts" }, "running", { durationMs: undefined })], { partial: true });
		expect(running.lines[0]).toContain("running");
		expect(running.lines[1]).toContain("… read a.ts");
		expect(running.lines.join("\n")).not.toContain("done");
		const complete = h.render([call("read", { path: "a.ts" })]);
		expect(complete.lines[0]).toContain("done");
		expect(complete.lines[1]).toContain("✓ read a.ts");
	});

	test("keeps an earlier failure and running call visible in a bounded list", () => {
		const h = harness();
		const calls = [call("early_failure", { path: "old.ts" }, "error", { error: "Permission denied" }), call("pending", {}, "running")];
		for (let index = 0; index < 12; index++) calls.push(call(`read_${index}`, { path: `${index}.ts` }));
		const { lines } = h.render(calls, { partial: true });
		expect(lines).toHaveLength(8);
		expect(lines[1]).toContain("early_failure");
		expect(lines[1]).toContain("Permission denied");
		expect(lines[2]).toContain("pending");
		expect(lines.at(-1)).toContain("8 more calls");
		expect(lines.at(-1)).toContain("Ctrl-O");
	});

	test("counts failures that cannot all fit in the call list", () => {
		const h = harness();
		const { lines } = h.render(Array.from({ length: 10 }, (_, index) => call(`failed_${index}`, {}, "error", { error: "Blocked" })));
		expect(lines[0]).toContain("10 failed calls");
		expect(lines.at(-1)).toContain("4 more calls (4 failed)");
	});

	test("shows a short script error, not successful partial output or a stack dump", () => {
		const h = harness();
		const { lines } = h.render([], { error: true, output: "SECRET_RESULT_DUMP\nScript error:\nReferenceError: item is not defined\n    at <eval>:1" });
		expect(lines[0]).toContain("failed");
		expect(lines[1]).toBe("  Error: ReferenceError: item is not defined");
		expect(lines.join("\n")).not.toContain("SECRET");
		expect(lines.join("\n")).not.toContain("at <eval>");
	});

	test("shows validation errors that precede script execution", () => {
		const h = harness();
		h.context.isError = true;
		const component = h.renderer.renderResult({ content: [{ type: "text", text: "Invalid timeout_ms\nExtra detail" }] }, { expanded: false, isPartial: false }, theme, h.context);
		expect(component.render(80)).toEqual(["  Error: Invalid timeout_ms"]);
	});

	test("shows model cost, cancellation, and a full-output path without dumping content", () => {
		const h = harness();
		const { lines } = h.render([
			{ name: "models.classify", args: "provider/model", status: "ok", cost: 0.003 },
			call("read", { path: "/work/file.ts" }, "cancelled"),
		], { fullOutputPath: "/work/full-output.txt" });
		expect(lines[0]).toContain("$0.0030");
		expect(lines[1]).toContain("provider/model");
		expect(lines[2]).toContain("⊘ read");
		expect(lines.at(-1)).toBe("  Full output: full-output.txt");
	});

	test("recovers a path from truncated JSON while hiding content and scripts", () => {
		const h = harness();
		const { lines } = h.render([
			{ name: "write", args: '{"path":"/work/result.txt","content":"SECRET_UNFINISHED', status: "ok" },
			call("py_explore", { code: "SECRET_PYTHON" }),
		]);
		expect(lines[1]).toContain("result.txt");
		expect(lines.join("\n")).not.toContain("SECRET");
	});

	test("truncated argument recovery ignores nested fields and quoted content", () => {
		const h = harness();
		const previews = [
			'{"content":{"path":"SECRET_PATH","command":"SECRET_COMMAND"},"code":"unfinished',
			'{"items":[{"query":"SECRET_QUERY"}],"code":"unfinished',
			'{"path":"/work/actual.txt","content":{"path":"SECRET_PATH","query":"SECRET_QUERY"},"code":"unfinished',
			'{"content":"{\\"query\\":\\"SECRET_QUERY\\"}, embedded text","code":"unfinished',
			'{"content":"unfinished "query":"SECRET_QUERY",',
			'{"content":{"path":"SECRET_PATH"},"path":"/work/actual.txt","code":"unfinished',
		];
		for (const args of previews) {
			const { lines } = h.render([{ name: "write", args, status: "ok" }]);
			expect(lines.join("\n")).not.toContain("SECRET");
			if (args.includes("/work/actual.txt")) expect(lines[1]).toContain("actual.txt");
		}
	});

	test("quoted JSON boundaries do not expose content as an argument", () => {
		const h = harness();
		const payloads = [
			'"path":"SECRET_PATH",',
			'{"query":"SECRET_QUERY"}',
			'\\\\", {"command":"SECRET_COMMAND"},',
			'comma, closing brace }, escaped quote \\"',
		];
		for (const content of payloads) {
			const full = JSON.stringify({ content, nested: [{ path: "SECRET_NESTED" }], code: "unfinished" });
			for (const args of [full, full.slice(0, -2)]) {
				const { lines } = h.render([{ name: "write", args, status: "ok" }]);
				expect(lines.join("\n")).not.toContain("SECRET");
			}
		}
	});

	test("keeps a path readable beside a long pattern, or drops it instead of showing a fragment", () => {
		const h = harness();
		const calls = [call("grep", { pattern: "class PrecisionPlan|def __init__|def control_transaction", path: "/work/rlq27b/remote/" })];
		for (const width of [80, 60, 40, 30, 20]) {
			const row = tui.stripTerminalSequences(h.render(calls, { width }).lines[1]);
			expect(row).not.toMatch(/·\s*…/);
			const parts = row.split(" · ");
			// The duration is the only trailing part; every argument part stays readable.
			for (const part of parts.slice(0, -1)) expect(tui.visibleWidth(part)).toBeGreaterThanOrEqual(6);
		}
		expect(tui.stripTerminalSequences(h.render(calls, { width: 80 }).lines[1])).toContain("rlq27b/remote/");
		expect(tui.stripTerminalSequences(h.render(calls, { width: 40 }).lines[1])).toContain("rlq27b/");
		// With too little room for both, the pattern keeps the row and the path is dropped.
		expect(tui.stripTerminalSequences(h.render(calls, { width: 30 }).lines[1])).not.toContain("rlq27b");
		expect(tui.stripTerminalSequences(h.render(calls, { width: 30 }).lines[1])).toContain("“class Precis…");
	});

	test("fits narrow widths, long commands, Unicode, and terminal control characters", () => {
		const h = harness();
		const calls = [call("read", { path: "/work/文件😀.ts\nINJECTED\u001b[31m" }), call("bash", { command: "x".repeat(1000) }, "error", { error: "Failure\u001b]0;hostile\u0007" })];
		for (const width of [0, 1, 8, 20, 40, 80, 128]) {
			const { lines } = h.render(calls, { width });
			for (const line of lines) {
				expect(tui.visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\u001b[31m");
				expect(line).not.toContain("\u001b]");
				expect(line).not.toContain("\n");
			}
		}
	});

	test("delegates expanded code and results unchanged and handles repeated toggles", () => {
		const native = {
			renderCall: mock((_args: any, _theme: any, context: any) => {
				const box = context.lastComponent ?? new tui.Container();
				box.clear(); box.addChild(new tui.Text("FULL JAVASCRIPT")); return box;
			}),
			renderResult: mock((_result: any, _options: any, _theme: any, context: any) => {
				const box = context.lastComponent ?? new tui.Container();
				box.clear(); box.addChild(new tui.Text("FULL RESULTS")); return box;
			}),
		};
		const h = harness(native);
		for (let count = 0; count < 2; count++) {
			const compact = h.render([]);
			h.context.expanded = true;
			const expandedCall = h.renderer.renderCall(h.context.args, theme, { ...h.context, lastComponent: compact.call });
			const expandedResult = h.renderer.renderResult({ content: [], details: { calls: [] } }, { expanded: true, isPartial: false }, theme, { ...h.context, lastComponent: compact.result });
			expect(expandedCall.render(80).join("\n")).toContain("FULL JAVASCRIPT");
			expect(expandedResult.render(80).join("\n")).toContain("FULL RESULTS");
			h.context.expanded = false;
		}
		expect(native.renderCall).toHaveBeenCalledTimes(2);
		expect(native.renderResult).toHaveBeenCalledTimes(2);
	});

	test("theme changes are applied when components are rebuilt", () => {
		const h = harness();
		const first = h.render([]);
		expect(first.lines[0]).toStartWith("codemode");
		const changed = { ...theme, fg: (color: string, text: string) => color === "toolTitle" ? text.toUpperCase() : text };
		const component = h.renderer.renderCall(h.context.args, changed, h.context);
		expect(component.render(80)[0]).toStartWith("CODEMODE");
	});
});
