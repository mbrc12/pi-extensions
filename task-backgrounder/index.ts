/**
 * Task Backgrounder Extension
 *
 * Run shell commands in the background via tmux. Status/output is pulled on
 * demand by task_status. No periodic polling, no injected updates, no pings.
 *
 * Final API:
 *   - Tool: task_start   -> start a background task
 *   - Tool: task_status  -> show one task status/output as a normal tool result
 *   - Tool: task_stop    -> stop a background task
 *   - Tool: task_clear   -> clear tracked task transcripts/output files
 *   - Command: /task-status [name] -> choose/show one task status
 *   - Command: /task-stop <name>   -> stop one task
 *   - Command: /task-clear [all]   -> clear tracked task transcripts
 */

import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type TaskStatus = "running" | "exited" | "error" | "not-found";

interface BackgroundTask {
	name: string;
	command: string;
	cwd: string;
	logFile: string;
	exitFile: string;
	scriptFile: string;
	status: TaskStatus;
	lastOutput: string;
	lastPoll: number;
	tailLines: number;
}

const tasks = new Map<string, BackgroundTask>();

const TaskStartParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
	name: Type.Optional(Type.String({ description: "Unique tmux session name (auto-generated if omitted)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the command (defaults to current project dir)" })),
	tail_lines: Type.Optional(Type.Number({ description: "Default output lines to show when status is pulled", default: 100 })),
});
type TaskStartInput = Static<typeof TaskStartParams>;

const TaskStatusParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Task session name to show. If omitted, prompts the user to choose when possible." })),
	tail_lines: Type.Optional(Type.Number({ description: "Number of output lines to include", default: 100 })),
});
type TaskStatusInput = Static<typeof TaskStatusParams>;

const TaskStopParams = Type.Object({
	name: Type.String({ description: "Task session name to stop" }),
	delete_files: Type.Optional(Type.Boolean({ description: "Delete /tmp log, exit-code, and wrapper script files", default: false })),
});
type TaskStopInput = Static<typeof TaskStopParams>;

const TaskClearParams = Type.Object({
	include_running: Type.Optional(
		Type.Boolean({ description: "Also clear running tasks from tracking/output files", default: false }),
	),
	delete_files: Type.Optional(
		Type.Boolean({ description: "Delete /tmp log, exit-code, and wrapper script files", default: true }),
	),
});
type TaskClearInput = Static<typeof TaskClearParams>;

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

function generateName(): string {
	const ts = Date.now();
	const rand = Math.random().toString(36).slice(2, 6);
	return `pi-task-${ts}-${rand}`;
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readTextFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function deleteIfExists(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// ignore missing files
	}
}

async function execTmux(
	pi: ExtensionAPI,
	args: string[],
	timeout = 5000,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec("tmux", args, { timeout });
}

async function tmuxHasSession(pi: ExtensionAPI, name: string): Promise<boolean> {
	const result = await execTmux(pi, ["has-session", "-t", name], 2000).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
	}));
	return result.code === 0;
}

async function tmuxCapturePane(pi: ExtensionAPI, name: string): Promise<string> {
	const result = await execTmux(pi, ["capture-pane", "-pt", name], 3000).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
	}));
	return result.stdout ?? "";
}

async function tailLog(logFile: string, lines: number): Promise<string> {
	if (!(await fileExists(logFile))) return "";
	const text = await readTextFile(logFile);
	if (!text) return "";
	return text.split("\n").slice(-lines).join("\n");
}

async function fetchTaskState(
	pi: ExtensionAPI,
	name: string,
	tailLines = 100,
): Promise<{ status: TaskStatus; output: string; task?: BackgroundTask }> {
	const task = tasks.get(name);
	const logFile = task?.logFile ?? `/tmp/${name}.log`;
	const exitFile = task?.exitFile ?? `/tmp/${name}.exit`;

	const exit = await readTextFile(exitFile);
	const exists = await tmuxHasSession(pi, name);
	let status: TaskStatus;
	if (exit !== undefined) {
		const code = parseInt(exit.trim(), 10);
		status = Number.isNaN(code) || code !== 0 ? "error" : "exited";
	} else if (exists) {
		status = "running";
	} else {
		status = "not-found";
	}

	let output = await tailLog(logFile, tailLines);
	if (!output && exists) output = await tmuxCapturePane(pi, name);

	if (task) {
		task.status = status;
		task.lastOutput = output;
		task.lastPoll = Date.now();
	}

	return { status, output, task };
}

