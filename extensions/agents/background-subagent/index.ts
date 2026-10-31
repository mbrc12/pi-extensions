/** Run the existing subagent tool off-turn and deliver its answer when it finishes. */
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { getMarkdownTheme, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { createOperatorViewer } from "../multiagent/viewer.ts";
import { createSubagentTool } from "../subagent/index.ts";
import { discoverAgents } from "../subagent/agents.ts";
import { createNotificationGate } from "../../shared/notification-gate.ts";
import { compactActivityText, extractSessionActivity, formatDuration, renderSessionActivity } from "../shared/session-activity.ts";
import { formatSessionDisplay } from "../shared/session-display.ts";

const STATE = "background-subagent-state";
const COMPLETION = "background-subagent-completion";
const WAKE = "background-subagent-wake";
const MAX_OUTPUT = 48 * 1024;
const MAX_RUNNING = 16;
const STATUS_KEY = "background-subagent";
const RECENT_ACTIVITY = 5;

type Progress = Parameters<NonNullable<Parameters<ReturnType<typeof createSubagentTool>["execute"]>[3]>>[0];
type Status = "running" | "succeeded" | "failed" | "stopped" | "interrupted";
type Params = Parameters<ReturnType<typeof createSubagentTool>["execute"]>[1];
interface Job {
	id: string;
	name: string;
	agent: string;
	startedAt: number;
	finishedAt?: number;
	status: Status;
	output?: string;
	cost?: number;
	// Live progress stays in memory; only starts and final results enter the session.
	model?: string;
	turns?: number;
	phase?: string;
	activity?: string[];
	draft?: string;
	updatedAt?: number;
	/** Latest child transcript, kept in memory and attached to completion messages. */
	messages?: unknown[];
}
const StartParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Unique job name (generated if omitted)" })),
	agent: Type.String({ description: "Subagent to run" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent" })),
	strength: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	wise: Type.Optional(Type.Boolean({ description: "Compact the caller's context for the subagent" })),
	agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")])),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Confirm project-local agents before starting (default true)" })),
});
type StartInput = Static<typeof StartParams>;
const NamedParams = Type.Object({ name: Type.String({ description: "Background subagent job name" }) });
const StatusParams = Type.Object({ name: Type.Optional(Type.String({ description: "Job to inspect; omit to list all tracked jobs" })) });

function elapsed(startedAt: number, finishedAt = Date.now()): string {
	return formatDuration(finishedAt - startedAt, "clock");
}

function lastText(value: unknown, max = 500): string {
	return compactActivityText(value, max);
}

function progressFromUpdate(update: Progress): Pick<Job, "phase" | "activity" | "draft" | "model" | "turns" | "cost" | "messages"> {
	const result = update.details?.results?.at(-1);
	if (!result) return { phase: "compacting caller context", activity: [], draft: "" };
	const { activity, draft } = extractSessionActivity(result.messages, {
		messageLimit: 20, activityLimit: RECENT_ACTIVITY, argumentChars: 140, resultChars: 180, draftChars: 1000,
	});
	return {
		phase: "working", activity, draft,
		model: result.model ?? result.requestedModel,
		turns: result.usage.turns, cost: result.usage.cost, messages: result.messages,
	};
}

function formatJob(job: Job, expanded: boolean): string {
	const lines = [`${job.name} (${job.agent}): ${job.status} · ${elapsed(job.startedAt, job.finishedAt)}`];
	if (job.status === "running") {
		lines.push(`Phase: ${job.phase ?? "starting"}`);
		if (job.model) lines.push(`Model: ${job.model}`);
		if (job.turns || job.cost) lines.push(`Turns: ${job.turns ?? 0} · Cost: $${(job.cost ?? 0).toFixed(4)}`);
		if (job.messages?.length) lines.push(...formatTranscript(job.messages, expanded));
		else lines.push(...renderSessionActivity({ activity: job.activity, draft: job.draft }, expanded));
	} else if (job.messages?.length) lines.push("", ...formatTranscript(job.messages, expanded));
	else if (job.output) lines.push("", expanded ? job.output : lastText(job.output, 199));
	return lines.join("\n");
}

/**
 * Selection/list order: running jobs first, then most recently started.
 * Running outranks recency so active work is never buried under finished jobs.
 */
function orderedJobs(all: Iterable<Job>): Job[] {
	return [...all].sort((a, b) => {
		const runningA = a.status === "running" ? 1 : 0;
		const runningB = b.status === "running" ? 1 : 0;
		if (runningA !== runningB) return runningB - runningA;
		return b.startedAt - a.startedAt;
	});
}

