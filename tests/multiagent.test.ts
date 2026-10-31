import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, mock, test } from "bun:test";

const children: any[] = [];
const commands: any[][] = [];
const uiResponses: any[] = [];
let settleMode: "success" | "error" | "hang" = "success";
let settleAborted = false;
let settleOutput = "Answer";
let uiSelectCalls = 0;
let configuredModels: [string, string][] = [];
let failedStartupModels = new Set<string>();
let silentlyDefaultedModels = new Set<string>();
let failedRequestModels = new Set<string>();
let failedSetModels = new Set<string>();
let settleDuringSetModel = false;
let emitToolBeforeFailure = false;
mock.module("node:child_process", () => ({ spawn: (_command: string, args: string[]) => {
 commands.push(args); const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.killed = false; child.kill = () => { child.killed = true; queueMicrotask(() => { child.exitSeen = true; child.emit("exit", 0); }); return true; };
 child.stdin.on("data", (chunk: Buffer) => { for (const line of chunk.toString().split("\n").filter(Boolean)) { const request = JSON.parse(line); if (request.type === "prompt") {
  child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "prompt", success: true, data: { disposition: "started" } })}\n`);
  if (settleMode !== "hang") queueMicrotask(() => { const activeModel = child.activeModel ?? args[args.indexOf("--model") + 1]; const providerFailed = activeModel && failedRequestModels.has(activeModel); if (providerFailed && emitToolBeforeFailure) child.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName: "read" })}\n`); child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: settleOutput }], stopReason: providerFailed || settleMode === "error" ? "error" : "stop", errorMessage: providerFailed ? "provider unavailable" : settleMode === "error" ? "backend failed" : undefined } })}\n`); child.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: settleAborted })}\n`); });
 } else if (request.type === "extension_ui_response") uiResponses.push(request); else if (request.type === "get_state") { const model = child.activeModel ?? args[args.indexOf("--model") + 1]; if (model && failedStartupModels.has(model)) child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "get_state", success: false, error: `Cannot initialize ${model}` })}\n`); else child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "get_state", success: true, data: { isStreaming: false, sessionFile: `/tmp/multiagent-test/${args[args.indexOf("--session-id") + 1]}.jsonl`, model: model && !silentlyDefaultedModels.has(model) ? { provider: model.slice(0, model.indexOf("/")), id: model.slice(model.indexOf("/") + 1) } : { provider: "provider", id: "default" } } })}\n`); } else if (request.type === "set_model") { const model = `${request.provider}/${request.modelId}`; if (failedSetModels.has(model)) child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "set_model", success: false, error: `Cannot select ${model}` })}\n`); else { child.activeModel = model; child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "set_model", success: true, data: {} })}\n`); } if (settleDuringSetModel) child.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`); } else if (request.type === "get_messages") child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "get_messages", success: true, data: { messages: [] } })}\n`); else if (request.type === "abort") child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: "abort", success: true, data: {} })}\n`);
 } }); children.push(child); return child;
} }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => "/tmp/multiagent-test", getMarkdownTheme: () => ({}), keyHint: (_action: string, label: string) => `Ctrl+O ${label}` }));
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: (values: unknown) => ({ values }) }));
mock.module("typebox", () => ({ Type: { Object: (value: unknown) => value, String: (value: unknown) => value, Optional: (value: unknown) => value } }));
mock.module("@earendil-works/pi-tui", () => ({ Container: class { children: any[] = []; addChild(child: unknown) { this.children.push(child); } }, Box: class { children: any[] = []; constructor(..._args: any[]) {} addChild(child: unknown) { this.children.push(child); } }, Markdown: class { constructor(public text: string, ..._args: any[]) {} }, ScrollView: class {}, Key: { escape: "escape" }, matchesKey: (a: string, b: string) => a === b, Spacer: class {}, Text: class { constructor(public text: string, ..._args: any[]) {} } }));
mock.module("../agents/subagent/agents.ts", () => ({ discoverAgents: (_cwd: string, scope: string) => ({ agents: scope === "project" || scope === "both" ? [{ name: "scout", source: "project", capability: "high", tools: ["read"], systemPrompt: "project prompt", filePath: "/tmp/project/scout" }] : [{ name: "scout", source: "user", capability: "low", tools: [], systemPrompt: "user prompt", filePath: "/tmp/user/scout" }] }) }));
mock.module("../shared/model-config.ts", () => ({ getSubagentModelFallbacks: () => configuredModels }));

const { default: register } = await import("../agents/multiagent/index.ts");
function harness() {
 const statuses = new Map<string, string>();
 const tools = new Map<string, any>(); const cmd = new Map<string, any>(); const handlers = new Map<string, any>(); const entries: any[] = []; const sent: any[] = [];
 const renderers = new Map<string, any>();
 const pi: any = { registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, opts: any) => cmd.set(name, opts), on: (name: string, fn: any) => handlers.set(name, fn), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }), sendMessage: (message: any, options: any) => sent.push({ message, options }), events: { on: () => () => {}, emit: () => {} } };
 const ctx: any = { cwd: "/tmp/project", mode: "rpc", hasUI: false, isIdle: () => true, ui: { theme: { fg: (_color: string, text: string) => text }, setStatus: (key: string, value?: string) => { if (value === undefined) statuses.delete(key); else statuses.set(key, value); }, notify: () => {}, select: async () => undefined, confirm: async () => true, input: async () => undefined, custom: async () => {} }, sessionManager: { getSessionId: () => "planner-test", getSessionFile: () => "/tmp/planner.jsonl", getBranch: () => entries } };
 register(pi); handlers.get("session_start")(undefined, ctx); return { tools, cmd, handlers, entries, sent, ctx, renderers, statuses };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { for (const child of children.splice(0)) { child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); } commands.splice(0); uiResponses.splice(0); settleMode = "success"; settleAborted = false; settleOutput = "Answer"; configuredModels = []; failedStartupModels = new Set(); silentlyDefaultedModels = new Set(); failedRequestModels = new Set(); failedSetModels = new Set(); settleDuringSetModel = false; emitToolBeforeFailure = false; });

describe("multiagent RPC operators", () => {
 test("shows a play/pause statusline with running and total operator counts", async () => {
  settleMode = "hang";
  const h = harness(); const tool = h.tools.get("multiagent");
  expect(h.statuses.has("multiagent")).toBe(false);
  await tool.execute("id", { action: "start", name: "one", agent: "scout", task: "work" }, undefined, undefined, h.ctx);
  expect(h.statuses.get("multiagent")).toContain("▶");
  expect(h.statuses.get("multiagent")).toContain("1/1");
  const child = children.at(-1);
  child.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`); await tick();
  expect(h.statuses.get("multiagent")).toContain("⏸");
  expect(h.statuses.get("multiagent")).toContain("0/1");
  await tool.execute("id", { action: "restart", name: "one", agent: "scout", task: "again" }, undefined, undefined, h.ctx);
  expect(h.statuses.get("multiagent")).toContain("1/1");
  h.handlers.get("session_shutdown")(undefined, h.ctx);
  expect(h.statuses.has("multiagent")).toBe(false);
 });

 test("renders compact tool and completion entries with expandable output", async () => {
  const h = harness(); const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  const tool = h.tools.get("multiagent");
  expect(tool.renderCall({ action: "start", name: "worker", agent: "scout" }, theme).text).toContain("worker (scout)");
  const result = { content: [{ type: "text", text: "Summary\nFull details" }] };
  expect(tool.renderResult(result, { expanded: false }, theme).text).toBe("Summary");
  expect(tool.renderResult(result, { expanded: true }, theme).children[0].text).toContain("Full details");
  const message = { content: "Operator worker completed.\n\nDetailed answer", details: { name: "worker", agent: "scout", status: "completed" } };
  const render = h.renderers.get("multiagent_completion");
  expect(render(message, { expanded: false, outputPad: 1 }, theme).children[0].text).toContain("worker (scout)");
  expect(render(message, { expanded: true, outputPad: 1 }, theme).children.at(-1).text).toBe("Detailed answer");
 });
 test("falls back across configured capability models on startup failure without replaying the assignment", async () => {
  configuredModels = [["provider", "primary"], ["provider", "backup"]]; failedStartupModels.add("provider/primary");
  const h = harness(); const result = await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "do once" }, undefined, undefined, h.ctx); await tick();
  expect(commands).toHaveLength(2); expect(commands[0]).toContain("provider/primary"); expect(commands[1]).toContain("provider/backup");
  expect(commands.map(args => args[args.indexOf("--session-id") + 1])).toEqual([result.details.operator.id, result.details.operator.id]);
  expect(result.details.operator.model).toBe("provider/backup"); expect(result.details.operator.modelFallback).toContain("Fallback 2/2");
  expect(h.sent.at(-1).message.content).toContain("completed");
 });
 test("rejects a silently defaulted RPC model and records only the actually selected fallback", async () => {
  configuredModels = [["provider", "primary"], ["provider", "backup"]]; silentlyDefaultedModels.add("provider/primary");
  const h = harness(); const result = await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "do once" }, undefined, undefined, h.ctx); await tick();
  expect(commands).toHaveLength(2); expect(result.details.operator.model).toBe("provider/backup");
  expect(h.entries.filter(e => e.data?.action === "model").some(e => e.data.operator.model === "provider/primary")).toBe(false);
 });
 test("retries a provider request failure on the next model in the same RPC session", async () => {
  configuredModels = [["provider", "primary"], ["provider", "backup"]]; failedRequestModels.add("provider/primary");
  const h = harness(); const result = await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "do once" }, undefined, undefined, h.ctx); await tick(10);
  expect(commands).toHaveLength(1); expect(commands[0]).toContain("provider/primary");
  expect(commands[0][commands[0].indexOf("--session-id") + 1]).toBe(result.details.operator.id);
  const latest = h.entries.filter(e => e.data?.action === "model").at(-1).data.operator;
  expect(latest.model).toBe("provider/backup"); expect(latest.modelFallback).toContain("Fallback 2/2");
  expect(h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status).toBe("idle");
 });
 test("skips set_model failures and preserves slashes in model IDs", async () => {
  configuredModels = [["provider", "primary"], ["provider", "wrong/model"], ["provider", "bad/model"], ["provider", "good/model"]]; failedRequestModels.add("provider/primary"); silentlyDefaultedModels.add("provider/wrong/model"); failedSetModels.add("provider/bad/model");
  const h = harness(); const result = await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "once" }, undefined, undefined, h.ctx); await tick(10);
  const selected = h.entries.filter(e => e.data?.action === "model").at(-1).data.operator;
  expect(selected.model).toBe("provider/good/model");
  expect(selected.modelFallback).toContain("Fallback 4/4");
  expect(h.sent.at(-1).message.content).toContain("completed");
 });
 test("reports every failed fallback candidate and completes only once despite stale settlement", async () => {
  configuredModels = [["provider", "primary"], ["provider", "bad"], ["provider", "backup"]]; failedRequestModels.add("provider/primary"); failedSetModels.add("provider/bad"); failedSetModels.add("provider/backup"); settleDuringSetModel = true;
  const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "once" }, undefined, undefined, h.ctx); await tick(10);
  const status = h.entries.filter(e => e.data?.action === "status").at(-1).data.operator;
  expect(status.status).toBe("failed"); expect(status.lastActivity).toContain("provider/bad"); expect(status.lastActivity).toContain("provider/backup");
  expect(h.sent.filter(item => item.message.customType === "multiagent_completion")).toHaveLength(1);
 });
 test("does not fallback after tool execution starts", async () => {
  configuredModels = [["provider", "primary"], ["provider", "backup"]]; failedRequestModels.add("provider/primary"); emitToolBeforeFailure = true;
  const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "do once" }, undefined, undefined, h.ctx); await tick();
  expect(commands).toHaveLength(1); expect(h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status).toBe("failed");
 });
 test("creates distinct RPC sessions on restart and responds through the actual RPC protocol", async () => {
  const h = harness(); const tool = h.tools.get("multiagent");
  await tool.execute("id", { action: "start", name: "worker", agent: "scout", task: "first" }, undefined, undefined, h.ctx);
  await tick(); const first = h.entries.filter(e => e.data?.operator?.name === "worker" && e.data.action === "start").at(-1).data.operator;
  const restarted = await tool.execute("id", { action: "restart", name: "worker", agent: "scout", task: "second" }, undefined, undefined, h.ctx);
  const second = restarted.details.operator;
  expect(children[0].exitSeen).toBe(true); // old RPC process must exit before reopening the operator session
  expect(second.id).not.toBe(first.id); expect(second.sessionFile).not.toBe(first.sessionFile); expect(second.sessionFile).toContain(second.id);
  expect(commands[0]).toContain("--session-id"); expect(commands[0]).not.toContain("--session");
  expect(h.sent).toHaveLength(2); expect(h.sent.every(item => item.options.triggerTurn)).toBe(true);
 });
 test("cancels blocking child UI requests without opening planner UI and reports the blocker", async () => {
  settleMode = "hang"; const h = harness(); uiSelectCalls = 0; h.ctx.ui.select = async () => { uiSelectCalls++; return "never"; };
  await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "ui" }, undefined, undefined, h.ctx);
  const child = children.at(-1); child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Pick", options: ["chosen"] })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "hello" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "agent_settled", aborted: false })}\n`); await tick();
  expect(uiResponses.some(response => response.id === "ui-1" && response.cancelled)).toBe(true);
  expect(uiResponses.some(response => response.id === "notify-1")).toBe(false);
  expect(uiSelectCalls).toBe(0); expect(h.sent.at(-1).message.content).toContain("direct user control is unavailable");
 });
 test("restores the exact selected project agent configuration and preserves old session paths on restart", async () => {
  const h = harness(); h.ctx.hasUI = true;
  await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", agentScope: "both", task: "first" }, undefined, undefined, h.ctx); await tick();
  const firstPath = h.entries.filter(e => e.data?.operator?.name === "worker" && e.data.action === "session").at(-1).data.operator.sessionFile;
  h.handlers.get("session_tree")(undefined, h.ctx);
  await h.tools.get("multiagent").execute("id", { action: "send", name: "worker", task: "restored" }, undefined, undefined, h.ctx);
  expect(commands.at(-1)).toContain("project prompt"); expect(commands.at(-1)).toContain("read");
  const restarted = await h.tools.get("multiagent").execute("id", { action: "restart", name: "worker", agent: "scout", agentScope: "both", task: "again" }, undefined, undefined, h.ctx);
  expect(restarted.details.operator.priorSessionFiles).toContain(firstPath);
  const inspected = await h.tools.get("multiagent").execute("id", { action: "inspect", name: "worker" }, undefined, undefined, h.ctx); expect(inspected.content[0].text).toContain(`Prior sessions: ${firstPath}`);
 });
 test("persists completions queued during compaction and delivers them when compaction finishes", async () => {
  const h = harness(); h.handlers.get("session_before_compact")(undefined, h.ctx);
  await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "compact" }, undefined, undefined, h.ctx); await tick();
  expect(h.sent).toHaveLength(0);
  expect(h.entries.some(e => e.data?.action === "completion_pending" && e.data.operator.pendingCompletion === "completed")).toBe(true);
  h.handlers.get("session_compact")(undefined, h.ctx); await tick(10);
  expect(h.sent).toHaveLength(1); expect(h.sent[0].message.content).toContain("completed");
 });
 test("does not append the previous branch's live operator into the selected branch", async () => {
  settleMode = "hang"; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "old branch" }, undefined, undefined, h.ctx);
  const priorEntryCount = h.entries.length;
  const selectedBranch: any[] = []; h.ctx.sessionManager.getBranch = () => selectedBranch;
  h.handlers.get("session_tree")(undefined, h.ctx);
  expect(children.at(-1).killed).toBe(true);
  expect(selectedBranch).toHaveLength(0);
  expect(h.entries).toHaveLength(priorEntryCount);
 });
 test("classifies assistant error settlement as failed", async () => {
  settleMode = "error"; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "fail" }, undefined, undefined, h.ctx); await tick();
  const status = h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status; expect(status).toBe("failed"); expect(h.sent.at(-1).message.content).toContain("backend failed");
 });
 test("fails an active assignment when the child exits", async () => {
  settleMode = "hang"; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "exit" }, undefined, undefined, h.ctx);
  // The prompt is accepted but still active; process exit must settle the assignment as failed.
  children.at(-1).emit("exit", 0); await tick(); expect(h.sent.some(item => item.message.content.includes("failed"))).toBe(true);
 });
 test("bounds captured planner-facing child output", async () => {
  settleOutput = "x".repeat(20_000); const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "large" }, undefined, undefined, h.ctx); await tick();
  expect(h.sent.at(-1).message.content.length).toBeLessThan(12_200);
 });
 test("classifies aborted settlement distinctly", async () => {
  settleAborted = true; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "abort" }, undefined, undefined, h.ctx); await tick();
  const status = h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status; expect(status).toBe("aborted"); expect(h.sent.at(-1).message.content).toContain("aborted");
 });
 test("session shutdown kills active children and records interruption", async () => {
  settleMode = "hang"; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "long" }, undefined, undefined, h.ctx);
  const child = children.at(-1); h.handlers.get("session_shutdown")();
  expect(child.killed).toBe(true); expect(h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status).toBe("stopped");
  expect(h.entries.at(-1).data.operator.lastActivity).toContain("Interrupted");
 });
 test("session switch kills active children and records interruption", async () => {
  settleMode = "hang"; const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "long" }, undefined, undefined, h.ctx);
  const child = children.at(-1); h.handlers.get("session_tree")(undefined, h.ctx);
  expect(child.killed).toBe(true); expect(h.entries.filter(e => e.data?.action === "status").at(-1).data.operator.status).toBe("stopped");
  expect(h.entries.at(-1).data.operator.lastActivity).toContain("Interrupted");
 });
 test("returns an empty dormant-session transcript without attempting model work", async () => {
  const h = harness(); await h.tools.get("multiagent").execute("id", { action: "start", name: "worker", agent: "scout", task: "one" }, undefined, undefined, h.ctx); await tick();
  const result = await h.tools.get("multiagent").execute("id", { action: "inspect", name: "worker" }, undefined, undefined, h.ctx); expect(result.content[0].text).toContain("Status:"); expect(result.details.transcript).toBe("(No transcript available yet.)");
 });
});