function formatTaskSnapshot(name: string, status: TaskStatus, output: string, tailChars = 4000): string {
	const snippet = output.slice(-tailChars);
	return `Task: ${name}\nStatus: ${status}\n\nOutput tail:\n\`\`\`\n${snippet || "(no output yet)"}\n\`\`\``;
}

async function taskSummaryLines(pi: ExtensionAPI): Promise<string[]> {
	const rows: string[] = [];
	for (const [name] of tasks) {
		const { status } = await fetchTaskState(pi, name, 1);
		rows.push(`${name}: ${status}`);
	}
	return rows;
}

async function taskSummaryText(pi: ExtensionAPI): Promise<string> {
	const rows = await taskSummaryLines(pi);
	if (rows.length === 0) return "No background tasks are currently tracked.";
	return [
		"Tracked background tasks:",
		...rows.map((row) => `- ${row}`),
		"",
		"Use task_status with a task name, or /task-status to choose one interactively.",
	].join("\n");
}

async function chooseTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (tasks.size === 0) {
		ctx.ui.notify("No background tasks tracked.", "info");
		return undefined;
	}
	const rows = await taskSummaryLines(pi);
	const choice = await ctx.ui.select("Choose background task:", rows);
	if (!choice) return undefined;
	return choice.split(":", 1)[0];
}

async function resolveTaskNameForTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	maybeName?: string,
): Promise<{ name?: string; message?: string }> {
	const requested = maybeName?.trim();
	if (requested) return { name: sanitizeName(requested) };
	if (tasks.size === 0) return { message: "No background tasks are currently tracked." };
	if (tasks.size === 1) return { name: Array.from(tasks.keys())[0] };
	if (!ctx.hasUI) return { message: await taskSummaryText(pi) };
	const picked = await chooseTask(pi, ctx);
	if (!picked) return { message: "No task selected." };
	return { name: picked };
}

async function startTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: TaskStartInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
	const tmuxCheck = await execTmux(pi, ["-V"], 2000).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
	}));
	if (tmuxCheck.code !== 0) {
		throw new Error("tmux is not installed or not available on PATH");
	}

	const name = sanitizeName(params.name?.trim() || generateName());
	const cwd = params.cwd?.trim() || ctx.cwd;
	const tailLines = Math.max(1, params.tail_lines ?? 100);
	const logFile = `/tmp/${name}.log`;
	const exitFile = `/tmp/${name}.exit`;
	const scriptFile = `/tmp/${name}.sh`;

	if (await tmuxHasSession(pi, name)) {
		throw new Error(`A tmux session named "${name}" already exists. Pick a different name or stop it first.`);
	}

	const script = `#!/usr/bin/env bash
set -o pipefail
cd ${quoteShell(cwd)}
${params.command} 2>&1 | tee -a ${quoteShell(logFile)}
echo $? > ${quoteShell(exitFile)}
`;
	await writeFile(scriptFile, script, { mode: 0o755 });

	// Run the wrapper script directly as the tmux pane command instead of opening
	// an interactive shell. This avoids fish/zsh/bash banners and prompt spam.
	const createResult = await execTmux(
		pi,
		["new-session", "-d", "-s", name, "-c", cwd, `exec bash ${quoteShell(scriptFile)}`],
		5000,
	);
	if (createResult.code !== 0) {
		throw new Error(`Failed to create tmux session: ${createResult.stderr || createResult.stdout}`);
	}

	const task: BackgroundTask = {
		name,
		command: params.command,
		cwd,
		logFile,
		exitFile,
		scriptFile,
		status: "running",
		lastOutput: "",
		lastPoll: Date.now(),
		tailLines,
	};
	tasks.set(name, task);

	return {
		content: [
			{
				type: "text",
				text: `Started background task "${name}".\nCommand: ${params.command}\nLog: ${logFile}\nStatus updates: on-demand only. Use task_status({ name: "${name}" }) or /task-status ${name} to check progress.`,
			},
		],
		details: { action: "start", task: { ...task } },
	};
}