/** One selection-row label with status and how long the job has been active. */
function jobRow(job: Job): string {
	return `${job.name} (${job.agent}) · ${job.status} · ${elapsed(job.startedAt, job.finishedAt)}`;
}

function formatTranscript(messages: readonly unknown[], expanded: boolean): string[] {
	const transcript = formatSessionDisplay(messages, { expanded });
	return transcript ? [transcript] : [];
}

function italicize(theme: ExtensionContext["ui"]["theme"], text: string): string {
	const withItalic = theme as unknown as { italic?: (value: string) => string };
	return typeof withItalic.italic === "function" ? withItalic.italic(text) : text;
}

function coloredReport(report: string, theme: ExtensionContext["ui"]["theme"]): Container {
	const container = new Container();
	for (const line of report.split("\n")) {
		const match = /^(\[(user|system|tool)(?: [^\]]+)?\])/.exec(line);
		if (match) container.addChild(new Text(theme.fg(match[2] === "user" ? "accent" : match[2] === "system" ? "warning" : "toolTitle", match[1]) + italicize(theme, line.slice(match[1].length)), 0, 0));
		else if (line === "-----") container.addChild(new Text(theme.fg("dim", line), 0, 0));
		else container.addChild(new Text(theme.fg("toolOutput", line), 0, 0));
	}
	return container;
}

function preview(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT) return text;
	const clipped = Buffer.from(text).subarray(0, MAX_OUTPUT).toString("utf8");
	return `${clipped}\n\n[Output truncated to 48 KB.]`;
}

