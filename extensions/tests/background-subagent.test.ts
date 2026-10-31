import { describe, expect, mock, test } from "bun:test";
import { testEventBus } from "./event-bus.ts";

const execute = mock(async () => ({
	content: [{ type: "text", text: "Found the answer." }],
	usage: { cost: { total: 0.25 } },
	isError: false,
}));
mock.module("../agents/subagent/index.ts", () => ({ createSubagentTool: () => ({ execute }) }));
mock.module("@earendil-works/pi-coding-agent", () => ({
	getMarkdownTheme: () => ({}), keyHint: (_action: string, label: string) => `Ctrl+O ${label}`,
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class Container { children: any[] = []; addChild(child: unknown) { this.children.push(child); } clear() { this.children = []; } },
	Box: class Box { children: any[] = []; constructor(_pad: number, _margin: number, _background: unknown) {} addChild(child: unknown) { this.children.push(child); } },
	ScrollView: class ScrollView { constructor(_child: unknown, _options?: unknown) {} getContentWidth(width: number) { return width; } },
	Markdown: class Markdown { constructor(public text: string) {} },
	Spacer: class Spacer {},
	Text: class Text { constructor(public text: string) {} },
	Key: { escape: "escape", ctrl: (key: string) => `ctrl-${key}` },
	matchesKey: (input: string, key: string) => input === key,
}));
mock.module("../agents/subagent/agents.ts", () => ({
	discoverAgents: () => ({ agents: [{ name: "scout", source: "user", filePath: "/tmp/scout.md" }], projectAgentsDir: null }),
}));
const wrap = (value: unknown) => value;
mock.module("typebox", () => ({ Type: {
	Object: wrap, String: wrap, Optional: wrap, Boolean: wrap, Union: wrap, Literal: wrap,
} }));
const { default: register } = await import("../agents/background-subagent/index.ts");
const { default: registerSelfCompact } = await import("../tools/self_compact.ts");

