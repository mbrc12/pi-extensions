import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-test-"));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => agentDir }));

const {
	agentSessionName,
	windowName,
	decideOwnership,
	shellQuote,
	viewerScriptPath,
	TmuxWorkspace,
	setWorkspace,
	getWorkspace,
	providePi,
	ensureWorkspace,
} =
	await import("../agents/shared/tmux-session.ts");

/**
 * Minimal tmux stand-in: enough state to prove that opening twice is a no-op,
 * that panes appear per registered agent, and that closing kills the session.
 */
function fakeTmux() {
	const sessions = new Map<string, { owner?: string; windows: string[]; options: Map<string, string> }>();
	const calls: string[][] = [];
	const bare = (target: string) => target.replace(/^=/, "").replace(/:.*$/, "");
	const windowOf = (target: string) => target.split(":").slice(1).join(":");
	const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
	const fail = (stderr = "no such session") => ({ code: 1, stdout: "", stderr });

	const exec = mock(async (command: string, args: string[]) => {
		calls.push([command, ...args]);
		if (command !== "tmux") return command === "sh" ? ok("/usr/local/bin/node\n") : fail();
		const [verb, ...rest] = args;
		const targetFlag = rest.indexOf("-t");
		const target = targetFlag >= 0 ? rest[targetFlag + 1] : "";
		const session = sessions.get(bare(target));
		switch (verb) {
			case "-V":
				return ok("tmux 3.8\n");
			case "has-session":
				return session ? ok() : fail();
			case "new-session": {
				const nameIndex = rest.indexOf("-s");
				const name = rest[nameIndex + 1];
				sessions.set(name, { windows: ["zsh"], options: new Map() });
				return ok();
			}
			case "display-message": {
				if (!session) return fail();
				const format = rest[rest.length - 1];
				if (format === "#{@pi_owner}") return ok(`${session.options.get("@pi_owner") ?? ""}\n`);
				return ok(`${session.options.get("@pi_session") ?? ""}\n`);
			}
			case "set-option": {
				if (!session) return fail();
				if (rest.includes("-w")) {
					const win = windowOf(target);
					if (!session.windows.includes(win)) return fail();
					const key = rest[rest.length - 2];
					session.options.set(`${win}:${key}`, rest[rest.length - 1]);
					return ok();
				}
				const key = rest[rest.length - 2];
				session.options.set(key, rest[rest.length - 1]);
				return ok();
			}
			case "list-windows":
				if (!session) return fail();
				return ok(`${session.windows.join("\n")}\n`);
			case "new-window": {
				if (!session) return fail();
				const nameIndex = rest.indexOf("-n");
				const name = rest[nameIndex + 1];
				session.windows.push(name);
				return ok();
			}
			case "kill-window": {
				if (!session) return fail();
				const win = windowOf(target);
				session.windows = session.windows.filter((name) => name !== win);
				return ok();
			}
			case "kill-session":
				if (!session) return fail();
				sessions.delete(bare(target));
				return ok();
			default:
				return fail(`unsupported: ${verb}`);
		}
	});

	const pi = { exec } as any;
	return { pi, sessions, calls, exec };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tmux workspace names", () => {
	test("session name is prefixed and safe for tmux", () => {
		expect(agentSessionName("01j9xk2m-abcd.efgh")).toBe("pi-01j9xk2m");
		expect(agentSessionName("café/naïve session")).toBe("pi-cafnaves");
		expect(agentSessionName("")).toBe("pi-session");
	});

	test("window name keeps a readable stem and a short id", () => {
		expect(windowName("data explorer", "subagent-abcdef")).toBe("data-explorer-cdef");
		expect(windowName("scout", "operator-1234")).toBe("scout-1234");
		expect(windowName("", "")).toBe("agent-0000");
	});

	test("ownership separates our session from a stale and a foreign one", () => {
		expect(decideOwnership(42, 42, () => true)).toBe("ours");
		expect(decideOwnership(41, 42, () => true)).toBe("foreign");
		expect(decideOwnership(41, 42, () => false)).toBe("stale");
		expect(decideOwnership(undefined, 42, () => true)).toBe("stale");
	});
});