async function stopTask(
	pi: ExtensionAPI,
	nameInput: string,
	deleteFiles = false,
): Promise<{ name: string; stopped: boolean; deletedFiles: boolean; message: string }> {
	const name = sanitizeName(nameInput.trim());
	if (!name) return { name, stopped: false, deletedFiles: false, message: "Task name required." };
	const task = tasks.get(name);
	const existed = await tmuxHasSession(pi, name);
	const result = await execTmux(pi, ["kill-session", "-t", name], 5000).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
	}));
	const stopped = existed && result.code === 0;

	tasks.delete(name);
	if (deleteFiles) {
		await deleteIfExists(task?.logFile ?? `/tmp/${name}.log`);
		await deleteIfExists(task?.exitFile ?? `/tmp/${name}.exit`);
		await deleteIfExists(task?.scriptFile ?? `/tmp/${name}.sh`);
	}

	return {
		name,
		stopped,
		deletedFiles: deleteFiles,
		message: stopped
			? `Stopped task "${name}".`
			: `Task "${name}" was not running or could not be stopped; removed from tracking if present.`,
	};
}

async function clearTrackedTasks(
	pi: ExtensionAPI,
	includeRunning = false,
	deleteFiles = true,
): Promise<{ cleared: string[]; skippedRunning: string[] }> {
	const cleared: string[] = [];
	const skippedRunning: string[] = [];
	for (const [name, task] of Array.from(tasks.entries())) {
		const { status } = await fetchTaskState(pi, name, 1);
		if (status === "running" && !includeRunning) {
			skippedRunning.push(name);
			continue;
		}

		tasks.delete(name);
		cleared.push(name);

		if (deleteFiles) {
			await deleteIfExists(task.logFile);
			await deleteIfExists(task.exitFile);
			await deleteIfExists(task.scriptFile);
		}
	}
	return { cleared, skippedRunning };
}

function formatClearResult(result: { cleared: string[]; skippedRunning: string[] }): string {
	const lines: string[] = [];
	lines.push(`Cleared ${result.cleared.length} task transcript(s).`);
	if (result.cleared.length > 0) lines.push(`Cleared: ${result.cleared.join(", ")}`);
	if (result.skippedRunning.length > 0) {
		lines.push(
			`Skipped running task(s): ${result.skippedRunning.join(", ")}. Use include_running:true or /task-clear all to clear them from tracking too, or task_stop//task-stop to stop them.`,
		);
	}
	return lines.join("\n");
}

function reconstructState(ctx: ExtensionContext): void {
	tasks.clear();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
		if (msg.role !== "toolResult") continue;

		// Current API stores start details as { action: "start", task }. Legacy support
		// also accepts old background_task details with task fields at top-level.
		if (msg.toolName === "task_start") {
			const details = msg.details as { action?: string; task?: BackgroundTask } | undefined;
			if (details?.task?.name) tasks.set(details.task.name, details.task);
		} else if (msg.toolName === "background_task") {
			const legacy = msg.details as Partial<BackgroundTask> | undefined;
			if (legacy?.name && legacy.command && legacy.cwd && legacy.logFile && legacy.exitFile) {
				tasks.set(legacy.name, {
					name: legacy.name,
					command: legacy.command,
					cwd: legacy.cwd,
					logFile: legacy.logFile,
					exitFile: legacy.exitFile,
					scriptFile: legacy.scriptFile ?? `/tmp/${legacy.name}.sh`,
					status: legacy.status ?? "running",
					lastOutput: "",
					lastPoll: Date.now(),
					tailLines: legacy.tailLines ?? 100,
				});
			}
		} else if (msg.toolName === "task_stop") {
			const details = msg.details as { name?: string } | undefined;
			if (details?.name) tasks.delete(details.name);
		} else if (msg.toolName === "task_clear") {
			const details = msg.details as { cleared?: string[] } | undefined;
			for (const name of details?.cleared ?? []) tasks.delete(name);
		}
	}
}

