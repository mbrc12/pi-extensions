import { describe, expect, mock, test } from "bun:test";

// Pi resolves these packages when it loads extensions. Mock them for a standalone Bun test.
mock.module("@earendil-works/pi-coding-agent", () => ({}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: class Box {
		children: any[] = [];
		constructor(_pad: number, _margin: number, _background: unknown) {}
		addChild(child: unknown) {
			this.children.push(child);
		}
	},
	Text: class Text {
		constructor(public text: string, public paddingX = 0, public paddingY = 0) {}
	},
}));
const wrap = (value: unknown) => value;
mock.module("typebox", () => ({ Type: { Object: wrap, String: wrap, Optional: wrap, Boolean: wrap } }));

const {
	buildFailureNote,
	buildNote,
	buildStatusReport,
	buildUsageAlert,
	default: register,
	describeUsage,
	formatTokens,
	isCancellation,
	shouldAlertUsage,
	AUTO_NOTIFY_PERCENT,
} = await import("../self_compact.ts");

function harness(options: { active?: string[]; registered?: string[]; usage?: { tokens: number | null; contextWindow: number; percent: number | null } } = {}) {
	const tools = new Map<string, any>();
	const renderers = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: any[] = [];
	const compactions: any[] = [];
	let active = options.active ?? [];
	let usage = options.usage;
	const registered = options.registered ?? ["self_compact"];
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (name: string, render: any) => renderers.set(name, render),
		on: (event: string, handler: any) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		getActiveTools: () => [...active],
		getAllTools: () => registered.map((name) => ({ name })),
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
	};
	const ctx: any = { compact: (options: any) => compactions.push(options), getContextUsage: () => usage };
	register(pi);
	return {
		tools,
		renderers,
		handlers,
		sent,
		compactions,
		ctx,
		setUsage: (value: typeof usage) => {
			usage = value;
		},
		getActive: () => [...active],
	};
}

