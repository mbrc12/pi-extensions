import { describe, expect, test } from "bun:test";
import { createNotificationGate, SELF_COMPACT_NOTICE_PENDING, SELF_COMPACT_NOTICE_SENT } from "../shared/notification-gate.ts";
import { testEventBus } from "./event-bus.ts";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function harness() {
	const handlers = new Map<string, any>();
	let idle = true;
	let flushed = 0;
	const ctx: any = { isIdle: () => idle };
	const events = testEventBus();
	const gate = createNotificationGate({ events, on: (name: string, handler: any) => handlers.set(name, handler) } as any, () => flushed++);
	gate.reset(ctx);
	return { gate, handlers, events, ctx, setIdle: (value: boolean) => { idle = value; }, count: () => flushed };
}

describe("completion notification gate", () => {
	test("delivers immediately when idle", () => {
		const h = harness();
		h.gate.request();
		expect(h.count()).toBe(1);
		h.gate.dispose();
	});

	for (const terminal of ["session_compact", "session_compact_failed"]) {
		test(`holds delivery through ${terminal} until Pi clears its controller`, async () => {
			const h = harness();
			try {
				h.setIdle(false);
				h.handlers.get("session_before_compact")({}, h.ctx);
				h.gate.request();
				h.gate.request();
				expect(h.count()).toBe(0);
				h.handlers.get(terminal)({}, h.ctx);
				await tick();
				expect(h.count()).toBe(0);
				h.setIdle(true);
				await tick(120);
				expect(h.count()).toBe(1);
			} finally { h.gate.dispose(); }
		});
	}

	test("checks idle even before the before-compact hook runs", async () => {
		const h = harness();
		try {
			h.setIdle(false);
			h.gate.request();
			await tick(120);
			expect(h.count()).toBe(0);
			h.setIdle(true);
			await tick(120);
			expect(h.count()).toBe(1);
		} finally { h.gate.dispose(); }
	});

	test("waits for the self_compact notice even when Pi is already idle", async () => {
		const h = harness();
		try {
			h.events.emit(SELF_COMPACT_NOTICE_PENDING, { id: "note" });
			h.handlers.get("session_before_compact")({}, h.ctx);
			h.gate.request();
			h.handlers.get("session_compact")({}, h.ctx);
			await tick(120);
			expect(h.count()).toBe(0);
			h.events.emit(SELF_COMPACT_NOTICE_SENT, { id: "note" });
			expect(h.count()).toBe(0);
			await tick();
			expect(h.count()).toBe(1);
		} finally { h.gate.dispose(); }
	});

	test("a new compaction blocks a scheduled release", async () => {
		const h = harness();
		try {
			h.handlers.get("session_before_compact")({}, h.ctx);
			h.gate.request();
			h.handlers.get("session_compact")({}, h.ctx);
			h.handlers.get("session_before_compact")({}, h.ctx);
			await tick(120);
			expect(h.count()).toBe(0);
			h.handlers.get("session_compact_failed")({ aborted: true }, h.ctx);
			await tick();
			expect(h.count()).toBe(1);
		} finally { h.gate.dispose(); }
	});

	for (const action of ["dispose", "reset"] as const) {
		test(`${action} cancels delivery from the old session`, async () => {
			const h = harness();
			h.setIdle(false);
			h.gate.request();
			if (action === "reset") h.gate.reset(h.ctx);
			else h.gate.dispose();
			h.setIdle(true);
			await tick(120);
			expect(h.count()).toBe(0);
			h.gate.dispose();
		});
	}
});