export default function taskBackgrounderExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		if (ctx.hasUI && tasks.size > 0) {
			ctx.ui.notify(`Tracking ${tasks.size} background task(s).`, "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// --- task_start tool ------------------------------------------------------
	pi.registerTool({
		name: "task_start",
		label: "Task Start",
		description:
			"Start a long-running shell command in a detached tmux session. Status/output is pulled on demand with task_status; no periodic updates are injected.",
		promptSnippet: "Start a shell command in the background via tmux",
		promptGuidelines: [
			"Use task_start when the user asks you to run a long-running command that would block the agent.",
			"task_start creates a named tmux session; choose a descriptive name or let it auto-generate one.",
			"task_start never emits periodic updates. Use task_status to show one task's output on demand.",
		],
		parameters: TaskStartParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return startTask(pi, ctx, params);
		},
	});

	// --- task_status tool -----------------------------------------------------
	pi.registerTool({
		name: "task_status",
		label: "Task Status",
		description:
			"Show the current status and output tail for one background task. If no name is supplied and multiple tasks exist, prompts the user to choose.",
		promptSnippet: "Show one background task's status and output tail",
		promptGuidelines: [
			"Use task_status when the user asks to see the output/status of a background task.",
			"task_status returns one task transcript as a normal tool result; it does not inject or rewrite conversation history.",
		],
		parameters: TaskStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = await resolveTaskNameForTool(pi, ctx, params.name);
			if (!resolved.name) {
				return {
					content: [{ type: "text", text: resolved.message ?? "No task selected." }],
					details: { tasks: Array.from(tasks.keys()) },
				};
			}
			const tailLines = Math.max(1, params.tail_lines ?? 100);
			const { status, output } = await fetchTaskState(pi, resolved.name, tailLines);
			return {
				content: [{ type: "text", text: formatTaskSnapshot(resolved.name, status, output, 4000) }],
				details: { name: resolved.name, status, output },
			};
		},
	});

	// --- task_stop tool -------------------------------------------------------
	pi.registerTool({
		name: "task_stop",
		label: "Task Stop",
		description: "Stop a background task by tmux session name and remove it from tracking.",
		promptSnippet: "Stop a background task by name",
		promptGuidelines: [
			"Use task_stop when the user asks to stop or kill a background task.",
		],
		parameters: TaskStopParams,
		async execute(_toolCallId, params) {
			const result = await stopTask(pi, params.name, params.delete_files ?? false);
			return { content: [{ type: "text", text: result.message }], details: result };
		},
	});

	// --- task_clear tool ------------------------------------------------------
	pi.registerTool({
		name: "task_clear",
		label: "Task Clear",
		description:
			"Clear tracked background task transcripts and output files. By default skips running tasks.",
		promptSnippet: "Clear tracked background task transcripts/output files",
		promptGuidelines: [
			"Use task_clear when the user asks to clear old background-task state or transcripts.",
			"task_clear skips running tasks unless include_running:true is explicitly requested.",
		],
		parameters: TaskClearParams,
		async execute(_toolCallId, params) {
			const result = await clearTrackedTasks(
				pi,
				params.include_running ?? false,
				params.delete_files ?? true,
			);
			return {
				content: [{ type: "text", text: formatClearResult(result) }],
				details: result,
			};
		},
	});

	// --- User-facing commands ------------------------------------------------
	const showTaskStatus = async (args: string, ctx: ExtensionContext) => {
		let name = args.trim();
		if (!name) {
			const picked = await chooseTask(pi, ctx);
			if (!picked) return;
			name = picked;
		}
		const sanitized = sanitizeName(name);
		const { status, output } = await fetchTaskState(pi, sanitized, 100);
		ctx.ui.notify(formatTaskSnapshot(sanitized, status, output, 4000), "info");
	};

	pi.registerCommand("task-status", {
		description: "Choose a background task and show its status/output tail",
		handler: showTaskStatus,
	});

	pi.registerCommand("task-stop", {
		description: "Stop a background task by tmux session name",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /task-stop <session-name>", "error");
				return;
			}
			const result = await stopTask(pi, name, false);
			ctx.ui.notify(result.message, result.stopped ? "info" : "warning");
		},
	});

	pi.registerCommand("task-clear", {
		description: "Clear tracked task transcripts. Use '/task-clear all' to include running tasks.",
		handler: async (args, ctx) => {
			const normalized = args.trim().toLowerCase();
			const includeRunning = normalized === "all" || normalized.includes("--all");
			if (includeRunning) {
				const ok = await ctx.ui.confirm(
					"Clear running tasks too?",
					"This removes them from tracking and deletes output files, but does not kill tmux sessions. Use /task-stop to kill a task.",
				);
				if (!ok) return;
			}
			const result = await clearTrackedTasks(pi, includeRunning, true);
			ctx.ui.notify(formatClearResult(result), "info");
		},
	});

	pi.registerCommand("task-list", {
		description: "List known background tasks and their statuses",
		handler: async (_args, ctx) => {
			const rows = await taskSummaryLines(pi);
			ctx.ui.notify(rows.join("\n") || "No background tasks tracked.", "info");
		},
	});
}