describe("self_compact tool", () => {
	test("registers one tool and a message renderer", () => {
		const h = harness();
		expect([...h.tools.keys()]).toEqual(["self_compact"]);
		expect([...h.renderers.keys()]).toEqual(["self_compact"]);
		const box = h.renderers.get("self_compact")({ content: "keep going" }, { outputPad: 0 }, { bold: (t: string) => t, fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t });
		expect(box.children[0].text).toContain("self_compact note");
		expect(box.children[0].text).toContain("keep going");
	});

	test("returns a scheduling result and stores the note", async () => {
		const h = harness();
		const result = await h.tools.get("self_compact").execute("call", { message: "finish the parser" });
		expect(result.content[0].text).toContain("scheduled");
		expect(result.details.status).toBe("scheduled");
	});

	test("compacts at turn end and delivers the note on completion", async () => {
		const h = harness();
		await h.tools.get("self_compact").execute("call", { message: "finish the parser", instructions: "keep the failing test" });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(1);
		expect(h.compactions[0].customInstructions).toBe("keep the failing test");
		expect(h.sent).toHaveLength(0);
		h.compactions[0].onComplete({});
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].options).toEqual({ triggerTurn: true });
		expect(h.sent[0].message.customType).toBe("self_compact");
		expect(h.sent[0].message.content).toContain("finish the parser");
		expect(h.sent[0].message.content).toContain("context_recall");
		expect(h.sent[0].message.details.status).toBe("compacted");
	});

	test("does nothing without a pending request or after a user interrupt", async () => {
		const h = harness();
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
		await h.tools.get("self_compact").execute("call", { message: "note" });
		h.handlers.get("turn_end")({ outcome: "aborted" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
	});

	test("merges a second request before the turn ends", async () => {
		const h = harness();
		await h.tools.get("self_compact").execute("call", { message: "first" });
		await h.tools.get("self_compact").execute("call", { message: "second" });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		h.compactions[0].onComplete({});
		expect(h.sent[0].message.content).toContain("first");
		expect(h.sent[0].message.content).toContain("second");
	});

	test("skips the note when the user cancels, but reports other failures", async () => {
		const cancelled = harness();
		await cancelled.tools.get("self_compact").execute("call", { message: "note" });
		cancelled.handlers.get("turn_end")({ outcome: "completed" }, cancelled.ctx);
		cancelled.compactions[0].onError(new Error("Compaction cancelled"));
		expect(cancelled.sent).toHaveLength(0);

		const failed = harness();
		await failed.tools.get("self_compact").execute("call", { message: "note" });
		failed.handlers.get("turn_end")({ outcome: "completed" }, failed.ctx);
		failed.compactions[0].onError(new Error("Nothing to compact (session too small)"));
		expect(failed.sent[0].message.details.status).toBe("skipped");
		expect(failed.sent[0].message.content).toContain("Nothing to compact");
		expect(failed.sent[0].message.content).toContain("note");
	});

	test("clears a pending request on session start", async () => {
		const h = harness();
		await h.tools.get("self_compact").execute("call", { message: "stale" });
		h.handlers.get("session_start")({}, h.ctx);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
	});

	test("re-activates the tool when a resumed session's transcript omits it", () => {
		const h = harness({ active: ["read", "bash"] });
		h.handlers.get("before_agent_start")({}, h.ctx);
		expect(h.getActive()).toEqual(["read", "bash", "self_compact"]);
	});

	test("leaves the loadout alone when the tool is active or filtered out", () => {
		const already = harness({ active: ["self_compact"] });
		already.handlers.get("before_agent_start")({}, already.ctx);
		expect(already.getActive()).toEqual(["self_compact"]);

		// `getAllTools()` omits tools disabled by CLI flags, so do not force those back on.
		const disabled = harness({ active: ["read"], registered: ["read"] });
		disabled.handlers.get("before_agent_start")({}, disabled.ctx);
		expect(disabled.getActive()).toEqual(["read"]);
	});

	test("reports context usage for a status call without scheduling compaction", async () => {
		const h = harness({ usage: { tokens: 184_000, contextWindow: 200_000, percent: 92 } });
		const result = await h.tools.get("self_compact").execute("call", { status: true }, undefined, undefined, h.ctx);
		expect(result.details.status).toBe("status");
		expect(result.content[0].text).toContain("92% of 200k tokens (184k used)");
		expect(result.content[0].text).toContain("nearly full");
		expect(result.details.usage.percent).toBe(92);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
	});

	test("status reports an unknown usage and an already scheduled compaction", async () => {
		const h = harness();
		await h.tools.get("self_compact").execute("call", { message: "note" });
		const result = await h.tools.get("self_compact").execute("call", { status: true }, undefined, undefined, h.ctx);
		expect(result.content[0].text).toContain("unknown");
		expect(result.content[0].text).toContain("already scheduled");
	});

	test("rejects a call with neither a message nor status", async () => {
		const h = harness();
		const result = await h.tools.get("self_compact").execute("call", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("status: true");
	});

	test("alerts the model once when usage crosses the threshold", () => {
		const h = harness({ usage: { tokens: 190_000, contextWindow: 200_000, percent: 95 } });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].options).toEqual({ triggerTurn: true });
		expect(h.sent[0].message.details.status).toBe("alert");
		expect(h.sent[0].message.content).toContain("95% of 200k tokens");
		expect(h.sent[0].message.content).toContain("self_compact");

		// Still high on the next turn: stay quiet, because the alert is outstanding.
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(1);

		// Usage drops after a compaction, which re-arms the alert.
		h.setUsage({ tokens: 40_000, contextWindow: 200_000, percent: 20 });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(1);
		h.setUsage({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(2);
	});

	test("does not alert below the threshold, on an interrupt, or when usage is unknown", () => {
		const low = harness({ usage: { tokens: 100_000, contextWindow: 200_000, percent: 50 } });
		low.handlers.get("turn_end")({ outcome: "completed" }, low.ctx);
		expect(low.sent).toHaveLength(0);

		const interrupted = harness({ usage: { tokens: 190_000, contextWindow: 200_000, percent: 95 } });
		interrupted.handlers.get("turn_end")({ outcome: "aborted" }, interrupted.ctx);
		expect(interrupted.sent).toHaveLength(0);

		const unknown = harness({ usage: { tokens: null, contextWindow: 200_000, percent: null } });
		unknown.handlers.get("turn_end")({ outcome: "completed" }, unknown.ctx);
		expect(unknown.sent).toHaveLength(0);
	});

	test("does not alert while a self-compaction is already scheduled", async () => {
		const h = harness({ usage: { tokens: 190_000, contextWindow: 200_000, percent: 95 } });
		await h.tools.get("self_compact").execute("call", { message: "note" });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(1);
		expect(h.sent).toHaveLength(0);
	});

	test("re-arms the alert on session start", () => {
		const h = harness({ usage: { tokens: 190_000, contextWindow: 200_000, percent: 95 } });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(1);
		h.handlers.get("session_start")({}, h.ctx);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.sent).toHaveLength(2);
	});

	test("renders the alert heading in the warning colour", () => {
		const h = harness();
		const theme = { bold: (text: string) => text, fg: (color: string, text: string) => `${color}:${text}`, bg: (_c: string, text: string) => text };
		const box = h.renderers.get("self_compact")({ content: "body", details: { status: "alert" } }, { outputPad: 0 }, theme);
		expect(box.children[0].text).toContain("warning:context nearly full");
	});
});

