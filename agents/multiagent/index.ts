import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { createOperatorViewer } from "./viewer.ts";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "../subagent/agents.ts";
import { getSubagentModelFallbacks } from "../../shared/model-config.ts";
import { createNotificationGate } from "../../shared/notification-gate.ts";
import { extractSessionActivity, formatDuration, renderSessionActivity } from "../shared/session-activity.ts";

const STATE = "multiagent";
const STATUS_KEY = "multiagent";
const COMPLETE = "multiagent_completion";
type Status = "idle" | "running" | "stopped" | "failed" | "aborted";
interface Operator {
 id: string; name: string; agent: string; sessionFile: string; priorSessionFiles?: string[]; agentConfig?: AgentConfig; cwd: string; status: Status; model?: string; modelFallback?: string;
 assignment?: string; assignmentId?: string; startedAt: number; finishedAt?: number; lastOutput?: string; lastActivity?: string; pendingCompletion?: string;
}
interface LiveOperator { client: RpcProcess; operator: Operator; busy: boolean; starting?: boolean; error?: string; models: string[]; modelIndex: number; toolExecutionStarted: boolean; interactiveBlocked: boolean; retrying?: boolean; pendingSettlement?: boolean; pendingAborted?: boolean; }
class RpcProcess {
 private child: ChildProcessWithoutNullStreams;
 private buffer = ""; private decoder = new StringDecoder("utf8"); private seq = 0; private closed = false;
 private pending = new Map<string, { resolve: (response: any) => void; reject: (error: Error) => void }>();
 listeners = new Set<(event: any) => void>();
 private exitPromise: Promise<void>;
 private resolveExit!: () => void;
 constructor(child: ChildProcessWithoutNullStreams) {
  this.child = child;
  this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
  // Keep diagnostics flowing so a full stderr pipe cannot stall the operator.
  child.stderr.resume();
  child.stdout.on("data", chunk => {
   this.buffer += this.decoder.write(chunk); const lines = this.buffer.split("\n"); this.buffer = lines.pop() ?? "";
   for (const line of lines) { try { const data = JSON.parse(line); if (data.type === "response" && data.id && this.pending.has(data.id)) { const pending = this.pending.get(data.id)!; this.pending.delete(data.id); if (data.success) pending.resolve(data.data); else pending.reject(new Error(data.error ?? "RPC command failed")); } else for (const listener of this.listeners) listener(data); } catch {} }
  });
  const fail = (error: Error) => { if (this.closed) return; this.closed = true; this.resolveExit(); for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); };
  child.on("error", fail); child.on("exit", code => fail(new Error(`RPC process exited (${code ?? "unknown"})`)));
 }
 command(type: string, fields: Record<string, unknown> = {}): Promise<any> {
  if (this.closed) return Promise.reject(new Error("RPC process is closed"));
  const id = `multiagent-${++this.seq}`;
  return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, error => { if (error) { this.pending.delete(id); reject(error); } }); });
 }
 respond(id: string, response: Record<string, unknown>): void { if (!this.closed) this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`); }
 async stop(): Promise<void> { if (!this.closed) { this.child.stdin.end(); this.child.kill("SIGTERM"); } await this.exitPromise; }
}
function invocation(args: string[]) {
 const current = process.argv[1];
 if (current && !current.startsWith("/$bunfs/root/") && fs.existsSync(current)) return { command: process.execPath, args: [current, ...args] };
 return { command: "pi", args };
}
function stateModelReference(state: any): string | undefined {
 const model = state?.model;
 if (model && typeof model.provider === "string" && typeof model.id === "string") return `${model.provider}/${model.id}`;
 if (typeof state?.provider === "string" && typeof state?.modelId === "string") return `${state.provider}/${state.modelId}`;
 return undefined;
}
function outputText(event: any): string | undefined {
 const msg = event?.message; if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;
 const text = msg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").trim();
 return text ? text.slice(0, 12_000) : undefined;
}
function safeName(name: string): string { return name.replace(/[^a-zA-Z0-9_-]/g, "_"); }
function sessionMessages(file: string): any[] {
 try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => { try { const e = JSON.parse(line); return e.type === "message" && e.message ? [e.message] : []; } catch { return []; } }); } catch { return []; }
}
function formatTranscript(messages: any[]): string {
 if (!messages.length) return "(No transcript available yet.)";
 const activity = extractSessionActivity(messages, { messageLimit: 40, activityLimit: 10, draftChars: 3000 });
 return renderSessionActivity(activity, true, { activityLimit: 10, draftChars: 3000 }).join("\n") || "(No text or tool activity in transcript.)";
}
function transcript(op: Operator): string { return formatTranscript(sessionMessages(op.sessionFile)); }
const Params = Type.Object({ action: StringEnum(["start", "send", "list", "inspect", "stop", "restart"] as const), name: Type.Optional(Type.String({ description: "Operator name" })), agent: Type.Optional(Type.String({ description: "Agent definition name for start/restart" })), task: Type.Optional(Type.String({ description: "Assignment for start/send/restart" })), agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })), cwd: Type.Optional(Type.String({ description: "Operator working directory" })) });

export default function(pi: any) {
 const operators = new Map<string, Operator>(); const live = new Map<string, LiveOperator>(); const assignmentReservations = new Set<string>(); const shutdowns = new Map<string, Promise<void>>();
 function stopLive(item: LiveOperator): Promise<void> { const stopping = item.client.stop(); shutdowns.set(item.operator.name, stopping); return stopping.finally(() => { if (shutdowns.get(item.operator.name) === stopping) shutdowns.delete(item.operator.name); }); }
 let currentCtx: any; let generation = 0;
 const notified = new WeakMap<Operator, string>();
 const notifications = createNotificationGate(pi, () => {
  for (const op of operators.values()) {
   const status = op.pendingCompletion;
   if (!status) continue;
   op.pendingCompletion = undefined;
   record("completion_delivered", op);
   deliverCompletion(op, status);
  }
 });
 function record(action: string, operator: Operator) { pi.appendEntry(STATE, { action, operator: { ...operator } }); updateIndicator(); }
 /** Statusline summary: ▶ while any operator is working, ⏸ when all are idle; running/total. */
 function updateIndicator() {
  const ctx = currentCtx; if (!ctx?.ui?.setStatus) return;
  const total = operators.size;
  if (total === 0) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
  const running = [...operators.values()].filter((op) => op.status === "running").length;
  const icon = running > 0 ? "▶" : "⏸";
  const label = `${running}/${total}`;
  const theme = ctx.ui.theme;
  ctx.ui.setStatus(STATUS_KEY, theme ? theme.fg(running > 0 ? "accent" : "muted", icon) + " " + theme.fg("muted", label) : `${icon} ${label}`);
 }
 function deliverCompletion(op: Operator, status: string) {
  pi.sendMessage({ customType: COMPLETE, content: `Operator ${op.name} (${op.agent}) ${status}.\n\n${status === "failed" ? op.lastActivity ?? op.lastOutput ?? "(no final text output)" : op.lastOutput ?? op.lastActivity ?? "(no final text output)"}`, display: true, details: { name: op.name, agent: op.agent, status, sessionFile: op.sessionFile, finishedAt: op.finishedAt } }, { deliverAs: "followUp", triggerTurn: true });
 }
 function notifyCompletion(op: Operator, status: string) {
  const key = `${op.assignmentId ?? op.startedAt}:${status}`; if (notified.get(op) === key) return; notified.set(op, key);
  if (!currentCtx) { deliverCompletion(op, status); return; }
  op.pendingCompletion = status;
  record("completion_pending", op);
  notifications.request();
 }
 function sessionDir(ctx: any) { const id = ctx.sessionManager.getSessionId?.() ?? path.basename(ctx.sessionManager.getSessionFile?.() ?? "planner"); return path.join(getAgentDir(), "multiagent", String(id).replace(/[^a-zA-Z0-9_-]/g, "_")); }
 function restore(ctx: any) {
  generation++; for (const item of live.values()) void stopLive(item); live.clear(); operators.clear(); assignmentReservations.clear(); currentCtx = ctx; notifications.reset(ctx);
  for (const entry of ctx.sessionManager.getBranch()) { if (entry.type !== "custom" || entry.customType !== STATE) continue; const data = entry.data as { action?: string; operator?: Operator } | undefined; if (!data?.operator) continue; if (data.action === "remove") operators.delete(data.operator.name); else operators.set(data.operator.name, data.operator); }
  for (const op of operators.values()) {
   if (op.status === "running") { op.status = "stopped"; op.finishedAt = Date.now(); op.lastActivity = "Interrupted: previous planner ended; child process stopped."; record("status", op); }
   if (op.pendingCompletion) notifications.request();
  }
  updateIndicator();
 }
 async function startProcess(op: Operator, agent: AgentConfig, ctx: any): Promise<LiveOperator> {
  await shutdowns.get(op.name);
  const myGeneration = generation; const dir = path.dirname(op.sessionFile); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const candidates = getSubagentModelFallbacks(agent.capability);
  const models: Array<string | undefined> = candidates.length ? candidates.map(([provider, id]) => `${provider}/${id}`) : [undefined];
  let lastError: unknown;
  for (let index = 0; index < models.length; index++) {
   const model = models[index];
   const args = ["--mode", "rpc", "--session-id", op.id, "--session-dir", dir, "--name", `${op.name} (${agent.name})`];
   if (agent.tools?.length) args.push("--tools", agent.tools.join(",")); if (agent.systemPrompt.trim()) args.push("--append-system-prompt", agent.systemPrompt);
   if (model) { args.push("--model", model); }
   const cmd = invocation(args); const child = spawn(cmd.command, cmd.args, { cwd: op.cwd || ctx.cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
   const rpc = new RpcProcess(child); const liveOp: LiveOperator = { client: rpc, operator: op, busy: false, starting: true, models, modelIndex: index, toolExecutionStarted: false, interactiveBlocked: false }; live.set(op.name, liveOp);
  rpc.listeners.add(event => {
   if (event.type === "agent_settled") void finishAssignment(liveOp, event.aborted === true);
   if (event.type === "extension_ui_request") {
    if (["select", "confirm", "input"].includes(event.method)) {
     if (event.id) rpc.respond(event.id, { cancelled: true });
     if (liveOp.busy) { liveOp.interactiveBlocked = true; liveOp.error = `Operator assignment blocked: child requested interactive UI (${event.method}); direct user control is unavailable.`; }
    } else if (event.method === "notify") { /* notifications are intentionally ignored */ }
    else if (event.id && !["setStatus", "setWidget", "setTitle"].includes(event.method)) rpc.respond(event.id, { cancelled: true });
   }
   const text = outputText(event); if (text) op.lastOutput = text;
   if (event.type === "message_end" && event.message?.role === "assistant") {
    if (typeof event.message.provider === "string" && typeof event.message.model === "string") {
     const actualModel = `${event.message.provider}/${event.message.model}`;
     if (actualModel !== op.model) { op.model = actualModel; record("model", op); }
    }
    if (event.message.errorMessage || event.message.stopReason === "error") liveOp.error = event.message.errorMessage ?? "Operator turn failed.";
    else if (event.message.stopReason && event.message.stopReason !== "stop") op.lastActivity = `Stopped: ${event.message.stopReason}`;
   }
   if (event.type === "tool_execution_start") { liveOp.toolExecutionStarted = true; op.lastActivity = `tool: ${event.toolName ?? event.toolCall?.name ?? "running"}`; }
  });
  child.on("error", error => terminate(liveOp, `RPC process error: ${error.message}`, true));
  child.on("exit", code => terminate(liveOp, `RPC process exited unexpectedly (${code ?? "unknown"}).`, true));
  // Ask the RPC server for its canonical session path; session-id files include a generated timestamp.
   try {
    const state = await rpc.command("get_state");
    if (generation !== myGeneration || operators.get(op.name) !== op) { await rpc.stop(); throw new Error("Planner session changed while starting operator."); }
    const selectedModel = stateModelReference(state);
    if (model && selectedModel !== model) throw new Error(`Pi selected ${selectedModel ?? "an unknown model"} instead of requested ${model}.`);
    if (state?.sessionFile && state.sessionFile !== op.sessionFile) { op.sessionFile = state.sessionFile; record("session", op); }
    liveOp.starting = false; op.model = selectedModel ?? op.model;
    if (index > 0) op.modelFallback = `Fallback ${index + 1}/${models.length} after ${index} startup failure${index === 1 ? "" : "s"}.`; else op.modelFallback = undefined;
    record("model", op);
    return liveOp;
   } catch (error) {
    lastError = error; if (live.get(op.name) === liveOp) live.delete(op.name); await rpc.stop();
    if (generation !== myGeneration || operators.get(op.name) !== op) throw error;
   }
  }
  throw new Error(`Unable to start operator with configured capability models (${models.filter(Boolean).join(", ") || "default model"}): ${String(lastError)}`);
 }
 function terminate(liveOp: LiveOperator, reason: string, failed: boolean) {
  const op = liveOp.operator; if (live.get(op.name) !== liveOp) return; live.delete(op.name); liveOp.busy = false;
  if (liveOp.starting) return;
  if (op.status === "running") { op.status = failed || !!liveOp.error ? "failed" : "idle"; op.lastActivity = liveOp.error ?? reason; op.finishedAt = Date.now(); record("status", op); notifyCompletion(op, op.status === "failed" ? "failed" : "completed"); }
 }
 async function finishAssignment(liveOp: LiveOperator, aborted = false) {
  if (!liveOp.busy || live.get(liveOp.operator.name) !== liveOp) return;
  if (liveOp.retrying) { liveOp.pendingSettlement = true; liveOp.pendingAborted = aborted; return; }
  const op = liveOp.operator;
  const failure = liveOp.error;
  if (failure && !aborted && !liveOp.toolExecutionStarted && !liveOp.interactiveBlocked && liveOp.modelIndex + 1 < liveOp.models.length) {
   liveOp.retrying = true;
   const reasons: string[] = [];
   try {
    for (let nextIndex = liveOp.modelIndex + 1; nextIndex < liveOp.models.length; nextIndex++) {
     const candidate = liveOp.models[nextIndex];
     const separator = candidate.indexOf("/");
     const provider = separator < 0 ? candidate : candidate.slice(0, separator);
     const modelId = separator < 0 ? "" : candidate.slice(separator + 1);
     try {
      await liveOp.client.command("set_model", { provider, modelId });
      const state = await liveOp.client.command("get_state");
      const selected = stateModelReference(state);
      if (selected !== candidate) throw new Error(`Pi selected ${selected ?? "an unknown model"} instead of requested ${candidate}.`);
      if (live.get(op.name) !== liveOp || op.status !== "running" || !liveOp.busy) return;
      liveOp.modelIndex = nextIndex; liveOp.error = undefined; liveOp.toolExecutionStarted = false; liveOp.interactiveBlocked = false;
      op.model = selected; op.modelFallback = `Fallback ${nextIndex + 1}/${liveOp.models.length} after provider request failure.`;
      op.lastActivity = `Retrying assignment with ${selected}`; record("model", op);
      liveOp.pendingSettlement = false; liveOp.pendingAborted = undefined;
      await liveOp.client.command("prompt", { message: op.assignment });
      return;
     } catch (error) {
      if (live.get(op.name) !== liveOp || op.status !== "running" || !liveOp.busy) return;
      reasons.push(`${candidate}: ${String(error)}`);
     }
    }
    liveOp.error = `${failure} (all remaining model fallbacks failed: ${reasons.join("; ")})`;
   } finally {
    liveOp.retrying = false;
    if (liveOp.pendingSettlement) { const pendingAborted = liveOp.pendingAborted ?? false; liveOp.pendingSettlement = false; liveOp.pendingAborted = undefined; void finishAssignment(liveOp, pendingAborted); }
   }
  }
  if (!liveOp.busy || live.get(op.name) !== liveOp) return;
  liveOp.busy = false;
  op.status = liveOp.error ? "failed" : aborted ? "aborted" : "idle"; op.finishedAt = Date.now(); op.lastActivity = liveOp.error ?? (aborted ? "Assignment aborted by child agent." : "Assignment complete"); record("status", op); notifyCompletion(op, op.status === "failed" ? "failed" : aborted ? "aborted" : "completed"); liveOp.error = undefined;
 }
 async function ensure(name: string, ctx: any): Promise<LiveOperator> {
  const op = operators.get(name); if (!op) throw new Error(`Unknown operator "${name}".`); const existing = live.get(name); if (existing) return existing;
  const agent = op.agentConfig ?? discoverAgents(op.cwd || ctx.cwd, op.agentConfig?.source ?? "user").agents.find(a => a.name === op.agent); if (!agent) throw new Error(`Cannot restore ${name}: ${op.agentConfig?.source ?? "user"} agent definition "${op.agent}" is unavailable.`); return startProcess(op, agent, ctx);
 }
 async function assignment(op: Operator, task: string, ctx: any) {
  if (!task.trim()) throw new Error("Task cannot be empty."); if (op.status === "running" || assignmentReservations.has(op.name)) throw new Error(`Operator ${op.name} already has an active assignment.`);
  assignmentReservations.add(op.name); op.status = "running"; op.assignment = task; op.assignmentId = randomUUID(); op.startedAt = Date.now(); op.finishedAt = undefined; op.lastOutput = undefined; op.lastActivity = "Assignment accepted"; record("assignment", op);
  try { const liveOp = await ensure(op.name, ctx); liveOp.busy = true; liveOp.error = undefined; liveOp.toolExecutionStarted = false; liveOp.interactiveBlocked = false; const response = await liveOp.client.command("prompt", { message: task }); if (response?.disposition === "handled") { liveOp.busy = false; op.status = "idle"; op.lastActivity = "Prompt handled without a model turn"; op.finishedAt = Date.now(); record("status", op); } }
  catch (error) { const liveOp = live.get(op.name); if (liveOp?.operator === op) liveOp.busy = false; if (currentCtx && operators.get(op.name) === op && op.status === "running") { op.status = "failed"; op.lastActivity = String(error); op.finishedAt = Date.now(); record("status", op); notifyCompletion(op, "failed"); } throw error; }
  finally { assignmentReservations.delete(op.name); }
 }
 function statusLine(op: Operator) { return `${op.name} · ${op.agent} · ${op.status} · ${op.model ?? "model pending"}${op.modelFallback ? ` · ${op.modelFallback}` : ""}${op.assignment ? ` · ${op.assignment.slice(0, 90)}` : ""}${op.lastActivity ? ` · ${op.lastActivity}` : ""}`; }
 function inspectText(op: Operator) { return [`${op.name} (${op.agent})`, `Status: ${op.status} · ${formatDuration(Date.now() - op.startedAt)}`, `Model: ${op.model ?? "not started"}${op.modelFallback ? ` · ${op.modelFallback}` : ""}`, `Assignment: ${op.assignment ?? "none"}`, `Activity: ${op.lastActivity ?? "none"}`, `Recent output: ${(op.lastOutput ?? "(none)").slice(-3000)}`, `Session activity:\n${transcript(op)}`, `Session: ${op.sessionFile}`, ...(op.priorSessionFiles?.length ? [`Prior sessions: ${op.priorSessionFiles.join(", ")}`] : [])].join("\n"); }

 pi.registerMessageRenderer(COMPLETE, (message: any, { expanded, outputPad }: any, theme: any) => {
  const details = message.details ?? {};
  const status = details.status ?? "completed";
  const color = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
  const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "△";
  const label = details.name ? `${details.name}${details.agent ? ` (${details.agent})` : ""}` : "Operator";
  const header = theme.fg(color, icon) + " " + theme.fg("toolTitle", theme.bold(label)) + theme.fg("muted", ` · ${status}`);
  const box = new Box(outputPad, 1, (text: string) => theme.bg("customMessageBg", text));
  const content = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  const separator = content.indexOf("\n\n");
  const body = separator >= 0 ? content.slice(separator + 2) : content;
  if (!expanded) {
   const preview = body.replace(/\s+/g, " ").trim();
   box.addChild(new Text(header + theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`) + (preview ? `\n${theme.fg("customMessageText", preview.length > 180 ? `${preview.slice(0, 180)}…` : preview)}` : ""), 0, 0));
   return box;
  }
  box.addChild(new Text(header, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text: string) => theme.fg("customMessageText", text) }));
  return box;
 });
 pi.on("session_start", (_event: any, ctx: any) => restore(ctx)); pi.on("session_tree", (_event: any, ctx: any) => restore(ctx));
 pi.on("session_shutdown", () => { generation++; notifications.dispose(); for (const item of live.values()) { void stopLive(item); if (item.operator.status === "running") { item.operator.status = "stopped"; item.operator.finishedAt = Date.now(); item.operator.lastActivity = "Interrupted: planner session shut down; child process stopped."; record("status", item.operator); } } live.clear(); currentCtx?.ui?.setStatus?.(STATUS_KEY, undefined); currentCtx = undefined; });
 pi.registerCommand("operators", { description: "Browse persistent operators and their recent session activity", handler: async (args: string, ctx: any) => {
  const values = [...operators.values()]; if (!values.length) { ctx.ui.notify("No operators tracked on this planner branch.", "info"); return; }
  let op = values.find(item => item.name === args.trim());
  if (!op && args.trim()) { ctx.ui.notify(`Unknown operator: ${args.trim()}`, "warning"); return; }
  if (!op && ctx.mode === "tui") { const selected = await ctx.ui.select("Choose operator:", values.map(statusLine)); if (!selected) return; op = values[values.map(statusLine).indexOf(selected)]; }
  if (!op) { ctx.ui.notify(values.map(statusLine).join("\n"), "info"); return; }
  const selected = op;
  const loadReport = async () => {
   let messages = sessionMessages(selected.sessionFile);
   const liveOp = live.get(selected.name);
   if (liveOp?.operator === selected) { try { const result = await liveOp.client.command("get_messages"); if (Array.isArray(result?.messages)) messages = result.messages; } catch {} }
   // Preserve Pi context message objects and their canonical ordering for native components.
   const transcript = messages;
   return { name: selected.name, agent: selected.agent, status: selected.status, model: selected.model ?? "not started", cwd: selected.cwd, sessionPath: selected.sessionFile, messages: transcript };
  };
  if (ctx.mode === "tui") await ctx.ui.custom(createOperatorViewer(loadReport, { heightFraction: 0.6 }));
  else ctx.ui.notify(inspectText(selected), "info");
 } });
 pi.registerTool({ name: "multiagent", label: "Multiagent", description: "Manage persistent Pi operators. Actions: start, send, list, inspect, stop, restart. Operators retain separate sessions and resume on demand.", parameters: Params,
  renderCall(args: any, theme: any) {
   const target = args.name ? ` · ${args.name}${args.agent ? ` (${args.agent})` : ""}` : "";
   return new Text(theme.fg("toolTitle", theme.bold(`multiagent ${args.action ?? ""}`)) + theme.fg("muted", target), 0, 0);
  },
  renderResult(result: any, { expanded }: any, theme: any) {
   const text = (result.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
   if (!expanded) {
    const firstLine = text.split("\n")[0] || (result.isError ? "Failed" : "Done");
    return new Text(theme.fg(result.isError ? "error" : "muted", firstLine), 0, 0);
   }
   const container = new Container();
   container.addChild(new Markdown(text || "(No output.)", 0, 0, getMarkdownTheme()));
   return container;
  },
  async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
   const action: string = params.action; const name = params.name?.trim(); if (["send", "inspect", "stop", "restart"].includes(action) && !name) throw new Error(`${action} requires name.`);
   if (action === "list") { const values = [...operators.values()]; return { content: [{ type: "text", text: values.map(statusLine).join("\n") || "No operators on this planner branch." }], details: { operators: values.map(op => ({ ...op })) } }; }
   if (action === "start" || action === "restart") {
    if (!name || !params.agent || !params.task) throw new Error(`${action} requires name, agent, and task.`); if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Name must use 1–64 letters, numbers, underscores, or hyphens.");
    const found = discoverAgents(params.cwd ?? ctx.cwd, params.agentScope ?? "user"); const agent = found.agents.find((item: AgentConfig) => item.name === params.agent); if (!agent) throw new Error(`Unknown agent "${params.agent}". Available: ${found.agents.map((a: AgentConfig) => a.name).join(", ") || "none"}.`);
    if (agent.source === "project" && ctx.hasUI) { const ok = await ctx.ui.confirm("Run project-local operator?", `Agent: ${agent.name}\nSource: ${agent.filePath}\n\nOnly approve trusted repositories.`); if (!ok) return { content: [{ type: "text", text: "Canceled." }] }; } else if (agent.source === "project") throw new Error("Project-local agents require interactive approval.");
    let op = operators.get(name); if (action === "start" && op) throw new Error(`Operator ${name} exists; use restart to replace its session.`);
    if (op) { const oldLive = live.get(name); if (oldLive) { oldLive.busy = false; try { await oldLive.client.command("abort"); } catch {} await stopLive(oldLive); } live.delete(name); op.status = "stopped"; record("status", op); }
    const priorSessionFiles = op ? [...(op.priorSessionFiles ?? []), op.sessionFile] : [];
    const dir = sessionDir(ctx); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID(); op = { id, name, agent: agent.name, agentConfig: { ...agent }, priorSessionFiles, sessionFile: path.join(dir, `${id}.jsonl`), cwd: params.cwd ?? ctx.cwd, status: "idle", startedAt: Date.now() }; operators.set(name, op); record(action, op);
    await assignment(op, params.task, ctx); return { content: [{ type: "text", text: `${action === "start" ? "Started" : "Restarted"} operator ${name} (${agent.name}) with a persistent session.` }], details: { operator: { ...op } } };
   }
   const op = operators.get(name!); if (!op) throw new Error(`Unknown operator "${name}" on this planner branch.`);
   if (action === "send") { if (!params.task) throw new Error("send requires task."); await assignment(op, params.task, ctx); }
   else if (action === "stop") { if (op.status === "running") { const liveOp = live.get(op.name); if (liveOp) { liveOp.busy = false; try { await liveOp.client.command("abort"); } catch {} } } const stopping = live.get(op.name); if (stopping) await stopLive(stopping); live.delete(op.name); op.status = "stopped"; op.lastActivity = "Stopped by planner"; op.finishedAt = Date.now(); record("status", op); }
   else if (action === "inspect") { const l = live.get(op.name); let sessionText = transcript(op); if (l) { try { const state = await l.client.command("get_state"); op.lastActivity = state?.isStreaming ? "Streaming" : op.lastActivity; const result = await l.client.command("get_messages"); if (Array.isArray(result?.messages)) sessionText = formatTranscript(result.messages); } catch {} } const report = inspectText(op).replace(`Session activity:\n${transcript(op)}`, `Session activity:\n${sessionText}`); return { content: [{ type: "text", text: report }], details: { operator: { ...op }, transcript: sessionText } }; }
   return { content: [{ type: "text", text: `${op.name}: ${op.status}${op.lastActivity ? ` — ${op.lastActivity}` : ""}` }], details: { operator: { ...op } } };
  },
 });
}
