import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	NOTIFY_ENV,
	notificationsDisabled,
	quietChildEnvironment,
} from "../shared/notification-policy.ts";
import notifyOnIdle, { notify, type NotifySink, shouldNotifyRun } from "../session/notify-on-idle.ts";

function fakeSink() {
	const calls: string[] = [];
	const sink: NotifySink = {
		bell: () => calls.push("bell"),
		tmux: () => calls.push("tmux"),
		windows: () => calls.push("windows"),
		osc77: () => calls.push("osc77"),
		osc99: () => calls.push("osc99"),
	};
	return { sink, calls };
}

/** One environment per terminal branch of notify(). */
const TERMINALS: Array<{ name: string; env: NodeJS.ProcessEnv; route: string }> = [
	{ name: "plain terminal", env: {}, route: "osc77" },
	{ name: "tmux", env: { TMUX: "/tmp/tmux-501/default,1,0", TMUX_PANE: "%3" }, route: "tmux" },
	{ name: "windows terminal", env: { WT_SESSION: "abc" }, route: "windows" },
	{ name: "kitty", env: { KITTY_WINDOW_ID: "1" }, route: "osc99" },
];

describe("run gating", () => {
	test("notifies only when your own prompt settled without an abort", () => {
		expect(shouldNotifyRun("user", false)).toBe(true);
		expect(shouldNotifyRun("user", true)).toBe(false);
		expect(shouldNotifyRun("custom", false)).toBe(false);
		expect(shouldNotifyRun("custom", true)).toBe(false);
		expect(shouldNotifyRun(undefined, false)).toBe(false);
	});

	test("compaction recovers under the same rule, so a retry adds no banner", () => {
		// Custom-message runs cover subagent results, task results, the
		// self_compact note, and the context alert.
		expect(shouldNotifyRun("custom", false)).toBe(false);
	});
});

describe("child notification policy", () => {
	test("only the exact off marker disables notifications", () => {
		expect(notificationsDisabled({ [NOTIFY_ENV]: "off" })).toBe(true);
		expect(notificationsDisabled({})).toBe(false);
		expect(notificationsDisabled({ [NOTIFY_ENV]: "1" })).toBe(false);
		expect(notificationsDisabled({ [NOTIFY_ENV]: "on" })).toBe(false);
		expect(notificationsDisabled({ [NOTIFY_ENV]: "OFF" })).toBe(false);
	});

	test("child environments keep the parent environment and add the marker", () => {
		const parent = { TMUX: "/tmp/tmux-501/default,1,0", HOME: "/Users/x" };
		const child = quietChildEnvironment(parent);
		expect(child).toEqual({ ...parent, [NOTIFY_ENV]: "off" });
		expect(parent).toEqual({ TMUX: "/tmp/tmux-501/default,1,0", HOME: "/Users/x" });
	});

	test("the marker survives another generation", () => {
		expect(notificationsDisabled(quietChildEnvironment(quietChildEnvironment({})))).toBe(true);
	});
});

describe("extension wiring", () => {
	test("listens on the final boundary only", () => {
		const registered: string[] = [];
		const pi = {
			on: (name: string) => {
				registered.push(name);
				return () => {};
			},
			events: { on: () => () => {}, emit: () => {} },
		};
		notifyOnIdle(pi as never);
		expect(registered).toEqual(["session_start", "before_agent_start", "agent_settled"]);
	});
});

describe("notify", () => {
	test("a quiet child posts nothing on any terminal", () => {
		for (const terminal of TERMINALS) {
			const { sink, calls } = fakeSink();
			notify("Pi", "Ready for input", { ...terminal.env, [NOTIFY_ENV]: "off" }, sink);
			expect({ terminal: terminal.name, calls }).toEqual({ terminal: terminal.name, calls: [] });
		}
	});

	test("the parent rings and picks the terminal's notification", () => {
		for (const terminal of TERMINALS) {
			const { sink, calls } = fakeSink();
			notify("Pi", "Ready for input", { ...terminal.env }, sink);
			expect({ terminal: terminal.name, calls }).toEqual({
				terminal: terminal.name,
				calls: ["bell", terminal.route],
			});
		}
	});

	for (const [name, file] of [
		["subagent", "../agents/subagent/index.ts"],
		["multiagent", "../agents/multiagent/index.ts"],
	] as const) {
		test(`${name} spawns child Pi with notifications off`, () => {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source).toContain("quietChildEnvironment(");
		});
	}
});