describe("self_compact helpers", () => {
	test("builds the delivered and failure notes", () => {
		const request = { id: "1", message: "next: run the tests" };
		expect(buildNote(request)).toContain("next: run the tests");
		expect(buildNote(request)).toContain("Self-compaction complete");
		expect(buildFailureNote(request, "no model")).toContain("no model");
		expect(buildFailureNote(request, "no model")).toContain("next: run the tests");
	});

	test("recognises cancellation wording", () => {
		expect(isCancellation("Compaction cancelled")).toBe(true);
		expect(isCancellation("Compaction aborted")).toBe(true);
		expect(isCancellation("Nothing to compact (session too small)")).toBe(false);
	});
});

describe("self_compact usage helpers", () => {
	test("formats token counts for display", () => {
		expect(formatTokens(400)).toBe("400");
		expect(formatTokens(184_000)).toBe("184k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
	});

	test("describes known and unknown usage", () => {
		expect(describeUsage({ tokens: 184_000, contextWindow: 200_000, percent: 92 })).toBe("92% of 200k tokens (184k used)");
		expect(describeUsage({ tokens: null, contextWindow: 200_000, percent: null })).toContain("unknown");
		expect(describeUsage(undefined)).toContain("unknown");
	});

	test("alerts only at or above the threshold and only once per episode", () => {
		expect(AUTO_NOTIFY_PERCENT).toBe(90);
		const high = { tokens: 190_000, contextWindow: 200_000, percent: AUTO_NOTIFY_PERCENT };
		const low = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
		expect(shouldAlertUsage(high, false)).toBe(true);
		expect(shouldAlertUsage(high, true)).toBe(false);
		expect(shouldAlertUsage(low, false)).toBe(false);
		expect(shouldAlertUsage(undefined, false)).toBe(false);
	});

	test("builds a status report and an alert body", () => {
		const usage = { tokens: 184_000, contextWindow: 200_000, percent: 92 };
		expect(buildStatusReport(usage, false)).toContain("Context usage: 92% of 200k tokens (184k used)");
		expect(buildStatusReport(usage, true)).toContain("already scheduled");
		expect(buildUsageAlert(usage)).toContain("nearly full");
		expect(buildUsageAlert(usage)).toContain("status: true");
	});
});
