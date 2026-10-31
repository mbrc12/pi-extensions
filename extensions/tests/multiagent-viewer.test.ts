import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const tuiModule = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
const codingAgent = await import(`${piDir}/dist/index.js`);
codingAgent.initTheme();
mock.module("@earendil-works/pi-tui", () => tuiModule);
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
const { createOperatorViewer } = await import("../agents/multiagent/viewer.ts");

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, extras: any[] = []) => ({ role: "assistant", content: [{ type: "text", text }, ...extras], stopReason: "stop" });
function makeViewer(rows: number, messages: any[]) {
  const tui = { terminal: { rows }, requestRender: () => {} };
  const component = createOperatorViewer(() => ({ name: "research", agent: "analyst", status: "running", model: "provider/model", messages }), { refreshIntervalMs: 0 })(tui, theme, {}, () => {});
  return { component, tui };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); }

describe("multiagent session viewer", () => {
  test("renders actual Pi user, assistant, and paired tool messages in chronological order", async () => {
    const messages = [
      user("Please inspect **all** of this."),
      assistant("Checking now.", [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.md" } }]),
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "complete result" }], isError: false },
      assistant("Final response."),
    ];
    const { component } = makeViewer(30, messages);
    await settle();
    const frame = component.render(100).join("\n");
    expect(frame).toContain("research");
    expect(frame).toContain("provider/model");
    expect(frame).toContain("Please inspect");
    expect(frame).toContain("Checking now.");
    expect(frame).toContain("read");
    expect(frame).toContain("complete result");
    expect(frame).toContain("Final response.");
    expect(frame.indexOf("Checking now.")).toBeLessThan(frame.indexOf("complete result"));
    expect(frame.indexOf("complete result")).toBeLessThan(frame.indexOf("Final response."));
    component.dispose();
  });

  test("renders compact entries at narrow widths and supports expansion", async () => {
    const long = `start ${"unbroken-content-".repeat(60)} end`;
    const messages = [user("question"), assistant(long, [{ type: "toolCall", id: "c", name: "read", arguments: { path: "long.txt" } }]), { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text: "# literal output\n- literal line" }], isError: false }];
    const { component } = makeViewer(80, messages);
    await settle();
    const frame = component.render(24).join("\n");
    expect(frame).toContain("start");
    expect(frame).not.toContain("end");
    expect(frame).toContain("unbroken-content-");
    expect(frame.replace(/\s+/g, " ")).toContain("# literal output");
    expect(frame).toMatch(/\d+–\d+\/\d+/);
    component.handleInput("\u000f"); // Ctrl+O
    const expanded = component.render(24).join("\n").replace(/\s+/g, " ");
    expect(expanded).toContain("literal line");
    expect(expanded).toContain("end");
    component.dispose();
  });

  test("truncates role tags and assistant text until expanded", async () => {
    const long = "x".repeat(250);
    const { component } = makeViewer(30, [
      user(long),
      user("hello"),
      assistant(long),
      { role: "toolResult", toolCallId: "t", content: long },
    ]);
    await settle();
    const compact = component.render(500).map(line => line.trimEnd()).join("\n");
    expect(compact).not.toContain("[system]");
    expect(compact).toContain("[user]\nhello");
    expect(compact).toContain("[tool]");
    expect(compact).toContain(`[user]\n${"x".repeat(199)}…`);
    expect(compact).toContain(`[tool] tool result: ${"x".repeat(186)}…`);
    expect(compact).toContain(`-----\n${"x".repeat(199)}…\n-----`);
    expect(compact).not.toContain("\n\n");
    component.handleInput("\u000f");
    const expanded = component.render(500).map(line => line.trimEnd()).join("\n");
    expect(expanded).toContain(long);
    expect(expanded).toContain(`-----\n${long}\n-----`);
    component.dispose();
  });

  test("renders Markdown for user and assistant text but not tool output", async () => {
    const messages = [
      user("**bold** and `code`"),
      assistant("# Heading\n\n- item"),
      { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "**not bold**" }] },
    ];
    const { component } = makeViewer(40, messages);
    await settle();
    const frame = component.render(200).join("\n");
    expect(frame).not.toContain("**bold**");
    expect(frame).toContain("bold");
    expect(frame).toContain("Heading");
    expect(frame).toContain("**not bold**");
    component.dispose();
  });

  test("italicizes tool lines so message text stands out", () => {
    const italicized: string[] = [];
    const themed = { fg: (_color: string, text: string) => text, italic: (text: string) => { italicized.push(text); return text; } };
    const { renderOperatorViewerEntries } = require("../agents/multiagent/viewer.ts");
    renderOperatorViewerEntries([{ role: "tool", content: "read: path = x" }, { role: "assistant", content: "answer" }], 80, themed);
    expect(italicized).toContain("read: path = x");
    expect(italicized).not.toContain("answer");
  });

  test("colors role tags using the active theme", () => {
    const colors: string[] = [];
    const themed = { fg: (color: string, text: string) => { colors.push(color); return text; } };
    const { renderOperatorViewerEntries } = require("../agents/multiagent/viewer.ts");
    renderOperatorViewerEntries([{ role: "user", content: "task" }, { role: "tool", content: "read: path = x" }], 80, themed);
    expect(colors).toContain("accent"); expect(colors).toContain("toolTitle"); expect(colors).not.toContain("warning");
  });

  test("bounds its viewport so the transcript above stays visible", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => user(`line-${index + 1}`));
    const tui = { terminal: { rows: 20 }, requestRender: () => {} };
    const component = createOperatorViewer(() => ({ name: "op", agent: "agent", status: "idle", model: "m", messages }), { refreshIntervalMs: 0, heightFraction: 0.7 })(tui, theme, {}, () => {});
    await settle();
    const frame = component.render(80);
    expect(frame.length).toBeLessThanOrEqual(14);
    expect(frame.length).toBeGreaterThan(5);
    component.dispose();
  });

  test("loads asynchronously, refreshes on r, and handles scrolling and Escape", async () => {
    let calls = 0;
    let renders = 0;
    let closed = false;
    const tui = { terminal: { rows: 9 }, requestRender: () => renders++ };
    const messages = Array.from({ length: 20 }, (_, index) => user(`line-${index + 1}`));
    const component = createOperatorViewer(async () => {
      calls++;
      return { name: "op", agent: "agent", status: "idle", model: "m", messages };
    }, { refreshIntervalMs: 0 })(tui, theme, {}, () => { closed = true; });
    await settle();
    expect(calls).toBe(1);
    const initial = component.render(80).join("\n");
    expect(initial).toContain("line-1");
    const firstPosition = initial.match(/\d+–\d+\/\d+/)?.[0];
    component.handleInput("\u001b[A");
    const scrolled = component.render(80).join("\n");
    expect(scrolled.match(/\d+–\d+\/\d+/)?.[0]).not.toBe(firstPosition);
    component.handleInput("r");
    await settle();
    expect(calls).toBe(2);
    expect(renders).toBeGreaterThan(0);
    component.handleInput("\u001b");
    expect(closed).toBe(true);
    component.dispose();
  });
});