function harness() {
	const tools = new Map<string, any>();
	const renderers = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const entries: any[] = [];
	const sent: any[] = [];
	const statuses = new Map<string, string>();
	const notifications: string[] = [];
	const pi: any = {
		events: testEventBus(),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (name: string, render: any) => renderers.set(name, render),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (event: string, handler: any) => {
			const previous = handlers.get(event);
			handlers.set(event, previous ? (...args: any[]) => { previous(...args); return handler(...args); } : handler);
		},
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
	};
	const ctx: any = { cwd: "/tmp", model: { id: "test" }, hasUI: false, isIdle: () => true,
		ui: { theme: { fg: (_color: string, text: string) => text }, notify: (text: string) => notifications.push(text), setStatus: (key: string, value?: string) => {
			if (value) statuses.set(key, value);
			else statuses.delete(key);
		} },
		sessionManager: { getEntries: () => entries } };
	register(pi);
	return { pi, tools, renderers, commands, handlers, entries, sent, statuses, notifications, ctx };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("background subagents", () => {
	test("starts without waiting and injects one persisted answer and wake", async () => {
		let resolve!: (result: any) => void;
		execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const h = harness();
		h.handlers.get("session_start")(undefined, h.ctx);
		const started = await h.tools.get("background_subagent").execute("id", { agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
		const name = started.details.name;
		expect((await h.tools.get("background_subagent_status").execute("id", { name })).details.job.status).toBe("running");
		expect(h.sent).toHaveLength(0);
		resolve({ content: [{ type: "text", text: "Answer" }], isError: false, usage: { cost: { total: 0.25 } } });
		await tick();
		expect(h.sent.map((item) => item.message.customType)).toEqual(["background-subagent-completion", "background-subagent-wake"]);
		expect(h.sent[0].message.content).toContain("Answer");
		expect(h.sent[1].options.triggerTurn).toBe(true);
		const render = h.renderers.get("background-subagent-completion");
		const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
		const collapsed = render(h.sent[0].message, { expanded: false, outputPad: 2 }, theme);
		expect(collapsed.children[0].text).toContain(name);
		expect(collapsed.children[0].text).toContain("Ctrl+O to expand");
		expect(JSON.stringify(collapsed)).not.toContain("Answer");
		const expanded = render(h.sent[0].message, { expanded: true, outputPad: 2 }, theme);
		expect(expanded.children.at(-1).text).toBe("Answer");
		expect((await h.tools.get("background_subagent_status").execute("id", { name })).details.job.cost).toBe(0.25);
		expect(h.statuses.has("background-subagent")).toBe(false);
		h.handlers.get("session_start")(undefined, h.ctx);
		expect(h.sent).toHaveLength(2);
	});

	for (const terminal of ["session_compact", "session_compact_failed"]) {
		test(`persists completion but holds both messages through ${terminal}`, async () => {
			let resolve!: (result: any) => void;
			execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
			const h = harness();
			let idle = true;
			h.ctx.isIdle = () => idle;
			h.handlers.get("session_start")(undefined, h.ctx);
			await h.tools.get("background_subagent").execute("id", { name: "deferred", agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
			idle = false;
			h.handlers.get("session_before_compact")({}, h.ctx);
			resolve({ content: [{ type: "text", text: "Saved answer" }], isError: false });
			await tick();
			expect(h.sent).toHaveLength(0);
			expect(h.entries.some((entry) => entry.data?.action === "finish" && entry.data.job.output === "Saved answer")).toBe(true);
			h.handlers.get(terminal)({ aborted: terminal === "session_compact_failed" }, h.ctx);
			await tick();
			expect(h.sent).toHaveLength(0);
			idle = true;
			await new Promise((done) => setTimeout(done, 120));
			expect(h.sent.map((item) => item.message.customType)).toEqual(["background-subagent-completion", "background-subagent-wake"]);
			h.handlers.get("session_start")(undefined, h.ctx);
			expect(h.sent).toHaveLength(2);
			h.handlers.get("session_shutdown")();
		});
	}

	for (const outcome of ["success", "failure", "cancelled"]) {
		test(`self_compact notice precedes multiple queued completions after ${outcome}`, async () => {
			const resolvers: Array<(result: any) => void> = [];
			execute.mockImplementationOnce(() => new Promise((done) => { resolvers.push(done); }));
			execute.mockImplementationOnce(() => new Promise((done) => { resolvers.push(done); }));
			const h = harness();
			registerSelfCompact(h.pi);
			let idle = true;
			let compaction: any;
			h.ctx.isIdle = () => idle;
			h.ctx.compact = (options: any) => {
				compaction = options;
				idle = false;
				h.handlers.get("session_before_compact")({}, h.ctx);
			};
			h.handlers.get("session_start")({}, h.ctx);
			for (const name of ["first", "second"]) {
				await h.tools.get("background_subagent").execute("id", { name, agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
			}
			await h.tools.get("self_compact").execute("id", { message: "Keep this note first" }, undefined, undefined, h.ctx);
			h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
			resolvers.forEach((resolve) => resolve({ content: [{ type: "text", text: "Queued answer" }], isError: false }));
			await tick();
			expect(h.sent).toHaveLength(0);
			h.handlers.get(outcome === "success" ? "session_compact" : "session_compact_failed")({}, h.ctx);
			// Simulate Pi becoming idle before invoking self_compact's callback.
			idle = true;
			await new Promise((done) => setTimeout(done, 120));
			expect(h.sent).toHaveLength(0);
			if (outcome === "success") compaction.onComplete({});
			else compaction.onError(new Error(outcome === "cancelled" ? "Compaction cancelled" : "Provider failed"));
			await tick();
			const types = h.sent.map((item) => item.message.customType);
			const completions = ["background-subagent-completion", "background-subagent-wake", "background-subagent-completion", "background-subagent-wake"];
			expect(types).toEqual(outcome === "cancelled" ? completions : ["self_compact", ...completions]);
			if (outcome !== "cancelled") expect(h.sent[0].message.content).toContain("Keep this note first");
			h.handlers.get("session_shutdown")({}, h.ctx);
		});
	}

	test("restores a completion held during compaction after shutdown", async () => {
		const h = harness();
		h.handlers.get("session_start")(undefined, h.ctx);
		h.ctx.isIdle = () => false;
		h.handlers.get("session_before_compact")({}, h.ctx);
		await h.tools.get("background_subagent").execute("id", { name: "saved", agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
		await tick();
		expect(h.sent).toHaveLength(0);
		h.handlers.get("session_shutdown")();
		h.ctx.isIdle = () => true;
		h.handlers.get("session_start")(undefined, h.ctx);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[0].message.content).toContain("Found the answer");
		h.handlers.get("session_shutdown")();
	});

	test("restored unfinished jobs are reported as interrupted", async () => {
		const h = harness();
		h.entries.push({ type: "custom", customType: "background-subagent-state", data: {
			action: "start", job: { id: "old", name: "stale", agent: "scout", status: "running", startedAt: 1 },
		} });
		h.handlers.get("session_start")(undefined, h.ctx);
		expect((await h.tools.get("background_subagent_status").execute("id", { name: "stale" })).details.job.status).toBe("interrupted");
		expect(h.sent[0].message.content).toContain("interrupted");
		expect(h.statuses.has("background-subagent")).toBe(false);
	});

	test("stopping prevents a late answer from replacing the stop notification", async () => {
		let resolve!: (result: any) => void;
		execute.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const h = harness();
		h.handlers.get("session_start")(undefined, h.ctx);
		const started = await h.tools.get("background_subagent").execute("id", { agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
		await h.tools.get("background_subagent_stop").execute("id", { name: started.details.name });
		resolve({ content: [{ type: "text", text: "Too late" }] });
		await tick();
		expect(h.sent).toHaveLength(2);
		expect(h.sent[0].message.content).not.toContain("Too late");
		expect(h.statuses.has("background-subagent")).toBe(false);
	});

	test("keeps tool calls and tool results compact even when expanded", async () => {
		let update!: (result: any) => void;
		let resolve!: (result: any) => void;
		execute.mockImplementationOnce((_id: any, _params: any, _signal: any, onUpdate: any) => {
			update = onUpdate;
			return new Promise((done) => { resolve = done; });
		});
		const h = harness(); h.handlers.get("session_start")(undefined, h.ctx);
		const started = await h.tools.get("background_subagent").execute("id", { name: "compact", agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
		const path = "x".repeat(250);
		update({ details: { results: [{ usage: { turns: 1, cost: 0 }, messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] }, { role: "toolResult", toolName: "read", content: [{ type: "text", text: path }] }] }] } });
		const result = await h.tools.get("background_subagent_status").execute("id", { name: started.details.name });
		const render = h.tools.get("background_subagent_status").renderResult;
		const theme = { fg: (_color: string, text: string) => text };
		const compact = render(result, { expanded: false }, theme).children.map((item: any) => item.text).join("\n");
		const expanded = render(result, { expanded: true }, theme).children.map((item: any) => item.text).join("\n");
		expect(compact).toContain("[tool] read: path = "); expect(compact).toContain("…"); expect(compact).not.toContain(path);
		expect(expanded).toContain("[tool] read result: ");
		expect(expanded).not.toContain(`[tool] read result: ${path}`);
		expect(expanded).not.toContain(`[tool] read: path = "${path}"`);
		resolve({ content: [{ type: "text", text: "Done" }] }); await tick(); h.handlers.get("session_shutdown")();
	});

	test("lists running jobs first, then most recent, with elapsed time", async () => {
		const pending: Array<(result: any) => void> = [];
		execute.mockImplementation(() => new Promise((done) => { pending.push(done); }));
		const h = harness(); h.handlers.get("session_start")(undefined, h.ctx);
		const start = h.tools.get("background_subagent").execute;
		await start("a", { name: "oldest-running", agent: "scout", task: "One" }, undefined, undefined, h.ctx);
		await new Promise((done) => setTimeout(done, 5));
		await start("b", { name: "recent-finished", agent: "scout", task: "Two" }, undefined, undefined, h.ctx);
		pending[1]({ content: [{ type: "text", text: "done" }], isError: false }); await tick();
		await new Promise((done) => setTimeout(done, 5));
		await start("c", { name: "newest-finished", agent: "scout", task: "Three" }, undefined, undefined, h.ctx);
		pending[2]({ content: [{ type: "text", text: "done" }], isError: false }); await tick();

		let captured: string[] = [];
		h.ctx.ui.select = async (_title: string, options: string[]) => { captured = options; return undefined; };
		await h.commands.get("background-subagent-status").handler("", h.ctx);
		expect(captured.map((row) => row.split(" (")[0])).toEqual(["oldest-running", "newest-finished", "recent-finished"]);
		expect(captured[0]).toMatch(/· running · \d+s$/);
		expect(captured[1]).toMatch(/· succeeded · \d+s$/);

		const listed = await h.tools.get("background_subagent_status").execute("id", {});
		expect(listed.details.jobs.map((job: any) => job.name)).toEqual(["oldest-running", "newest-finished", "recent-finished"]);
		pending[0]({ content: [{ type: "text", text: "late" }], isError: false }); await tick();
		h.handlers.get("session_shutdown")();
	});

	test("shows live tool activity and a third-line footer indicator without injecting progress", async () => {
		let update!: (result: any) => void;
		let resolve!: (result: any) => void;
		execute.mockImplementationOnce((_id: any, _params: any, _signal: any, onUpdate: any) => {
			update = onUpdate;
			return new Promise((done) => { resolve = done; });
		});
		const h = harness();
		h.handlers.get("session_start")(undefined, h.ctx);
		const started = await h.tools.get("background_subagent").execute("id", { agent: "scout", task: "Explore" }, undefined, undefined, h.ctx);
		const name = started.details.name;
		expect(h.statuses.get("background-subagent")).toContain("sub 1 ·");
		update({ details: { results: [{ requestedModel: "opencode-go/test", usage: { turns: 2, cost: 0.03 }, messages: [
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "private thought" },
				{ type: "toolCall", name: "read", arguments: { path: "example.ts" } },
			] },
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "Found relevant code" }] },
			{ role: "assistant", content: [{ type: "text", text: "Investigating the parser" }] },
		] }] } });
		const status = await h.tools.get("background_subagent_status").execute("id", { name });
		expect(status.content[0].text).toContain("[tool] read result: Found relevant code");
		expect(status.content[0].text).toContain("Investigating the parser");
		expect(status.content[0].text).toContain("Turns: 2 · Cost: $0.0300");
		expect(status.content[0].text).not.toContain("private thought");
		expect(h.sent).toHaveLength(0);
		const list = await h.tools.get("background_subagent_status").execute("id", {});
		expect(list.content[0].text).toContain(name);
		resolve({ content: [{ type: "text", text: "Done" }], isError: false, usage: { cost: { total: 0.04 } } });
		await tick();
		expect(h.statuses.has("background-subagent")).toBe(false);
	});

	test("slash status chooses a job and the indicator counts concurrent runs", async () => {
		const pending: Array<(result: any) => void> = [];
		execute.mockImplementationOnce(() => new Promise((done) => { pending.push(done); }));
		execute.mockImplementationOnce(() => new Promise((done) => { pending.push(done); }));
		const h = harness();
		h.handlers.get("session_start")(undefined, h.ctx);
		const start = h.tools.get("background_subagent").execute;
		await start("a", { name: "first", agent: "scout", task: "One" }, undefined, undefined, h.ctx);
		await start("b", { name: "second", agent: "scout", task: "Two" }, undefined, undefined, h.ctx);
		expect(h.statuses.get("background-subagent")).toContain("sub 2 ·");
		h.ctx.ui.select = async () => "second (scout): running";
		await h.commands.get("background-subagent-status").handler("", h.ctx);
		expect(h.notifications.at(-1)).toContain("second (scout): running");
		pending[0]({ content: [{ type: "text", text: "One done" }], isError: false });
		await tick();
		expect(h.statuses.get("background-subagent")).toContain("sub 1 ·");
		pending[1]({ content: [{ type: "text", text: "Two done" }], isError: false });
		await tick();
		expect(h.statuses.has("background-subagent")).toBe(false);
	});
});
