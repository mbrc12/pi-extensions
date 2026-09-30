import { describe, expect, mock, test } from "bun:test";

const execute = mock(async () => ({
	content: [{ type: "text", text: "Found the answer." }],
	usage: { cost: { total: 0.25 } },
	isError: false,
}));
mock.module("../subagent/index.ts", () => ({ createSubagentTool: () => ({ execute }) }));
mock.module("@earendil-works/pi-coding-agent", () => ({
	getMarkdownTheme: () => ({}), keyHint: (_action: string, label: string) => `Ctrl+O ${label}`,
}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class Container { children: any[] = []; addChild(child: unknown) { this.children.push(child); } },
	Box: class Box { children: any[] = []; constructor(_pad: number, _margin: number, _background: unknown) {} addChild(child: unknown) { this.children.push(child); } },
	Markdown: class Markdown { constructor(public text: string) {} },
	Spacer: class Spacer {},
	Text: class Text { constructor(public text: string) {} },
	Key: { escape: "escape" },
	matchesKey: (input: string, key: string) => input === key,
}));
mock.module("../subagent/agents.ts", () => ({
	discoverAgents: () => ({ agents: [{ name: "scout", source: "user", filePath: "/tmp/scout.md" }], projectAgentsDir: null }),
}));
const wrap = (value: unknown) => value;
mock.module("typebox", () => ({ Type: {
	Object: wrap, String: wrap, Optional: wrap, Boolean: wrap, Union: wrap, Literal: wrap,
} }));
const { default: register } = await import("../background-subagent/index.ts");

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
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (name: string, render: any) => renderers.set(name, render),
		registerCommand: (name: string, options: any) => commands.set(name, options),
		on: (event: string, handler: any) => handlers.set(event, handler),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
	};
	const ctx: any = { cwd: "/tmp", model: { id: "test" }, hasUI: false,
		ui: { theme: { fg: (_color: string, text: string) => text }, notify: (text: string) => notifications.push(text), setStatus: (key: string, value?: string) => {
			if (value) statuses.set(key, value);
			else statuses.delete(key);
		} },
		sessionManager: { getEntries: () => entries } };
	register(pi);
	return { tools, renderers, commands, handlers, entries, sent, statuses, notifications, ctx };
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
		expect(status.content[0].text).toContain("Finished read: Found relevant code");
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
