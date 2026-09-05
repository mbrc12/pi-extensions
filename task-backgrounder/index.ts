/**
 * Task Backgrounder Extension
 *
 * Run shell commands in the background via tmux. Status/output can be pulled
 * on demand, and one durable message is injected when a task reaches a terminal
 * state so the agent can continue without manual polling.
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

import { randomUUID } from "node:crypto";
import { access, open, readFile, unlink, writeFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Container, Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const DEFAULT_TAIL_LINES = 10;
const MONITOR_INTERVAL_MS = 1000;
const COMPLETION_BATCH_DELAY_MS = 200;
const MAX_STATUS_OUTPUT_BYTES = 48 * 1024;
const LOG_READ_CHUNK_BYTES = 16 * 1024;
const TASK_STATE_ENTRY_TYPE = "task-backgrounder-state";
const TASK_COMPLETION_MESSAGE_TYPE = "task-completion";
const TASK_COMPLETION_WAKE_TYPE = "task-completion-wake";
const TASK_STATUS_KEY = "task-backgrounder";

type TaskStatus = "running" | "exited" | "error" | "stopped" | "not-found";
type TaskOutcome = "succeeded" | "failed" | "stopped" | "lost";

interface BackgroundTask {
	taskId: string;
	name: string;
	tmuxSession: string;
	command: string;
	cwd: string;
	logFile: string;
	exitFile: string;
	scriptFile: string;
	startedAt: number;
	status: TaskStatus;
	terminalOutcome?: TaskOutcome;
	terminalExitCode?: number;
	lastOutput: string;
	lastPoll: number;
	tailLines: number;
}

interface TaskStateSnapshot {
	status: TaskStatus;
	output: string;
	exitCode?: number;
	task?: BackgroundTask;
}

interface TaskCompletion {
	taskId: string;
	name: string;
	outcome: TaskOutcome;
	exitCode?: number;
	finishedAt: number;
	artifactsAvailable: boolean;
}

interface StopTaskResult {
	name: string;
	stopped: boolean;
	deletedFiles: boolean;
	message: string;
	taskId?: string;
	removedFromTracking: boolean;
	completion?: TaskCompletion;
}

interface ClearTasksResult {
	cleared: string[];
	clearedTasks: Array<{ name: string; taskId: string }>;
	skippedRunning: string[];
	completions: TaskCompletion[];
}

const tasks = new Map<string, BackgroundTask>();
const notifiedTaskIds = new Set<string>();

const TaskStartParams = Type.Object({
	command: Type.String({ description: "Shell command to run in the background" }),
	name: Type.Optional(Type.String({ description: "Unique task name (auto-generated if omitted)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the command (defaults to current project dir)" })),
	tail_lines: Type.Optional(Type.Number({ description: "Default output lines to show when status is pulled (nonblank); use more if requested", default: DEFAULT_TAIL_LINES })),
});
type TaskStartInput = Static<typeof TaskStartParams>;

const TaskStatusParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Task name to show. If omitted, prompts the user to choose when possible." })),
	tail_lines: Type.Optional(Type.Number({ description: "Number of nonblank output lines to include; defaults to the value chosen by task_start" })),
});
type TaskStatusInput = Static<typeof TaskStatusParams>;

const TaskStopParams = Type.Object({
	name: Type.String({ description: "Task name to stop" }),
	delete_files: Type.Optional(Type.Boolean({ description: "Delete /tmp log, exit-code, and wrapper script files", default: false })),
});
type TaskStopInput = Static<typeof TaskStopParams>;

const TaskClearParams = Type.Object({
	include_running: Type.Optional(
		Type.Boolean({ description: "Also stop running tasks before clearing them", default: false }),
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

function legacyTaskId(task: Pick<BackgroundTask, "name" | "scriptFile">): string {
	return `legacy:${task.name}:${task.scriptFile}`;
}

function normalizeTask(value: Partial<BackgroundTask> | undefined): BackgroundTask | undefined {
	if (!value?.name || !value.command || !value.cwd || !value.logFile || !value.exitFile) return undefined;
	const scriptFile = value.scriptFile ?? `/tmp/${value.name}.sh`;
	return {
		taskId: value.taskId ?? legacyTaskId({ name: value.name, scriptFile }),
		name: value.name,
		tmuxSession: value.tmuxSession ?? value.name,
		command: value.command,
		cwd: value.cwd,
		logFile: value.logFile,
		exitFile: value.exitFile,
		scriptFile,
		startedAt: value.startedAt ?? value.lastPoll ?? Date.now(),
		status: value.status ?? "running",
		terminalOutcome: value.terminalOutcome,
		terminalExitCode: value.terminalExitCode,
		lastOutput: value.lastOutput ?? "",
		lastPoll: value.lastPoll ?? Date.now(),
		tailLines: value.tailLines ?? DEFAULT_TAIL_LINES,
	};
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
		// Ignore missing files.
	}
}

async function deleteTaskFiles(task: BackgroundTask): Promise<void> {
	await Promise.all([
		deleteIfExists(task.logFile),
		deleteIfExists(task.exitFile),
		deleteIfExists(`${task.exitFile}.tmp`),
		deleteIfExists(task.scriptFile),
	]);
}

async function execTmux(
	pi: ExtensionAPI,
	args: string[],
	timeout = 5000,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return pi.exec("tmux", args, { timeout });
}

async function tmuxSessionState(pi: ExtensionAPI, name: string): Promise<"present" | "absent" | "unknown"> {
	const result = await execTmux(pi, ["has-session", "-t", `=${name}`], 2000).catch(() => undefined);
	if (!result) return "unknown";
	if (result.code === 0) return "present";
	if (result.code === 1) return "absent";
	return "unknown";
}

async function tmuxHasSession(pi: ExtensionAPI, name: string): Promise<boolean> {
	return await tmuxSessionState(pi, name) === "present";
}

async function tmuxCapturePane(pi: ExtensionAPI, name: string): Promise<string> {
	const result = await execTmux(pi, ["capture-pane", "-pt", `=${name}`], 3000).catch(() => ({
		stdout: "",
		stderr: "",
		code: 1,
	}));
	return result.stdout ?? "";
}

async function tailLog(logFile: string, lines: number): Promise<string> {
	if (lines <= 0 || !(await fileExists(logFile))) return "";
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(logFile, "r");
		const { size } = await handle.stat();
		let position = size;
		let bytesRead = 0;
		const chunks: Buffer[] = [];
		let nonBlank: string[] = [];

		while (position > 0 && bytesRead < MAX_STATUS_OUTPUT_BYTES) {
			const length = Math.min(LOG_READ_CHUNK_BYTES, position, MAX_STATUS_OUTPUT_BYTES - bytesRead);
			position -= length;
			const chunk = Buffer.allocUnsafe(length);
			const result = await handle.read(chunk, 0, length, position);
			chunks.unshift(chunk.subarray(0, result.bytesRead));
			bytesRead += result.bytesRead;
			const text = Buffer.concat(chunks).toString("utf8");
			nonBlank = text.split("\n").filter((line) => line.trim() !== "");
			if (nonBlank.length > lines) break;
		}

		const output = nonBlank.slice(-lines).join("\n");
		const truncated = position > 0 && nonBlank.length <= lines;
		return truncated ? `[output tail truncated to ${MAX_STATUS_OUTPUT_BYTES / 1024}KB]\n${output}` : output;
	} catch {
		return "";
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function statusForOutcome(outcome: TaskOutcome): TaskStatus {
	if (outcome === "succeeded") return "exited";
	if (outcome === "failed") return "error";
	if (outcome === "stopped") return "stopped";
	return "not-found";
}

async function fetchTaskState(
	pi: ExtensionAPI,
	name: string,
	tailLines = DEFAULT_TAIL_LINES,
): Promise<TaskStateSnapshot> {
	const task = tasks.get(name);
	const tmuxSession = task?.tmuxSession ?? name;
	const logFile = task?.logFile ?? `/tmp/${name}.log`;
	if (task?.terminalOutcome) {
		const output = await tailLog(logFile, tailLines);
		const status = statusForOutcome(task.terminalOutcome);
		task.status = status;
		task.lastOutput = output;
		task.lastPoll = Date.now();
		return { status, output, exitCode: task.terminalExitCode, task };
	}
	const exitFile = task?.exitFile ?? `/tmp/${name}.exit`;

	const exit = await readTextFile(exitFile);
	let status: TaskStatus;
	let exitCode: number | undefined;
	let exists = false;
	if (exit !== undefined) {
		const trimmed = exit.trim();
		if (/^\d+$/.test(trimmed)) exitCode = Number(trimmed);
		status = exitCode === 0 ? "exited" : "error";
	} else {
		const tmuxState = await tmuxSessionState(pi, tmuxSession);
		exists = tmuxState === "present";
		if (tmuxState === "absent") {
			// The wrapper writes its exit file before tmux removes the session. Read
			// again after the tmux probe to close that transition race.
			const finalExit = await readTextFile(exitFile);
			if (finalExit !== undefined) {
				const trimmed = finalExit.trim();
				if (/^\d+$/.test(trimmed)) exitCode = Number(trimmed);
				status = exitCode === 0 ? "exited" : "error";
			} else {
				status = "not-found";
			}
		} else {
			// Treat tmux operational failures as transient. A later scan will retry.
			status = "running";
		}
	}

	let output = await tailLog(logFile, tailLines);
	if (tailLines > 0 && !output && exists) output = await tmuxCapturePane(pi, tmuxSession);

	if (task) {
		task.status = status;
		task.lastOutput = output;
		task.lastPoll = Date.now();
	}

	return { status, output, exitCode, task };
}

function formatTaskSnapshot(
	name: string,
	status: TaskStatus,
	output: string,
	exitCode?: number,
	tailChars = MAX_STATUS_OUTPUT_BYTES,
): string {
	const snippet = output.slice(-tailChars);
	const exitLine = exitCode === undefined ? "" : `\nExit code: ${exitCode}`;
	return `Task: ${name}\nStatus: ${status}${exitLine}\n\nOutput tail:\n\`\`\`\n${snippet || "(no output yet)"}\n\`\`\``;
}

async function taskSummaryLines(pi: ExtensionAPI): Promise<string[]> {
	const rows: string[] = [];
	for (const [name] of tasks) {
		const { status } = await fetchTaskState(pi, name, 0);
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
	if (!name) throw new Error("Task name must contain at least one letter, number, underscore, or hyphen");
	const taskId = randomUUID();
	const tmuxSession = `${name.slice(0, 55)}-${taskId.slice(0, 8)}`;
	const cwd = params.cwd?.trim() || ctx.cwd;
	const tailLines = Math.max(1, params.tail_lines ?? DEFAULT_TAIL_LINES);
	const fileStem = `/tmp/pi-task-${taskId}`;
	const logFile = `${fileStem}.log`;
	const exitFile = `${fileStem}.exit`;
	const exitTempFile = `${exitFile}.tmp`;
	const scriptFile = `${fileStem}.sh`;

	if (tasks.has(name)) {
		throw new Error(`A task named "${name}" is already tracked. Clear it before reusing the name.`);
	}
	if (await tmuxHasSession(pi, tmuxSession)) {
		throw new Error(`The internal tmux session for task "${name}" already exists. Pick a different name.`);
	}

	const script = `#!/usr/bin/env bash
umask 077
set -o pipefail
record_exit() {
	local code="$1"
	printf '%s\\n' "$code" > ${quoteShell(exitTempFile)} && mv -f ${quoteShell(exitTempFile)} ${quoteShell(exitFile)}
}
finish() {
	record_exit "$1"
}
cd ${quoteShell(cwd)}
cd_code=$?
if [ "$cd_code" -ne 0 ]; then
	finish "$cd_code"
	exit "$cd_code"
fi
bash -c ${quoteShell(params.command)} 2>&1 | tee -a ${quoteShell(logFile)}
exit_code=\${PIPESTATUS[0]}
finish "$exit_code"
exit "$exit_code"
`;
	await writeFile(logFile, "", { mode: 0o600 });
	await writeFile(scriptFile, script, { mode: 0o700 });

	// Run the wrapper script directly as the tmux pane command instead of opening
	// an interactive shell. This avoids fish/zsh/bash banners and prompt spam.
	const createResult = await execTmux(
		pi,
		["new-session", "-d", "-s", tmuxSession, "-c", cwd, `exec bash ${quoteShell(scriptFile)}`],
		5000,
	);
	if (createResult.code !== 0) {
		await Promise.all([deleteIfExists(logFile), deleteIfExists(scriptFile)]);
		throw new Error(`Failed to create tmux session: ${createResult.stderr || createResult.stdout}`);
	}

	const task: BackgroundTask = {
		taskId,
		name,
		tmuxSession,
		command: params.command,
		cwd,
		logFile,
		exitFile,
		scriptFile,
		startedAt: Date.now(),
		status: "running",
		lastOutput: "",
		lastPoll: Date.now(),
		tailLines,
	};
	tasks.set(name, task);
	pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "start", task: { ...task } });

	return {
		content: [
			{
				type: "text",
				text: `Started background task "${name}".\nCommand: ${params.command}\nLog: ${logFile}\nPi will notify you when the task finishes. Use task_status({ name: "${name}" }) or /task-status ${name} for an earlier update.`,
			},
		],
		details: { action: "start", task: { ...task } },
	};
}

function completionFromSnapshot(
	task: BackgroundTask,
	snapshot: TaskStateSnapshot,
	outcome?: TaskOutcome,
): TaskCompletion | undefined {
	const resolvedOutcome = outcome ?? task.terminalOutcome ?? (snapshot.status === "exited"
		? "succeeded"
		: snapshot.status === "error"
			? "failed"
			: snapshot.status === "not-found"
				? "lost"
				: undefined);
	if (!resolvedOutcome) return undefined;
	return {
		taskId: task.taskId,
		name: task.name,
		outcome: resolvedOutcome,
		exitCode: snapshot.exitCode,
		finishedAt: Date.now(),
		artifactsAvailable: true,
	};
}

async function stopTask(
	pi: ExtensionAPI,
	nameInput: string,
	deleteFiles = false,
): Promise<StopTaskResult> {
	const name = sanitizeName(nameInput.trim());
	if (!name) {
		return {
			name,
			stopped: false,
			deletedFiles: false,
			removedFromTracking: false,
			message: "Task name required.",
		};
	}
	const task = tasks.get(name);
	const targetSession = task?.tmuxSession;
	const before = task ? await fetchTaskState(pi, name, 0) : undefined;
	const existed = before?.status === "running";
	let stopped = false;
	if (existed) {
		const result = await execTmux(pi, ["kill-session", "-t", `=${targetSession}`], 5000).catch(() => ({
			stdout: "",
			stderr: "",
			code: 1,
		}));
		stopped = result.code === 0;
	}

	let completion: TaskCompletion | undefined;
	if (task && before) {
		if (before.status !== "running") {
			completion = completionFromSnapshot(task, before);
		} else {
			const after = await fetchTaskState(pi, name, 0);
			completion = after.status === "exited" || after.status === "error"
				? completionFromSnapshot(task, after)
				: stopped
					? completionFromSnapshot(task, after, "stopped")
					: completionFromSnapshot(task, after);
		}
	}

	let removedFromTracking = false;
	let stillTracked = task !== undefined && tasks.get(name)?.taskId === task.taskId;
	if (task && completion) {
		task.terminalOutcome = completion.outcome;
		task.terminalExitCode = completion.exitCode;
		task.status = statusForOutcome(completion.outcome);
		if (!stillTracked || deleteFiles) {
			completion.artifactsAvailable = false;
			if (stillTracked) tasks.delete(name);
			pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "stop", name, taskId: task.taskId });
			if (deleteFiles) await deleteTaskFiles(task);
			removedFromTracking = true;
			stillTracked = false;
		} else {
			pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "terminal", task: { ...task } });
		}
	}

	const message = stopped
		? task
			? stillTracked
				? `Stopped task "${name}". It remains tracked so its output can be inspected and cleared.`
				: deleteFiles
					? `Stopped task "${name}" and deleted its temporary files.`
					: `Stopped task "${name}". It is no longer tracked.`
			: `Task "${name}" is not tracked by this Pi session.`
		: task && !completion
			? `Task "${name}" could not be stopped${stillTracked ? " and remains tracked" : ""}.`
			: task && stillTracked
				? `Task "${name}" had already finished and remains tracked for inspection and cleanup.`
				: task
					? `Task "${name}" had already finished and is no longer tracked.`
					: `Task "${name}" was not running or tracked.`;

	return {
		name,
		stopped,
		deletedFiles: deleteFiles && removedFromTracking,
		removedFromTracking,
		message,
		taskId: task?.taskId,
		completion,
	};
}

async function clearTrackedTasks(
	pi: ExtensionAPI,
	includeRunning = false,
	deleteFiles = true,
): Promise<ClearTasksResult> {
	const cleared: string[] = [];
	const clearedTasks: Array<{ name: string; taskId: string }> = [];
	const skippedRunning: string[] = [];
	const completions: TaskCompletion[] = [];
	for (const [name, task] of Array.from(tasks.entries())) {
		const snapshot = await fetchTaskState(pi, name, 0);
		const { status } = snapshot;
		if (status === "running") {
			if (!includeRunning) {
				skippedRunning.push(name);
				continue;
			}
			const stopped = await stopTask(pi, name, deleteFiles);
			if (!stopped.completion) {
				skippedRunning.push(name);
				continue;
			}
			stopped.completion.artifactsAvailable = false;
			completions.push(stopped.completion);
			cleared.push(name);
			clearedTasks.push({ name, taskId: task.taskId });
			if (!deleteFiles && tasks.get(name)?.taskId === task.taskId) tasks.delete(name);
			continue;
		}
		if (tasks.get(name)?.taskId !== task.taskId) continue;

		cleared.push(name);
		clearedTasks.push({ name, taskId: task.taskId });
		const completion = completionFromSnapshot(task, snapshot);
		if (completion) {
			completion.artifactsAvailable = false;
			completions.push(completion);
		}
		if (deleteFiles) await deleteTaskFiles(task);
		if (tasks.get(name)?.taskId === task.taskId) tasks.delete(name);
	}
	if (cleared.length > 0) {
		pi.appendEntry(TASK_STATE_ENTRY_TYPE, {
			action: "clear",
			cleared: [...cleared],
			clearedTasks: [...clearedTasks],
		});
	}
	return { cleared, clearedTasks, skippedRunning, completions };
}

function formatClearResult(result: ClearTasksResult): string {
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

function statusColor(status: TaskStatus): ThemeColor {
	switch (status) {
		case "running":
			return "accent";
		case "exited":
			return "success";
		case "error":
			return "error";
		case "stopped":
			return "warning";
		default:
			return "muted";
	}
}

class TaskStatusResultComponent extends Container {
	constructor(
		private name: string,
		private status: TaskStatus,
		private output: string,
		expanded: boolean,
		private theme: Theme,
	) {
		super();
		this.rebuild(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.rebuild(expanded);
	}

	private rebuild(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(this.theme.fg("toolTitle", `Task: ${this.name}`), 0, 0));
		this.addChild(new Text(this.theme.fg(statusColor(this.status), `Status: ${this.status}`), 0, 0));
		if (expanded && this.output) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(this.theme.fg("toolOutput", this.output), 0, 0));
		}
	}
}

/** A temporary /task-status view that the user dismisses with Escape. */
class TaskStatusDialogComponent extends Container {
	constructor(
		private name: string,
		private status: TaskStatus,
		private output: string,
		private theme: Theme,
		private onClose: () => void,
	) {
		super();
		this.rebuild();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.onClose();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(` Task status: ${this.name} `)), 1, 0));
		this.addChild(new Text(this.theme.fg(statusColor(this.status), `Status: ${this.status}`), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("toolOutput", this.output || "(no output yet)"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", "Press Escape to close"), 1, 0));
		this.addChild(new Spacer(1));
	}
}

function reconstructState(ctx: ExtensionContext): TaskCompletion[] {
	tasks.clear();
	notifiedTaskIds.clear();
	const pendingCompletions = new Map<string, TaskCompletion>();
	const deletedArtifactTaskIds = new Set<string>();
	const durableStartTaskIds = new Set<string>();

	const restoreTask = (raw: Partial<BackgroundTask> | undefined): BackgroundTask | undefined => {
		const task = normalizeTask(raw);
		if (task) tasks.set(task.name, task);
		return task;
	};
	const clearNames = (names: string[] | undefined): void => {
		for (const name of names ?? []) tasks.delete(name);
	};
	const clearTaskIds = (clearedTasks: Array<{ name: string; taskId?: string }> | undefined): void => {
		for (const cleared of clearedTasks ?? []) {
			const current = tasks.get(cleared.name);
			if (!cleared.taskId || current?.taskId === cleared.taskId) tasks.delete(cleared.name);
		}
	};

	// Walk the full session history, not just the active branch, so that tree
	// navigation cannot drop live tasks or repeat completion notifications.
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === TASK_STATE_ENTRY_TYPE) {
			const data = entry.data as {
				action?: "start" | "terminal" | "stop" | "clear" | "completion-pending" | "artifacts-unavailable";
				task?: Partial<BackgroundTask>;
				name?: string;
				taskId?: string;
				cleared?: string[];
				clearedTasks?: Array<{ name: string; taskId?: string }>;
				completion?: TaskCompletion;
				taskIds?: string[];
			} | undefined;
			if (data?.action === "start") {
				const task = restoreTask(data.task);
				if (task) durableStartTaskIds.add(task.taskId);
			} else if (data?.action === "terminal") restoreTask(data.task);
			else if (data?.action === "stop" && data.name) {
				const current = tasks.get(data.name);
				if (!data.taskId || current?.taskId === data.taskId) tasks.delete(data.name);
			} else if (data?.action === "clear") {
				if (data.clearedTasks) clearTaskIds(data.clearedTasks);
				else clearNames(data.cleared);
			}
			else if (data?.action === "completion-pending" && data.completion?.taskId) {
				const completion = { ...data.completion };
				if (deletedArtifactTaskIds.has(completion.taskId)) completion.artifactsAvailable = false;
				pendingCompletions.set(completion.taskId, completion);
			} else if (data?.action === "artifacts-unavailable") {
				for (const taskId of data.taskIds ?? []) {
					deletedArtifactTaskIds.add(taskId);
					const pending = pendingCompletions.get(taskId);
					if (pending) pending.artifactsAvailable = false;
				}
			}
			continue;
		}

		if (entry.type === "custom_message" && entry.customType === TASK_COMPLETION_MESSAGE_TYPE) {
			const details = entry.details as { completions?: Array<{ taskId?: string }> } | undefined;
			for (const completion of details?.completions ?? []) {
				if (!completion.taskId) continue;
				notifiedTaskIds.add(completion.taskId);
				pendingCompletions.delete(completion.taskId);
			}
			continue;
		}

		if (entry.type !== "message") continue;
		const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
		if (msg.role !== "toolResult") continue;

		// Tool details retain compatibility with sessions created before durable
		// task-state entries were added.
		if (msg.toolName === "task_start") {
			const details = msg.details as { task?: Partial<BackgroundTask> } | undefined;
			const task = normalizeTask(details?.task);
			if (task && !durableStartTaskIds.has(task.taskId)) tasks.set(task.name, task);
		} else if (msg.toolName === "background_task") {
			restoreTask(msg.details as Partial<BackgroundTask> | undefined);
		} else if (msg.toolName === "task_stop") {
			const details = msg.details as {
				name?: string;
				taskId?: string;
				removedFromTracking?: boolean;
			} | undefined;
			// New stop results keep task metadata unless files were explicitly
			// deleted. Legacy results did not include this flag and always removed it.
			if (details?.name && details.removedFromTracking !== false) {
				const current = tasks.get(details.name);
				if (!details.taskId || current?.taskId === details.taskId) tasks.delete(details.name);
			}
		} else if (msg.toolName === "task_clear") {
			const details = msg.details as {
				cleared?: string[];
				clearedTasks?: Array<{ name: string; taskId?: string }>;
			} | undefined;
			if (details?.clearedTasks) clearTaskIds(details.clearedTasks);
			else clearNames(details?.cleared);
		}
	}
	return Array.from(pendingCompletions.values()).filter(
		(completion) => !notifiedTaskIds.has(completion.taskId),
	);
}

