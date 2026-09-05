/**
 * A friendlier streaming loader.
 *
 * The indicator shows ping-pong dots, then adds truthful live context when a
 * tool is running: "Read package.json · 3s".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FALLBACK_MESSAGES = [
  "Conjuring",
  "Orchestrating",
  "Deciphering",
  "Distilling",
  "Refining",
  "Triangulating",
  "Excavating",
  "Interrogating",
  "Calibrating",
  "Crosschecking",
  "Untangling",
  "Reframing",
  "Inferring",
  "Synthesizing",
  "Decomposing",
  "Reconciling",
  "Disambiguating",
  "Enumerating",
  "Dissecting",
  "Scaffolding",
  "Navigating",
  "Deriving",
  "Inspecting",
  "Probing",
  "Correlating",
  "Validating",
  "Simulating",
  "Benchmarking",
  "Compiling",
  "Interpreting",
  "Translating",
  "Constructing",
  "Composing",
  "Balancing",
  "Sequencing",
  "Generalizing",
  "Specializing",
  "Contextualizing",
  "Investigating",
  "Reasoning",
  "Optimizing",
  "Resolving",
  "Finalizing",
  "Consolidating",
  "Rechecking",
  "Polishing",
  "Focusing",
  "Deliberating",
  "Contemplating",
  "Marshaling",
];

// A dot travels across a small track, then bounces back. The fixed-width
// frames avoid visual jitter while the loader is being redrawn.
const PING_PONG_DOT_FRAMES = [
  "●····",
  "·●···",
  "··●··",
  "···●·",
  "····●",
  "···●·",
  "··●··",
  "·●···",
];
const MESSAGE_INTERVAL_MS = 3_600;
const SPINNER_INTERVAL_MS = 110;

function shorten(value: unknown, maxLength = 34): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function activityFor(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = shorten(input.path ?? input.file_path ?? input.filename);
  const pattern = shorten(input.pattern ?? input.query);
  const command = shorten(input.command);

  switch (toolName) {
    case "read":
      return path ? `Read ${path}` : "Read files";
    case "write":
      return path ? `Write ${path}` : "Write file";
    case "edit":
      return path ? `Edit ${path}` : "Edit file";
    case "grep":
      return pattern ? `Search ${pattern}` : "Search code";
    case "find":
      return pattern ? `Find ${pattern}` : "Find files";
    case "ls":
      return "Inspect directory";
    case "bash":
    case "powershell":
      return command ? `Run ${command}` : "Run command";
    case "subagent":
      return "Delegate agent";
    case "py_explore":
      return "Explore data";
    case "web_use":
      return "Look up";
    case "ask_question":
      return "Await input";
    default:
      return `Use ${toolName}`;
  }
}

export default function (pi: ExtensionAPI) {
  let messageTimer: ReturnType<typeof setInterval> | undefined;
  let messageIndex = 0;
  let lastMessageChangeAt = 0;
  let turnStartedAt = 0;
  const activeTools = new Map<string, string>();

  function stopMessageRotation(): void {
    if (messageTimer) clearInterval(messageTimer);
    messageTimer = undefined;
  }

  function elapsed(): string {
    return formatDuration(Date.now() - turnStartedAt);
  }

  function latestActivity(): string | undefined {
    return Array.from(activeTools.values()).pop();
  }

  function fallbackMessage(): string {
    return `${FALLBACK_MESSAGES[messageIndex]!}…`;
  }

  function updateMessage(ctx: ExtensionContext): void {
    const activity = latestActivity();
    if (activity) {
      ctx.ui.setWorkingMessage(`${activity} · ${elapsed()}`);
      return;
    }

    if (Date.now() - lastMessageChangeAt >= MESSAGE_INTERVAL_MS) {
      messageIndex = (messageIndex + 1) % FALLBACK_MESSAGES.length;
      lastMessageChangeAt = Date.now();
    }
    ctx.ui.setWorkingMessage(`${fallbackMessage()} · ${elapsed()}`);
  }

  function applyWorkingStyle(ctx: ExtensionContext): void {
    const { theme } = ctx.ui;
    ctx.ui.setWorkingIndicator({
      frames: PING_PONG_DOT_FRAMES.map((frame) => theme.fg("accent", frame)),
      intervalMs: SPINNER_INTERVAL_MS,
    });
    ctx.ui.setWorkingMessage(fallbackMessage());
  }

  function startMessageRotation(ctx: ExtensionContext): void {
    stopMessageRotation();
    activeTools.clear();
    turnStartedAt = Date.now();
    lastMessageChangeAt = turnStartedAt;
    messageIndex = (messageIndex + 1) % FALLBACK_MESSAGES.length;
    updateMessage(ctx);
    messageTimer = setInterval(() => updateMessage(ctx), 1_000);
  }

  pi.on("session_start", async (_event, ctx) => {
    applyWorkingStyle(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    startMessageRotation(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeTools.delete(event.toolCallId);
    activeTools.set(event.toolCallId, activityFor(event.toolName, event.args));
    updateMessage(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeTools.delete(event.toolCallId);
    updateMessage(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopMessageRotation();
    activeTools.clear();
    ctx.ui.setWorkingMessage(`${FALLBACK_MESSAGES[0]!}…`);
  });

  pi.on("session_shutdown", () => {
    stopMessageRotation();
    activeTools.clear();
  });
}
