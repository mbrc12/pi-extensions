import { describe, expect, mock, test } from "bun:test";
import { testEventBus } from "./event-bus.ts";

mock.module("@earendil-works/pi-coding-agent", () => ({}));
mock.module("@earendil-works/pi-tui", () => ({
	Container: class Container { addChild() {} clear() {} },
	Box: class Box { addChild() {} },
	Spacer: class Spacer {},
	Text: class Text {},
	Key: { escape: "escape" },
	matchesKey: () => false,
}));
const wrap = (value: unknown) => value;
mock.module("typebox", () => ({ Type: {
	Object: wrap, String: wrap, Optional: wrap, Boolean: wrap, Number: wrap,
} }));
const { default: register } = await import("../task-backgrounder/index.ts");
const { default: registerSelfCompact } = await import("../self_compact.ts");
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
	const handlers = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const sent: any[] = [];
	let idle = true;
	const ctx: any = {
		cwd: "/tmp", hasUI: false, model: { id: "test" }, isIdle: () => idle,
		ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {} },
		sessionManager: { getEntries: () => entries },
	};
	const pi: any = {
		events: testEventBus(),
		on: (event: string, handler: any) => {
			const previous = handlers.get(event);
			handlers.set(event, previous ? (...args: any[]) => { previous(...args); return handler(...args); } : handler);
		},
		registerMessageRenderer() {},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: any, options: any) => {
			sent.push({ message, options });
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
		exec: mock(() => { throw new Error("These tests must not run tmux"); }),
	};
	register(pi);
	return { pi, handlers, tools, entries, sent, ctx, setIdle: (value: boolean) => { idle = value; } };
}

function addCompletedTask(h: ReturnType<typeof harness>, taskId = "saved") {
	h.entries.push({ type: "custom", customType: "task-backgrounder-state", data: {
		action: "start", task: {
			taskId, name: taskId, command: "true", cwd: "/tmp", status: "exited",
			logFile: `/tmp/pi-notification-test-${taskId}.log`, exitFile: `/tmp/pi-notification-test-${taskId}.exit`,
			terminalOutcome: "succeeded", terminalExitCode: 0,
		},
	} });
}

describe("task completion notifications", () => {
	for (const terminal of ["session_compact", "session_compact_failed"]) {
		test(`task_status queues both messages until ${terminal} and cleanup finish`, async () => {
			const h = harness();
			addCompletedTask(h);
			h.setIdle(false);
			h.handlers.get("session_start")({}, h.ctx);
			try {
				h.handlers.get("session_before_compact")({}, h.ctx);
				const result = await h.tools.get("task_status").execute("id", { name: "saved" }, undefined, undefined, h.ctx);
				expect(result.details.status).toBe("exited");
				await tick(240);
				expect(h.sent).toHaveLength(0);
				expect(h.entries.some((entry) => entry.data?.action === "completion-pending")).toBe(true);
				h.handlers.get(terminal)({ aborted: terminal === "session_compact_failed" }, h.ctx);
				await tick();
				expect(h.sent).toHaveLength(0);
				h.setIdle(true);
				await tick(120);
				expect(h.sent.map((item) => item.message.customType)).toEqual(["task-completion", "task-completion-wake"]);
				expect(h.sent[1].options.triggerTurn).toBe(true);
				h.handlers.get("session_start")({}, h.ctx);
				await tick(240);
				expect(h.sent).toHaveLength(2);
			} finally { h.handlers.get("session_shutdown")({}, h.ctx); }
		});
	}

	test("self_compact notice is first, then a batch of queued task completions", async () => {
		const h = harness();
		registerSelfCompact(h.pi);
		addCompletedTask(h, "first");
		addCompletedTask(h, "second");
		let compaction: any;
		h.ctx.compact = (options: any) => {
			compaction = options;
			h.setIdle(false);
			h.handlers.get("session_before_compact")({}, h.ctx);
		};
		h.handlers.get("session_start")({}, h.ctx);
		try {
			await h.tools.get("self_compact").execute("id", { message: "First notice" }, undefined, undefined, h.ctx);
			h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
			for (const name of ["first", "second"]) {
				await h.tools.get("task_status").execute("id", { name }, undefined, undefined, h.ctx);
			}
			await tick(240);
			expect(h.sent).toHaveLength(0);
			h.handlers.get("session_compact")({}, h.ctx);
			h.setIdle(true);
			await tick(120);
			expect(h.sent).toHaveLength(0);
			compaction.onComplete({});
			await tick();
			expect(h.sent.map((item) => item.message.customType)).toEqual(["self_compact", "task-completion", "task-completion-wake"]);
			expect(h.sent[1].message.details.completions.map((item: any) => item.name)).toEqual(["first", "second"]);
		} finally { h.handlers.get("session_shutdown")({}, h.ctx); }
	});

	test("restores a pending notification after shutdown without duplicating it", async () => {
		const h = harness();
		addCompletedTask(h);
		h.setIdle(false);
		h.handlers.get("session_start")({}, h.ctx);
		h.handlers.get("session_before_compact")({}, h.ctx);
		await h.tools.get("task_status").execute("id", { name: "saved" }, undefined, undefined, h.ctx);
		await tick(240);
		expect(h.sent).toHaveLength(0);
		h.handlers.get("session_shutdown")({}, h.ctx);
		h.setIdle(true);
		h.handlers.get("session_start")({}, h.ctx);
		try {
			await tick(240);
			expect(h.sent).toHaveLength(2);
			h.handlers.get("session_start")({}, h.ctx);
			await tick(240);
			expect(h.sent).toHaveLength(2);
		} finally { h.handlers.get("session_shutdown")({}, h.ctx); }
	});
});