export default function backgroundSubagent(pi: ExtensionAPI): void {
	const tool = createSubagentTool(pi);
	const jobs = new Map<string, Job>();
	const controllers = new Map<string, AbortController>();
	const delivered = new Set<string>();
	let generation = 0;
	let currentCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	const notifications = createNotificationGate(pi, () => {
		for (const job of jobs.values()) {
			if (job.status !== "running") notify(job);
		}
	});

	function updateIndicator(): void {
		const running = [...jobs.values()].filter((job) => job.status === "running");
		if (running.length === 0) {
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			currentCtx?.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!ticker) {
			ticker = setInterval(updateIndicator, 1000);
			ticker.unref?.();
		}
		const latest = running.at(-1)!;
		const theme = currentCtx?.ui.theme;
		currentCtx?.ui.setStatus(STATUS_KEY,
			theme ? theme.fg("accent", "⏳ sub") + " " + theme.fg("muted", `${running.length} · ${elapsed(latest.startedAt)}`) : `⏳ sub ${running.length} · ${elapsed(latest.startedAt)}`,
		);
	}

	function notify(job: Job): void {
		if (delivered.has(job.id)) return;
		if (!notifications.canSend()) {
			notifications.request();
			return;
		}
		pi.sendMessage({
			customType: COMPLETION,
			content: `Background subagent ${job.name} (${job.agent}) ${job.status}.\n\n${job.output || "(no output)"}`,
			display: true,
			details: { id: job.id, name: job.name, agent: job.agent, status: job.status, cost: job.cost, startedAt: job.startedAt, finishedAt: job.finishedAt, messages: job.messages },
		}, { deliverAs: "followUp", triggerTurn: false });
		delivered.add(job.id);
		if (currentCtx?.model) {
			pi.sendMessage({
				customType: WAKE,
				content: "Review the background subagent result immediately before this message and continue the user's work.",
				display: false,
				details: { id: job.id },
			}, { deliverAs: "followUp", triggerTurn: true });
		}
	}

	function finish(job: Job, status: Status, output: string, cost?: number): void {
		if (job.status !== "running") return;
		job.status = status;
		job.finishedAt = Date.now();
		job.output = preview(output);
		job.cost = cost;
		controllers.delete(job.id);
		updateIndicator();
		const { messages: _messages, ...persistedJob } = job;
		pi.appendEntry(STATE, { action: "finish", job: persistedJob });
		try { notify(job); } catch { /* Persisted result is retried on session start. */ }
	}

	function restore(ctx: ExtensionContext): void {
		notifications.reset(ctx);
		generation++;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		currentCtx?.ui.setStatus(STATUS_KEY, undefined);
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		jobs.clear();
		delivered.clear();
		currentCtx = ctx;
		const savedMessages = new Map<string, unknown[]>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE) {
				const data = entry.data as { action?: string; job?: Job } | undefined;
				if (data?.job && (data.action === "start" || data.action === "finish")) jobs.set(data.job.name, data.job);
			} else if (entry.type === "custom_message" && entry.customType === COMPLETION) {
				const data = entry.details as { id?: string; messages?: unknown[] } | undefined;
				if (data?.id) {
					delivered.add(data.id);
					if (data.messages) savedMessages.set(data.id, data.messages);
				}
			}
		}
		for (const job of jobs.values()) {
			job.messages ??= savedMessages.get(job.id);
			if (job.status === "running") finish(job, "interrupted", "Pi stopped or reloaded before this subagent finished. Check any file changes before retrying.");
			else if (!delivered.has(job.id)) {
				try { notify(job); } catch { /* Next session start can retry. */ }
			}
		}
		updateIndicator();
	}

	pi.registerMessageRenderer<{ id: string; name: string; agent?: string; status: Status; cost?: number; startedAt?: number; finishedAt?: number; messages?: unknown[] }>(
		COMPLETION,
		(message, { expanded, outputPad }, theme) => {
			const details = message.details;
			const state = details?.status ?? "failed";
			const color = state === "succeeded" ? "success" : state === "stopped" || state === "interrupted" ? "warning" : "error";
			const icon = state === "succeeded" ? "✓" : state === "stopped" || state === "interrupted" ? "△" : "✗";
			const label = details?.name ? `${details.name}${details.agent ? ` (${details.agent})` : ""}` : "Background subagent";
			const duration = details?.startedAt && details.finishedAt ? ` · ${elapsed(details.startedAt, details.finishedAt)}` : "";
			const cost = details?.cost ? ` · $${details.cost.toFixed(4)}` : "";
			const header = theme.fg(color, icon) + " " + theme.fg("toolTitle", theme.bold(label))
				+ theme.fg("muted", ` · ${state}${duration}${cost}`);
			const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
			if (!expanded) {
				box.addChild(new Text(header + theme.fg("dim", ` (${keyHint("app.tools.expand", "to expand")})`), 0, 0));
				return box;
			}
			box.addChild(new Text(header, 0, 0));
			const fullText = typeof message.content === "string"
				? message.content
				: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const separator = fullText.indexOf("\n\n");
			const body = separator >= 0 ? fullText.slice(separator + 2) : fullText;
			box.addChild(new Spacer(1));
			if (details?.messages?.length) box.addChild(coloredReport(formatSessionDisplay(details.messages, { expanded }), theme));
			else box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), { color: (text) => theme.fg("customMessageText", text) }));
			return box;
		},
	);

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		notifications.dispose();
		generation++;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		currentCtx?.ui.setStatus(STATUS_KEY, undefined);
		currentCtx = undefined;
	});

	pi.registerTool({
		name: "background_subagent",
		label: "Background Subagent",
		description: "Start one specialized subagent without blocking the main agent. Its final answer or failure is injected into this session and wakes the main agent when finished. For synchronous work or parallel/chain delegation, use subagent.",
		promptGuidelines: [
			"Use background_subagent when a subagent can work independently while you do other work.",
			"After starting it, continue independent work or end your turn; do not poll for completion. The result will arrive automatically.",
		],
		parameters: StartParams,
		async execute(toolCallId, params: StartInput, _signal, _onUpdate, ctx) {
			const name = params.name?.trim() || `sub-${randomUUID().slice(0, 8)}`;
			if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Job name must be 1–64 letters, numbers, underscores, or hyphens.");
			if (!params.task.trim()) throw new Error("Task cannot be empty.");
			if (jobs.has(name)) throw new Error(`Job ${name} is already tracked. Use another name.`);
			if (controllers.size >= MAX_RUNNING) throw new Error(`At most ${MAX_RUNNING} background subagents may run at once.`);
			const scope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agent = discovery.agents.find((item) => item.name === params.agent);
			if (!agent) throw new Error(`Unknown agent "${params.agent}". Available: ${discovery.agents.map((a) => a.name).join(", ") || "none"}.`);
			if (agent.source === "project" && params.confirmProjectAgents !== false) {
				if (!ctx.hasUI) throw new Error("Project-local agents require confirmation. Use an interactive session or set confirmProjectAgents:false for a trusted repository.");
				const ok = await ctx.ui.confirm("Run project-local agent?", `Agent: ${agent.name}\nSource: ${agent.filePath}\n\nOnly approve trusted repositories.`);
				if (!ok) return { content: [{ type: "text" as const, text: "Canceled: project-local agent not approved." }], details: undefined };
			}
			// Recheck after the approval dialog: other tool calls can start in parallel.
			if (jobs.has(name) || controllers.size >= MAX_RUNNING) throw new Error("Job name or concurrency limit changed while waiting for approval.");
			const job: Job = { id: randomUUID(), name, agent: agent.name, startedAt: Date.now(), status: "running" };
			const controller = new AbortController();
			const epoch = generation;
			jobs.set(name, job);
			controllers.set(job.id, controller);
			pi.appendEntry(STATE, { action: "start", job: { ...job } });
			updateIndicator();
			// No parent turn signal: the child must keep running after this tool returns.
			const delegated: Params = {
				agent: agent.name, task: params.task, cwd: params.cwd, strength: params.strength,
				wise: params.wise, agentScope: scope, confirmProjectAgents: false,
			};
			void (async () => {
				try {
					const result = await tool.execute(toolCallId, delegated, controller.signal, (update) => {
						if (epoch !== generation || job.status !== "running") return;
						Object.assign(job, progressFromUpdate(update), { updatedAt: Date.now() });
					}, ctx);
					if (epoch !== generation || job.status !== "running") return;
					const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
					const latest = result.details?.results?.at(-1);
					if (latest?.messages) job.messages = latest.messages;
					finish(job, result.isError ? "failed" : "succeeded", output, result.usage?.cost?.total);
				} catch (error) {
					if (epoch === generation && job.status === "running") finish(job, controller.signal.aborted ? "stopped" : "failed", String(error));
				}
			})();
			return { content: [{ type: "text" as const, text: `Started background subagent ${name} (${agent.name}). Pi will deliver its result when it finishes. Use background_subagent_status({name:"${name}"}) only if you need an update.` }], details: { id: job.id, name, agent: agent.name } };
		},
	});

	pi.registerTool<typeof StatusParams, { job?: Job; jobs?: Job[] }>({
		name: "background_subagent_status",
		label: "Background Subagent Status",
		description: "List tracked jobs or inspect one subagent's live phase, model, recent tool activity, turns, and latest assistant text. No polling is needed for completion.",
		parameters: StatusParams,
		async execute(_id, { name }) {
			if (!name) {
				const ordered = orderedJobs(jobs.values());
				const tracked = ordered.map((job) => formatJob(job, false)).join("\n\n");
				return { content: [{ type: "text" as const, text: tracked || "No background subagents tracked." }], details: { jobs: ordered.map((job) => ({ ...job })) } };
			}
			const job = jobs.get(name);
			if (!job) return { content: [{ type: "text" as const, text: `Unknown job ${name}. Tracked: ${[...jobs.keys()].join(", ") || "none"}.` }], details: {} };
			return { content: [{ type: "text" as const, text: formatJob(job, false) }], details: { job: { ...job } } };
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { job?: Job; jobs?: Job[] } | undefined;
			if (details?.job) return coloredReport(formatJob(details.job, expanded), theme);
			if (details?.jobs) {
				const text = details.jobs.map((job) => formatJob(job, expanded)).join("\n\n");
				return coloredReport(text || "No background subagents tracked.", theme);
			}
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "", 0, 0);
		},
	});

	pi.registerCommand("background-subagent-status", {
		description: "Choose or show a background subagent's current state",
		handler: async (args, ctx) => {
			let name = args.trim();
			if (!name) {
				if (jobs.size === 0) {
					ctx.ui.notify("No background subagents tracked.", "info");
					return;
				}
				const ordered = orderedJobs(jobs.values());
				if (ordered.length === 1) name = ordered[0].name;
				else {
					const selected = await ctx.ui.select("Choose background subagent:", ordered.map(jobRow));
					if (!selected) return;
					name = selected.split(" (")[0];
				}
			}
			const job = jobs.get(name);
			if (!job) {
				ctx.ui.notify(`Unknown background subagent: ${name}`, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatJob(job, false), "info");
				return;
			}
			const selectedJob = job;
			const fallbackMessages = selectedJob.output
				? [{ role: "assistant", content: [{ type: "text", text: selectedJob.output }] }]
				: [];
			await ctx.ui.custom(createOperatorViewer(() => ({
				name: selectedJob.name, agent: selectedJob.agent, status: selectedJob.status,
				model: selectedJob.model ?? "model pending", messages: selectedJob.messages?.length ? selectedJob.messages : fallbackMessages,
			}), { heightFraction: 0.6 }));
		},
	});

	pi.registerTool({
		name: "background_subagent_stop",
		label: "Stop Background Subagent",
		description: "Stop a running background subagent. Partial file changes are not undone.",
		parameters: NamedParams,
		async execute(_id, { name }) {
			const job = jobs.get(name);
			if (!job) return { content: [{ type: "text" as const, text: `Unknown job ${name}.` }], details: undefined };
			if (job.status === "running") {
				controllers.get(job.id)?.abort();
				finish(job, "stopped", "Stopped by request. Check any partial file changes.");
			}
			return { content: [{ type: "text" as const, text: `${name}: ${job.status}.` }], details: { ...job } };
		},
	});
}