describe("viewer command quoting", () => {
	test("quotes values for the single shell string tmux runs", () => {
		expect(shellQuote("/tmp/a b.jsonl")).toBe("'/tmp/a b.jsonl'");
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	test("the viewer script ships beside the module", () => {
		expect(fs.existsSync(viewerScriptPath())).toBe(true);
	});
});

describe("tmux workspace lifecycle", () => {
	test("open creates one session and one pane per registered agent", async () => {
		const { pi, sessions } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-one", "/tmp/work");
		workspace.register({ key: "subagent-aaaa1", title: "scout", sessionFile: "/tmp/a.jsonl" });
		workspace.register({ key: "subagent-bbbb2", title: "worker", sessionFile: "/tmp/b.jsonl" });

		const result = await workspace.open();
		expect(result.created).toBe(true);
		expect(sessions.has(workspace.name)).toBe(true);
		expect(sessions.get(workspace.name)!.windows).toEqual(["zsh", "scout-aaa1", "worker-bbb2"]);
		expect(workspace.isEnabled).toBe(true);
		await workspace.close();
	});

	test("open is idempotent and picks up agents registered while closed", async () => {
		const { pi, sessions, calls } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-two", "/tmp/work");
		await workspace.open();
		workspace.register({ key: "subagent-cccc3", title: "reviewer", sessionFile: "/tmp/c.jsonl" });
		await tick();
		const before = calls.filter((call) => call[1] === "new-session").length;

		const result = await workspace.open();
		expect(result.created).toBe(false);
		expect(calls.filter((call) => call[1] === "new-session").length).toBe(before);
		expect(sessions.get(workspace.name)!.windows).toContain("reviewer-ccc3");
		await workspace.close();
	});

	test("later agents get a pane while the workspace is open", async () => {
		const { pi, sessions } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-three", "/tmp/work");
		await workspace.open();
		workspace.register({ key: "op-0001", title: "planner", sessionFile: "/tmp/planner.jsonl" });
		await tick();
		expect(sessions.get(workspace.name)!.windows).toContain("planner-0001");
		workspace.unregister("op-0001");
		await tick();
		expect(sessions.get(workspace.name)!.windows).not.toContain("planner-0001");
		await workspace.close();
	});

	test("a transcript allocated while closed still gets a pane when the workspace opens", async () => {
		const { pi, sessions } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-four", "/tmp/work");
		// The agent starts before anyone asks for panes.
		const transcript = workspace.openTranscript("subagent", "scout")!;
		expect(transcript.args).toEqual(["--session", transcript.sessionFile]);
		expect(path.dirname(transcript.sessionFile)).toBe(workspace.transcriptDir("subagent"));
		expect(fs.existsSync(workspace.transcriptDir("subagent"))).toBe(true);

		await workspace.open();
		expect(sessions.get(workspace.name)!.windows).toContain("scout-" + transcript.key.slice(-4));
		transcript.finish();
		await workspace.close();
	});

	test("close leaves a session owned by another live pi process alone", async () => {
		const { pi, sessions } = fakeTmux();
		const first = new TmuxWorkspace(pi, "session-five", "/tmp/work");
		await first.open();
		sessions.get(first.name)!.options.set("@pi_owner", "1"); // pid 1 is alive and is not us

		const second = new TmuxWorkspace(pi, "session-five", "/tmp/work");
		await expect(second.open()).rejects.toThrow(/belongs to another pi process/);
		const result = await second.close();
		expect(result.closed).toBe(false);
		expect(sessions.has(first.name)).toBe(true);
		sessions.delete(first.name);
	});

	test("a session left behind by a dead owner is replaced on open", async () => {
		const { pi, sessions, calls } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-six", "/tmp/work");
		await workspace.open();
		// Simulate a crashed run: the owner pid is gone.
		sessions.get(workspace.name)!.options.set("@pi_owner", "999999");
		calls.length = 0;

		const result = await workspace.open();
		expect(result.created).toBe(true);
		expect(calls.some((call) => call[1] === "kill-session")).toBe(true);
		expect(calls.some((call) => call[1] === "new-session")).toBe(true);
		await workspace.close();
	});

	test("ensureWorkspace binds itself when no session event ran", () => {
		setWorkspace(undefined);
		const { pi } = fakeTmux();
		// Without an extension API there is nothing to bind, so agents stay headless.
		expect(ensureWorkspace({ sessionManager: { getSessionId: () => "late-bind" } })).toBeUndefined();

		providePi(pi);
		const workspace = ensureWorkspace({ cwd: "/tmp/work", sessionManager: { getSessionId: () => "late-bind" } })!;
		expect(workspace.name).toBe(agentSessionName("late-bind"));
		expect(workspace.isEnabled).toBe(false);
		// The same instance is reused, so receivers share one registry.
		expect(ensureWorkspace({ cwd: "/elsewhere" })).toBe(workspace);
		setWorkspace(undefined);
	});

	test("the workspace slot is shared through the global object", () => {
		const { pi } = fakeTmux();
		const workspace = new TmuxWorkspace(pi, "session-seven", "/tmp/work");
		setWorkspace(workspace);
		expect(getWorkspace()).toBe(workspace);
		setWorkspace(undefined);
		expect(getWorkspace()).toBeUndefined();
	});
});

describe("/tmux-session command", () => {
	async function harness() {
		const { pi, sessions, calls } = fakeTmux();
		const commands = new Map<string, any>();
		const handlers = new Map<string, any[]>();
		const statuses = new Map<string, string | undefined>();
		const notices: Array<{ message: string; type?: string }> = [];
		(pi as any).registerCommand = (name: string, options: any) => commands.set(name, options);
		(pi as any).on = (event: string, handler: any) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		};
		const ctx = {
			cwd: "/tmp/work",
			sessionManager: { getSessionId: () => "cmd-session" },
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, type }),
				setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			},
		};
		const { default: registerTmux } = await import("../agents/tmux/index.ts");
		registerTmux(pi);
		setWorkspace(undefined);
		const run = (args: string) => commands.get("tmux-session").handler(args, ctx);
		return { pi, sessions, calls, commands, handlers, statuses, notices, ctx, run };
	}

	test("registers the command with completions", async () => {
		const { commands } = await harness();
		const command = commands.get("tmux-session");
		expect(command).toBeDefined();
		expect(command.description).toContain("tmux");
		expect(command.getArgumentCompletions("o").map((item: any) => item.value)).toEqual(["on", "off"]);
	});

	test("on opens idempotently and off closes", async () => {
		const { run, sessions, statuses, notices } = await harness();

		await run("on");
		expect(statuses.get("tmux-session")).toBe("pi-cmd-sess");
		expect(sessions.has("pi-cmd-sess")).toBe(true);

		await run("on");
		expect(notices.at(-1)!.message).toContain("Reusing");

		await run("off");
		expect(sessions.has("pi-cmd-sess")).toBe(false);
		expect(statuses.get("tmux-session")).toBeUndefined();

		await run("off");
		expect(notices.at(-1)!.message).toContain("nothing to close");
	});

	test("an unknown argument is rejected without touching tmux", async () => {
		const { run, notices, calls } = await harness();
		await run("sideways");
		expect(notices.at(-1)!.message).toContain("Unknown argument");
		expect(calls.some((call) => call[1] === "new-session")).toBe(false);
	});

	test("shutdown closes a workspace this session opened", async () => {
		const { run, handlers, sessions, ctx } = await harness();
		await run("on");
		expect(sessions.has("pi-cmd-sess")).toBe(true);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		expect(sessions.has("pi-cmd-sess")).toBe(false);
	});
});
