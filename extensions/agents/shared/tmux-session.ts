/**
 * Per-session tmux workspace that mirrors agent activity into panes.
 *
 * Subagents and operators keep talking to their parent over a pipe; this module
 * only adds a window per agent whose pane follows the agent's session JSONL.
 * Killing a pane therefore never kills work, and killing the workspace never
 * interrupts an agent.
 *
 * The workspace is off by default. The `/tmux-session` command opens and closes
 * it, and the owning pi session closes it again on shutdown.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** tmux user options that record who owns a workspace session. */
export const OWNER_OPTION = "@pi_owner";
export const SESSION_OPTION = "@pi_session";

/** Windows kept in a workspace before the oldest finished one is closed. */
const MAX_WINDOWS = 10;
const EXEC_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
/** Transcripts older than this are deleted the first time a workspace writes a new one. */
const TRANSCRIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowState = "running" | "done";

export interface AgentWindow {
	/** Stable identity of one agent run: an operator id or a subagent transcript id. */
	key: string;
	title: string;
	sessionFile: string;
	cwd?: string;
	state: WindowState;
}

export interface WorkspaceStatus {
	name: string;
	open: boolean;
	enabled: boolean;
	windows: string[];
	agents: number;
	attachCommand: string;
}

interface ExecOutcome {
	code: number;
	stdout: string;
	stderr: string;
}

interface Transcript {
	key: string;
	sessionFile: string;
	/** Arguments that make the child write its session to `sessionFile`. */
	args: string[];
	/** Mark the run finished so the window can be evicted once the cap is reached. */
	finish: () => void;
}

/**
 * tmux session name for one pi session: `pi-` plus eight safe characters of the
 * session id. tmux rejects dots, colons, and spaces in session names.
 */
export function agentSessionName(sessionId: string): string {
	const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8);
	return `pi-${safe || "session"}`;
}

/** Window title for one agent: readable stem plus a short id so runs stay distinct. */
export function windowName(title: string, key: string): string {
	const stem = String(title).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
	const suffix = String(key).replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "0000";
	return `${stem}-${suffix}`;
}

/**
 * Decide what to do with an existing tmux session carrying our name.
 *
 * - `ours`: this process created it.
 * - `stale`: the owner pid is gone, so the workspace outlived a crashed session.
 * - `foreign`: another live pi process owns it; leave it alone.
 */
export function decideOwnership(
	ownerPid: number | undefined,
	selfPid: number,
	isAlive: (pid: number) => boolean,
): "ours" | "stale" | "foreign" {
	if (!ownerPid) return "stale";
	if (ownerPid === selfPid) return "ours";
	return isAlive(ownerPid) ? "foreign" : "stale";
}

