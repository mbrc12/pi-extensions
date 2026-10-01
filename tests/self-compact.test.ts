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
mock.module("typebox", () => ({ Type: { Object: wrap, String: wrap, Optional: wrap } }));

const { buildFailureNote, buildNote, default: register, isCancellation } = await import("../self-compact.ts");

function harness() {
	const tools = new Map<string, any>();
	const renderers = new Map<string, any>();
	const handlers = new Map<string, any>();
	const sent: any[] = [];
	const compactions: any[] = [];
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerMessageRenderer: (name: string, render: any) => renderers.set(name, render),
		on: (event: string, handler: any) => handlers.set(event, handler),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	};
	const ctx: any = { compact: (options: any) => compactions.push(options) };
	register(pi);
	return { tools, renderers, handlers, sent, compactions, ctx };
}

describe("self-compact tool", () => {
	test("registers one tool and a message renderer", () => {
		const h = harness();
		expect([...h.tools.keys()]).toEqual(["self-compact"]);
		expect([...h.renderers.keys()]).toEqual(["self-compact"]);
		const box = h.renderers.get("self-compact")({ content: "keep going" }, { outputPad: 0 }, { bold: (t: string) => t, fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t });
		expect(box.children[0].text).toContain("self-compact note");
		expect(box.children[0].text).toContain("keep going");
	});

	test("returns a scheduling result and stores the note", async () => {
		const h = harness();
		const result = await h.tools.get("self-compact").execute("call", { message: "finish the parser" });
		expect(result.content[0].text).toContain("scheduled");
		expect(result.details.status).toBe("scheduled");
	});

	test("compacts at turn end and delivers the note on completion", async () => {
		const h = harness();
		await h.tools.get("self-compact").execute("call", { message: "finish the parser", instructions: "keep the failing test" });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(1);
		expect(h.compactions[0].customInstructions).toBe("keep the failing test");
		expect(h.sent).toHaveLength(0);
		h.compactions[0].onComplete({});
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0].options).toEqual({ triggerTurn: true });
		expect(h.sent[0].message.customType).toBe("self-compact");
		expect(h.sent[0].message.content).toContain("finish the parser");
		expect(h.sent[0].message.content).toContain("context_recall");
		expect(h.sent[0].message.details.status).toBe("compacted");
	});

	test("does nothing without a pending request or after a user interrupt", async () => {
		const h = harness();
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
		await h.tools.get("self-compact").execute("call", { message: "note" });
		h.handlers.get("turn_end")({ outcome: "aborted" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
	});

	test("merges a second request before the turn ends", async () => {
		const h = harness();
		await h.tools.get("self-compact").execute("call", { message: "first" });
		await h.tools.get("self-compact").execute("call", { message: "second" });
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		h.compactions[0].onComplete({});
		expect(h.sent[0].message.content).toContain("first");
		expect(h.sent[0].message.content).toContain("second");
	});

	test("skips the note when the user cancels, but reports other failures", async () => {
		const cancelled = harness();
		await cancelled.tools.get("self-compact").execute("call", { message: "note" });
		cancelled.handlers.get("turn_end")({ outcome: "completed" }, cancelled.ctx);
		cancelled.compactions[0].onError(new Error("Compaction cancelled"));
		expect(cancelled.sent).toHaveLength(0);

		const failed = harness();
		await failed.tools.get("self-compact").execute("call", { message: "note" });
		failed.handlers.get("turn_end")({ outcome: "completed" }, failed.ctx);
		failed.compactions[0].onError(new Error("Nothing to compact (session too small)"));
		expect(failed.sent[0].message.details.status).toBe("skipped");
		expect(failed.sent[0].message.content).toContain("Nothing to compact");
		expect(failed.sent[0].message.content).toContain("note");
	});

	test("clears a pending request on session start", async () => {
		const h = harness();
		await h.tools.get("self-compact").execute("call", { message: "stale" });
		h.handlers.get("session_start")({}, h.ctx);
		h.handlers.get("turn_end")({ outcome: "completed" }, h.ctx);
		expect(h.compactions).toHaveLength(0);
	});
});

describe("self-compact helpers", () => {
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