function formatCompletionMessage(completions: TaskCompletion[]): string {
	const lines = [
		completions.length === 1 ? "A background task reached a terminal state:" : "Background tasks reached terminal states:",
	];
	for (const completion of completions) {
		const exit = completion.exitCode === undefined ? "" : ` (exit code ${completion.exitCode})`;
		lines.push(`- ${completion.name}: ${completion.outcome}${exit}`);
	}
	lines.push("");
	if (completions.some((completion) => completion.artifactsAvailable)) {
		lines.push(
			"Use task_status to inspect output for tasks whose files remain, then continue the user's work. Call task_clear when those files are no longer needed.",
		);
	} else {
		lines.push("Output is no longer available through the task tools. Continue the user's work using the status above.");
	}
	return lines.join("\n");
}

export default function taskBackgrounderExtension(pi: ExtensionAPI): void {
	const queuedCompletions = new Map<string, TaskCompletion>();
	const stoppingTaskIds = new Set<string>();
	const startingTaskNames = new Set<string>();
	let monitorTimer: ReturnType<typeof setTimeout> | undefined;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let monitorScanning = false;
	let disposed = false;
	let currentCtx: ExtensionContext | undefined;

	const updateTaskStatus = (ctx = currentCtx): void => {
		if (!ctx) return;
		let completed = 0;
		let failed = 0;
		for (const task of tasks.values()) {
			if (task.terminalOutcome === "succeeded" || task.status === "exited") completed++;
			else if (task.terminalOutcome === "failed" || task.status === "error") failed++;
		}
		const theme = ctx.ui.theme;
		const status =
			theme.fg("accent", "⚙️") +
			"\u00a0 " +
			theme.fg("success", String(completed)) +
			theme.fg("accent", "+") +
			theme.fg("error", String(failed)) +
			theme.fg("accent", `/${tasks.size}`);
		ctx.ui.setStatus(TASK_STATUS_KEY, status);
	};

	const clearMonitorTimer = (): void => {
		if (monitorTimer) clearTimeout(monitorTimer);
		monitorTimer = undefined;
	};

	const clearCompletionTimer = (): void => {
		if (completionTimer) clearTimeout(completionTimer);
		completionTimer = undefined;
	};

	const flushCompletions = (): void => {
		completionTimer = undefined;
		if (disposed || queuedCompletions.size === 0) return;
		const completions = Array.from(queuedCompletions.values());
		queuedCompletions.clear();
		try {
			// Persist the visible status message before requesting a new model turn.
			// This path appends synchronously even if the agent is currently busy.
			pi.sendMessage(
				{
					customType: TASK_COMPLETION_MESSAGE_TYPE,
					content: formatCompletionMessage(completions),
					display: true,
					details: { completions },
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		} catch {
			if (disposed) return;
			for (const completion of completions) queuedCompletions.set(completion.taskId, completion);
			completionTimer = setTimeout(flushCompletions, MONITOR_INTERVAL_MS);
			return;
		}

		for (const completion of completions) notifiedTaskIds.add(completion.taskId);
		if (currentCtx?.model === undefined) return;
		try {
			pi.sendMessage(
				{
					customType: TASK_COMPLETION_WAKE_TYPE,
					content: "Review the background-task completion status immediately before this message and continue the user's work.",
					display: false,
					details: { taskIds: completions.map((completion) => completion.taskId) },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// The durable visible message is already in the session. The agent will
			// see it on its next turn even if this wake request cannot be queued.
		}
	};

	const queueCompletion = (completion: TaskCompletion | undefined, persist = true): void => {
		if (!completion || notifiedTaskIds.has(completion.taskId) || queuedCompletions.has(completion.taskId)) return;
		if (persist) {
			pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "completion-pending", completion });
		}
		queuedCompletions.set(completion.taskId, completion);
		if (!completionTimer) completionTimer = setTimeout(flushCompletions, COMPLETION_BATCH_DELAY_MS);
	};

	const markArtifactsUnavailable = (taskIds: string[]): void => {
		const pendingIds = taskIds.filter((taskId) => !notifiedTaskIds.has(taskId));
		if (pendingIds.length === 0) return;
		for (const taskId of pendingIds) {
			const queued = queuedCompletions.get(taskId);
			if (queued) queued.artifactsAvailable = false;
		}
		pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "artifacts-unavailable", taskIds: pendingIds });
	};

	const startAndMonitor = async (ctx: ExtensionContext, params: TaskStartInput) => {
		const name = sanitizeName(params.name?.trim() || generateName());
		if (!name) throw new Error("Task name must contain at least one letter, number, underscore, or hyphen");
		if (startingTaskNames.has(name) || tasks.has(name)) {
			throw new Error(`A task named "${name}" is already starting or tracked. Clear it before reusing the name.`);
		}
		startingTaskNames.add(name);
		try {
			const result = await startTask(pi, ctx, { ...params, name });
			updateTaskStatus(ctx);
			ensureMonitor();
			return result;
		} finally {
			startingTaskNames.delete(name);
		}
	};

	const observeSnapshot = (snapshot: TaskStateSnapshot): void => {
		const task = snapshot.task;
		if (!task || snapshot.status === "running" || stoppingTaskIds.has(task.taskId)) return;
		const completion = completionFromSnapshot(task, snapshot);
		if (!completion) return;
		const stillTracked = tasks.get(task.name)?.taskId === task.taskId;
		if (!stillTracked) completion.artifactsAvailable = false;
		if (!task.terminalOutcome && stillTracked) {
			task.terminalOutcome = completion.outcome;
			task.terminalExitCode = completion.exitCode;
			task.status = statusForOutcome(completion.outcome);
			pi.appendEntry(TASK_STATE_ENTRY_TYPE, { action: "terminal", task: { ...task } });
		}
		updateTaskStatus();
		queueCompletion(completion);
	};

	const stopAndNotify = async (name: string, deleteFiles: boolean): Promise<StopTaskResult> => {
		const taskId = tasks.get(sanitizeName(name.trim()))?.taskId;
		if (taskId) stoppingTaskIds.add(taskId);
		try {
			const result = await stopTask(pi, name, deleteFiles);
			if (result.deletedFiles && result.taskId) markArtifactsUnavailable([result.taskId]);
			queueCompletion(result.completion);
			updateTaskStatus();
			return result;
		} finally {
			if (taskId) stoppingTaskIds.delete(taskId);
			ensureMonitor();
		}
	};

	const clearAndNotify = async (includeRunning: boolean, deleteFiles: boolean): Promise<ClearTasksResult> => {
		const taskIds = Array.from(tasks.values(), (task) => task.taskId);
		for (const taskId of taskIds) stoppingTaskIds.add(taskId);
		try {
			const result = await clearTrackedTasks(pi, includeRunning, deleteFiles);
			markArtifactsUnavailable(result.clearedTasks.map((task) => task.taskId));
			for (const completion of result.completions) queueCompletion(completion);
			updateTaskStatus();
			return result;
		} finally {
			for (const taskId of taskIds) stoppingTaskIds.delete(taskId);
			ensureMonitor();
		}
	};

	const hasTasksToMonitor = (): boolean => Array.from(tasks.values()).some(
		(task) => !notifiedTaskIds.has(task.taskId) &&
			!queuedCompletions.has(task.taskId) &&
			!stoppingTaskIds.has(task.taskId),
	);

	const ensureMonitor = (delay = MONITOR_INTERVAL_MS): void => {
		if (disposed || monitorTimer || monitorScanning || !hasTasksToMonitor()) return;
		monitorTimer = setTimeout(() => void scanTasks(), delay);
		(monitorTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
	};

	const scanTasks = async (): Promise<void> => {
		monitorTimer = undefined;
		if (disposed || monitorScanning) return;
		monitorScanning = true;
		try {
			for (const task of Array.from(tasks.values())) {
				if (disposed) break;
				if (notifiedTaskIds.has(task.taskId) || queuedCompletions.has(task.taskId) || stoppingTaskIds.has(task.taskId)) continue;
				const snapshot = await fetchTaskState(pi, task.name, 0);
				if (disposed || tasks.get(task.name)?.taskId !== task.taskId) continue;
				observeSnapshot(snapshot);
			}
		} finally {
			monitorScanning = false;
			ensureMonitor();
		}
	};

	const resetSessionState = (ctx: ExtensionContext): void => {
		disposed = false;
		currentCtx = ctx;
		clearMonitorTimer();
		clearCompletionTimer();
		queuedCompletions.clear();
		stoppingTaskIds.clear();
		startingTaskNames.clear();
		const pendingCompletions = reconstructState(ctx);
		for (const completion of pendingCompletions) queueCompletion(completion, false);
		updateTaskStatus(ctx);
		ensureMonitor(0);
	};

	pi.on("session_start", async (_event, ctx) => {
		resetSessionState(ctx);
		if (ctx.hasUI && tasks.size > 0) {
			ctx.ui.notify(`Tracking ${tasks.size} background task(s).`, "info");
		}
	});

	pi.on("session_tree", async (_event, ctx) => resetSessionState(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		disposed = true;
		ctx.ui.setStatus(TASK_STATUS_KEY, undefined);
		currentCtx = undefined;
		clearMonitorTimer();
		clearCompletionTimer();
		queuedCompletions.clear();
		stoppingTaskIds.clear();
		startingTaskNames.clear();
	});

	// --- task_start tool ------------------------------------------------------
	pi.registerTool({
		name: "task_start",
		label: "Task Start",
		description:
			"Start a long-running shell command in a detached tmux session. Pi automatically notifies the agent once when the task succeeds, fails, is stopped, or is lost; earlier status/output is available through task_status.",
		promptSnippet: "Start a shell command in the background via tmux",
		promptGuidelines: [
			"Use task_start when the user asks you to run a long-running command that would block the agent.",
			"task_start creates a background tmux session; choose a descriptive task name or let it auto-generate one.",
			"After task_start, continue any independent work. Do not use sleep or repeatedly poll task_status while waiting; let the automatic completion notification wake you when the process finishes.",
			"Use task_status only when the user asks for an update or when you need intermediate output before the task finishes.",
		],
		parameters: TaskStartParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await startAndMonitor(ctx, params);
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
			"Use task_status when the user asks to see the output/status of a background task, or when you need the output to continue.",
			"task_status returns one task transcript as a normal tool result. Terminal-state notifications are injected separately and automatically.",
			"The default output is 10 nonblank lines. If the user asks for more output, use a larger tail_lines value.",
			"If task_status shows the task has exited or errored, consider whether you still need the output. If not, call task_clear to delete temporary files.",
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
			const tailLines = Math.max(1, params.tail_lines ?? tasks.get(resolved.name)?.tailLines ?? DEFAULT_TAIL_LINES);
			const snapshot = await fetchTaskState(pi, resolved.name, tailLines);
			observeSnapshot(snapshot);

			return {
				content: [{
					type: "text",
					text: formatTaskSnapshot(resolved.name, snapshot.status, snapshot.output, snapshot.exitCode),
				}],
				details: {
					name: resolved.name,
					status: snapshot.status,
					output: snapshot.output,
					exitCode: snapshot.exitCode,
				},
			};
		},
		renderResult(result, options, theme) {
			const details = result.details as { name?: string; status?: TaskStatus; output?: string } | undefined;
			// Never return undefined: pi's tool component stores the renderer's
			// return value directly, so undefined would crash the TUI render
			// (Box.render -> child.render on an undefined child). Fall back to
			// the raw text output for results without usable details (execution
			// errors, blocked calls, or the no-task-selected path).
			if (!details || typeof details.name !== "string") {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			return new TaskStatusResultComponent(
				details.name,
				details.status ?? "running",
				details.output ?? "",
				options.expanded,
				theme as Theme,
			);
		},
	});

	// --- task_stop tool -------------------------------------------------------
	pi.registerTool({
		name: "task_stop",
		label: "Task Stop",
		description: "Stop a background task by task name. By default it remains tracked for output inspection and cleanup.",
		promptSnippet: "Stop a background task by name",
		promptGuidelines: [
			"Use task_stop when the user asks to stop or kill a background task.",
		],
		parameters: TaskStopParams,
		async execute(_toolCallId, params) {
			const result = await stopAndNotify(params.name, params.delete_files ?? false);
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
			"task_clear skips running tasks unless include_running:true is explicitly requested; that option stops the tasks before clearing them.",
		],
		parameters: TaskClearParams,
		// Cleanup is internal bookkeeping. Keep its tool row out of the transcript.
		// The result still goes to the model, and `/task-clear` remains user-facing.
		renderShell: "self",
		renderCall: () => new Container(),
		renderResult: () => new Container(),
		async execute(_toolCallId, params) {
			const result = await clearAndNotify(
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
		const snapshot = await fetchTaskState(pi, sanitized, tasks.get(sanitized)?.tailLines ?? DEFAULT_TAIL_LINES);
		observeSnapshot(snapshot);

		if (ctx.mode !== "tui") {
			ctx.ui.notify(
				formatTaskSnapshot(sanitized, snapshot.status, snapshot.output, snapshot.exitCode),
				"info",
			);
			return;
		}

		await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
			new TaskStatusDialogComponent(sanitized, snapshot.status, snapshot.output, theme as Theme, done),
		);
	};

	pi.registerCommand("task-status", {
		description: "Choose a background task and show a dismissible status/output tail",
		handler: showTaskStatus,
	});

	pi.registerCommand("task-stop", {
		description: "Stop a background task by task name",
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify("Usage: /task-stop <task-name>", "error");
				return;
			}
			const result = await stopAndNotify(name, false);
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
					"This stops each running process, removes it from tracking, and deletes its temporary files.",
				);
				if (!ok) return;
			}
			const result = await clearAndNotify(includeRunning, true);
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