/** Quote a value for the single shell string tmux runs as a pane command. */
export function shellQuote(value: string): string {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** Absolute path of the pane renderer, resolved next to this module. */
export function viewerScriptPath(): string {
	try {
		return fileURLToPath(new URL("./tmux-viewer.mjs", import.meta.url));
	} catch {
		return path.join(getAgentDir(), "extensions", "agents", "shared", "tmux-viewer.mjs");
	}
}

export class TmuxWorkspace {
	readonly name: string;
	private readonly entries = new Map<string, AgentWindow>();
	private enabled = false;
	private runtime: Promise<string | undefined> | undefined;
	/** Serializes tmux calls so concurrent agent launches cannot race on window creation. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly sessionId: string,
		private readonly cwd: string,
	) {
		this.name = agentSessionName(sessionId);
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get attachCommand(): string {
		return `tmux attach -t ${this.name}`;
	}

	/** Directory that holds transcripts for one kind of agent in this pi session. */
	transcriptDir(kind: string): string {
		const session = String(this.sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
		return path.join(getAgentDir(), "agent-transcripts", session, kind.replace(/[^a-zA-Z0-9_-]/g, "_"));
	}

	/**
	 * Give one agent run its own session file so a pane has something to follow.
	 * Always allocated: an agent that started while the workspace was closed still
	 * gets a pane, with its history, when the workspace opens mid-run.
	 */
	openTranscript(kind: string, title: string, cwd?: string): Transcript | undefined {
		const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
		const dir = this.transcriptDir(kind);
		let sessionFile: string;
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
			this.pruneTranscripts(dir);
			sessionFile = path.join(dir, `${id}.jsonl`);
		} catch {
			return undefined;
		}
		const key = `${kind}-${id}`;
		this.register({ key, title, sessionFile, cwd });
		return {
			key,
			sessionFile,
			// `--session <path>` writes exactly this file, unlike `--session-id`, whose
			// file name gets a generated timestamp prefix.
			args: ["--session", sessionFile],
			finish: () => this.markDone(key),
		};
	}

	/** Add or refresh one agent. A window appears only while the workspace is open. */
	register(entry: { key: string; title: string; sessionFile: string; cwd?: string }): void {
		const existing = this.entries.get(entry.key);
		if (existing) {
			existing.title = entry.title;
			existing.sessionFile = entry.sessionFile;
			existing.cwd = entry.cwd ?? existing.cwd;
			existing.state = "running";
			return;
		}
		this.entries.set(entry.key, { ...entry, state: "running" });
		if (!this.enabled) return;
		void this.enqueue(() => this.syncWindow(entry.key)).catch(() => {});
	}

	/** Keep a finished agent's window; it becomes the first eviction candidate. */
	markDone(key: string): void {
		const entry = this.entries.get(key);
		if (entry) entry.state = "done";
	}

	/** Forget one agent and close its window. */
	unregister(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		if (!this.enabled) return;
		void this.enqueue(() => this.killWindowFor(entry, key)).catch(() => {});
	}

	/**
	 * Open the workspace, or reuse it when this process already owns it.
	 * Windows are created for every agent registered so far.
	 */
	async open(): Promise<{ name: string; created: boolean; windows: string[] }> {
		const version = await this.run(["-V"], PROBE_TIMEOUT_MS);
		if (version.code !== 0) throw new Error("tmux is not installed or not on PATH");

		if (await this.sessionPresent()) {
			const ownership = await this.ownership();
			if (ownership === "foreign") {
				throw new Error(`tmux session ${this.name} belongs to another pi process; attach to it instead: ${this.attachCommand}`);
			}
			if (ownership === "stale") await this.run(["kill-session", "-t", this.target()], EXEC_TIMEOUT_MS);
		}

		let created = false;
		if (!(await this.sessionPresent())) {
			const result = await this.run(["new-session", "-d", "-s", this.name, "-c", this.cwd], EXEC_TIMEOUT_MS);
			if (result.code !== 0) {
				throw new Error(`Could not create tmux session ${this.name}: ${result.stderr || result.stdout || "tmux failed"}`);
			}
			created = true;
		}

		await this.run(["set-option", "-t", this.target(), OWNER_OPTION, String(process.pid)], PROBE_TIMEOUT_MS);
		await this.run(["set-option", "-t", this.target(), SESSION_OPTION, this.sessionId], PROBE_TIMEOUT_MS);
		await this.run(["set-option", "-t", this.target(), "destroy-unattached", "off"], PROBE_TIMEOUT_MS);
		await this.configureWindows();

		this.enabled = true;
		await this.enqueue(async () => {
			for (const key of [...this.entries.keys()]) await this.syncWindow(key);
		});
		return { name: this.name, created, windows: await this.windowNames() };
	}

	/**
	 * Close the workspace. A session owned by another live pi process is left
	 * alone; a session left behind by a crashed run is removed.
	 */
	async close(): Promise<{ name: string; closed: boolean; reason?: string }> {
		this.enabled = false;
		if (!(await this.sessionPresent())) return { name: this.name, closed: false, reason: "not open" };
		if ((await this.ownership()) === "foreign") {
			return { name: this.name, closed: false, reason: "owned by another pi process" };
		}
		const result = await this.run(["kill-session", "-t", this.target()], EXEC_TIMEOUT_MS);
		if (result.code !== 0) {
			return { name: this.name, closed: false, reason: result.stderr.trim() || "tmux refused to kill the session" };
		}
		return { name: this.name, closed: true };
	}

	async status(): Promise<WorkspaceStatus> {
		const open = await this.sessionPresent();
		return {
			name: this.name,
			open,
			enabled: this.enabled,
			windows: open ? await this.windowNames() : [],
			agents: this.entries.size,
			attachCommand: this.attachCommand,
		};
	}

	private prunedDirs = new Set<string>();

	/** Delete transcripts from earlier runs once per directory, so the mirror stays small. */
	private pruneTranscripts(dir: string): void {
		if (this.prunedDirs.has(dir)) return;
		this.prunedDirs.add(dir);
		const cutoff = Date.now() - TRANSCRIPT_TTL_MS;
		try {
			for (const name of fs.readdirSync(dir)) {
				const file = path.join(dir, name);
				try {
					if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
				} catch {
					// A transcript in use by a viewer stays until the next sweep.
				}
			}
		} catch {
			// An unreadable directory must not block a run.
		}
	}

	private target(): string {
		// The `=` prefix forces an exact session-name match.
		return `=${this.name}`;
	}

	private async sessionPresent(): Promise<boolean> {
		const result = await this.run(["has-session", "-t", this.target()], PROBE_TIMEOUT_MS);
		return result.code === 0;
	}

	private async ownership(): Promise<"ours" | "stale" | "foreign"> {
		const result = await this.run(["display-message", "-p", "-t", this.target(), `#{${OWNER_OPTION}}`], PROBE_TIMEOUT_MS);
		const raw = result.stdout.trim();
		const ownerPid = /^\d+$/.test(raw) ? Number(raw) : undefined;
		return decideOwnership(ownerPid, process.pid, isAlive);
	}

	private async windowNames(): Promise<string[]> {
		const result = await this.run(["list-windows", "-t", this.target(), "-F", "#{window_name}"], PROBE_TIMEOUT_MS);
		if (result.code !== 0) return [];
		return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	}

	/** Keep panes visible after their viewer exits, and stop tmux renaming them. */
	private async configureWindows(): Promise<void> {
		for (const name of await this.windowNames()) {
			await this.run(["set-option", "-w", "-t", `${this.target()}:${name}`, "remain-on-exit", "on"], PROBE_TIMEOUT_MS);
			await this.run(["set-option", "-w", "-t", `${this.target()}:${name}`, "automatic-rename", "off"], PROBE_TIMEOUT_MS);
		}
	}

	private async syncWindow(key: string): Promise<void> {
		const entry = this.entries.get(key);
		if (!entry) return;
		const win = windowName(entry.title, entry.key);
		const existing = await this.windowNames();
		if (existing.includes(win)) return;
		// A resumed session can re-register the same agent; drop the stale window first.
		const command = await this.viewerCommand(entry);
		const result = await this.run(
			["new-window", "-d", "-t", `${this.target()}:`, "-n", win, "-c", entry.cwd ?? this.cwd, command],
			EXEC_TIMEOUT_MS,
		);
		if (result.code !== 0) return;
		await this.run(["set-option", "-w", "-t", `${this.target()}:${win}`, "remain-on-exit", "on"], PROBE_TIMEOUT_MS);
		await this.run(["set-option", "-w", "-t", `${this.target()}:${win}`, "automatic-rename", "off"], PROBE_TIMEOUT_MS);
		await this.evictOverflow(existing.length + 1);
	}

	private async killWindowFor(entry: AgentWindow, key: string): Promise<void> {
		await this.run(["kill-window", "-t", `${this.target()}:${windowName(entry.title, key)}`], PROBE_TIMEOUT_MS);
	}

	/** Close the oldest finished windows while the workspace is over the cap. */
	private async evictOverflow(count: number): Promise<void> {
		let total = count;
		while (total > MAX_WINDOWS) {
			const victim = [...this.entries.values()].find((entry) => entry.state === "done");
			if (!victim) return;
			this.entries.delete(victim.key);
			await this.run(["kill-window", "-t", `${this.target()}:${windowName(victim.title, victim.key)}`], PROBE_TIMEOUT_MS);
			total--;
		}
	}

	/** The pane command: a renderer that follows the transcript, or a plain tail. */
	private async viewerCommand(entry: AgentWindow): Promise<string> {
		const runtime = await this.resolveRuntime();
		const script = viewerScriptPath();
		if (runtime && fs.existsSync(script)) {
			return ["exec", shellQuote(runtime), shellQuote(script), shellQuote(entry.sessionFile), "--title", shellQuote(entry.title)].join(" ");
		}
		return ["exec", "tail", "-n", "+1", "-f", shellQuote(entry.sessionFile)].join(" ");
	}

	/** First JavaScript runtime that can run the viewer, preferring the one running pi. */
	private resolveRuntime(): Promise<string | undefined> {
		if (!this.runtime) {
			this.runtime = (async () => {
				const execPath = process.execPath ?? "";
				if (/^(node|bun)(\.exe)?$/i.test(path.basename(execPath))) return execPath;
				// A packaged pi binary is not a JavaScript runtime, so look one up.
				for (const candidate of ["node", "bun"]) {
					const found = await this.pi
						.exec("sh", ["-c", `command -v ${candidate}`], { timeout: PROBE_TIMEOUT_MS })
						.catch(() => undefined);
					const runtime = found?.code === 0 ? found.stdout.trim() : "";
					if (runtime) return runtime;
				}
				return undefined;
			})();
		}
		return this.runtime;
	}

	private async run(args: string[], timeout: number): Promise<ExecOutcome> {
		try {
			return await this.pi.exec("tmux", args, { timeout });
		} catch (error) {
			return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => {});
		return next;
	}
}

/**
 * The workspace lives on the global object, not in module scope: pi can load
 * each extension entry through its own loader instance, and the command, the
 * subagent tool, and the operator tool must all see the same workspace.
 */
const SLOT = Symbol.for("pi.tmux-workspace");
const PI_SLOT = Symbol.for("pi.tmux-workspace-pi");

export function setWorkspace(workspace: TmuxWorkspace | undefined): void {
	(globalThis as Record<symbol, unknown>)[SLOT] = workspace;
}

export function getWorkspace(): TmuxWorkspace | undefined {
	return (globalThis as Record<symbol, unknown>)[SLOT] as TmuxWorkspace | undefined;
}

/** Remember the extension API so a workspace can be created outside a session event. */
export function providePi(pi: ExtensionAPI): void {
	(globalThis as Record<symbol, unknown>)[PI_SLOT] = pi;
}

/**
 * Return the active workspace, creating a closed one when none is bound yet.
 * `/reload` does not always fire `session_start`, so the first agent launch or
 * command after a reload must be able to bind the workspace itself.
 */
export function ensureWorkspace(ctx?: any): TmuxWorkspace | undefined {
	const existing = getWorkspace();
	if (existing) return existing;
	const pi = (globalThis as Record<symbol, unknown>)[PI_SLOT] as ExtensionAPI | undefined;
	if (!pi) return undefined;
	const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "session";
	const workspace = new TmuxWorkspace(pi, sessionId, ctx?.cwd ?? process.cwd());
	setWorkspace(workspace);
	return workspace;
}
