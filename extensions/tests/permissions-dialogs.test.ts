import { beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const codingAgent = await import(`${piDir}/dist/index.js`);
const tui = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
const typebox = await import(requireFromPi.resolve("typebox"));
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
mock.module("@earendil-works/pi-tui", () => tui);
mock.module("typebox", () => typebox);

/**
 * Drives the extension's real handlers against a fake pi.
 *
 * Source-level assertions cannot catch a function that references a variable it
 * never received: that only fails when the branch runs, which is after a
 * reload, in front of the user. Nothing here renders: `ui.select` answers on its
 * own and the custom dialogs are never entered.
 */
const workspace = mkdtempSync(join(tmpdir(), "pi-perm-smoke-"));
const agentDir = join(workspace, "agent");

type Handler = (event: unknown, ctx: unknown) => unknown;

let handlers: Map<string, Handler>;
const emitted: Array<{ event: string; payload: unknown }> = [];
const selected: string[][] = [];

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

const pi = {
  on: (name: string, handler: Handler) => handlers.set(name, handler),
  events: {
    on: () => {},
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
  },
  registerCommand: () => {},
  registerShortcut: () => {},
  registerTool: () => {},
  appendEntry: () => {},
  getActiveTools: () => ["bash", "read", "write", "edit"],
  setActiveTools: () => {},
  getSettings: () => ({ shellPath: "/bin/bash" }),
  sendMessage: () => {},
};

/** Answers with the last option, which is always the refusal. */
const ctx = {
  cwd: workspace,
  mode: "tui",
  hasUI: true,
  signal: undefined,
  model: undefined,
  ui: {
    notify: () => {},
    setStatus: () => {},
    setWidget: () => {},
    theme,
    select: async (_title: string, options: string[]) => {
      selected.push(options);
      return options[options.length - 1];
    },
    confirm: async () => false,
    input: async () => undefined,
  },
  sessionManager: {
    getSessionId: () => "smoke-session",
    getBranch: () => [],
    getSessionFile: () => undefined,
  },
  isIdle: () => true,
};

beforeAll(async () => {
  process.env.PI_PERMISSIONS_DIR = agentDir;
  process.env.PI_SANDBOX_DIR = join(workspace, "sandbox");
  handlers = new Map();
  const { default: register } = await import("../tools/permissions/index.ts");
  register(pi as never);
});

describe("permissions extension handlers", () => {
  test("session_start writes this session's profile", async () => {
    await handlers.get("session_start")?.({}, ctx);
    const { sessionProfilePath } = await import("../shared/permissions-policy.ts");
    expect(existsSync(sessionProfilePath(workspace, "smoke-session"))).toBe(true);
  });

  test("a sandbox denial raises the grant dialog and notifies", async () => {
    emitted.length = 0;
    selected.length = 0;

    const denied = join(homedir(), "sb-smoke-denied.txt");
    const result = await handlers.get("tool_result")?.(
      {
        toolName: "bash",
        toolCallId: "call-1",
        input: { command: "touch it", timeout: 5, description: "touch a file outside the allowlist" },
        content: [{ type: "text", text: `/bin/bash: ${denied}: Operation not permitted` }],
        isError: false,
      },
      ctx,
    );

    expect(selected.length).toBe(1);
    expect(selected[0].some((option) => option.includes("No, leave it denied"))).toBe(true);
    expect(emitted.some((entry) => entry.event === "prompt_wait")).toBe(true);
    // The dialog was offered and the run was notified; the annotation itself is
    // covered by the denial handler's own notes.
    expect(result === undefined || JSON.stringify(result).includes("permissions")).toBe(true);
  });

  test("a denial on a non-command tool is ignored", async () => {
    emitted.length = 0;
    selected.length = 0;
    const result = await handlers.get("tool_result")?.(
      {
        toolName: "grep",
        toolCallId: "call-2",
        input: { pattern: "Operation not permitted" },
        content: [{ type: "text", text: "/bin/bash: /Users/x/y: Operation not permitted" }],
        isError: false,
      },
      ctx,
    );
    expect(selected.length).toBe(0);
    expect(emitted.length).toBe(0);
    expect(result).toBeUndefined();
  });
});

process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));
