/** Run the existing subagent tool off-turn and deliver its answer when it finishes. */
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { getMarkdownTheme, keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import { createSubagentTool } from "../subagent/index.ts";
import { discoverAgents } from "../subagent/agents.ts";

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
	const seconds = Math.max(0, Math.floor((finishedAt - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m${String(seconds % 60).padStart(2, "0")}s`;
}

function lastText(value: unknown, max = 500): string {
	const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function progressFromUpdate(update: Progress): Pick<Job, "phase" | "activity" | "draft" | "model" | "turns" | "cost"> {
	const result = update.details?.results?.at(-1);
	if (!result) return { phase: "compacting caller context", activity: [], draft: "" };
	const activity: string[] = [];
	let draft = "";
	for (const message of result.messages.slice(-20)) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall") activity.push(`Called ${part.name}: ${lastText(JSON.stringify(part.arguments), 140)}`);
				else if (part.type === "text") draft = lastText(part.text, 1000);
			}
		} else if (message.role === "toolResult") {
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
			activity.push(`${message.isError ? "Failed" : "Finished"} ${message.toolName}${text ? `: ${lastText(text, 180)}` : ""}`);
		}
	}
	return {
		phase: "working", activity: activity.slice(-RECENT_ACTIVITY), draft,
		model: result.model ?? result.requestedModel,
		turns: result.usage.turns, cost: result.usage.cost,
	};
}

function formatJob(job: Job, expanded: boolean): string {
	const lines = [`${job.name} (${job.agent}): ${job.status} · ${elapsed(job.startedAt, job.finishedAt)}`];
	if (job.status === "running") {
		lines.push(`Phase: ${job.phase ?? "starting"}`);
		if (job.model) lines.push(`Model: ${job.model}`);
		if (job.turns || job.cost) lines.push(`Turns: ${job.turns ?? 0} · Cost: $${(job.cost ?? 0).toFixed(4)}`);
		if (job.activity?.length) {
			lines.push(`Last activity: ${job.activity.at(-1)}`);
			if (expanded && job.activity.length > 1) lines.push("Recent activity:", ...job.activity.slice(0, -1).map((item) => `- ${item}`));
		}
		if (expanded && job.draft) lines.push("Latest assistant text:", job.draft);
	} else if (job.output) lines.push("", expanded ? job.output : lastText(job.output, 240));
	return lines.join("\n");
}

class JobStatusDialog extends Container {
	constructor(report: string, theme: ExtensionContext["ui"]["theme"], private close: () => void) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(" Background subagent status ")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("toolOutput", report), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Press Escape to close"), 1, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) this.close();
	}
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
		pi.sendMessage({
			customType: COMPLETION,
			content: `Background subagent ${job.name} (${job.agent}) ${job.status}.\n\n${job.output || "(no output)"}`,
			display: true,
			details: { id: job.id, name: job.name, agent: job.agent, status: job.status, cost: job.cost, startedAt: job.startedAt, finishedAt: job.finishedAt },
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
		pi.appendEntry(STATE, { action: "finish", job: { ...job } });
		try { notify(job); } catch { /* Persisted result is retried on session start. */ }
	}

	function restore(ctx: ExtensionContext): void {
		generation++;
		for (const controller of controllers.values()) controller.abort();
		controllers.clear();
		currentCtx?.ui.setStatus(STATUS_KEY, undefined);
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		jobs.clear();
		delivered.clear();
		currentCtx = ctx;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE) {
				const data = entry.data as { action?: string; job?: Job } | undefined;
				if (data?.job && (data.action === "start" || data.action === "finish")) jobs.set(data.job.name, data.job);
			} else if (entry.type === "custom_message" && entry.customType === COMPLETION) {
				const data = entry.details as { id?: string } | undefined;
				if (data?.id) delivered.add(data.id);
			}
		}
		for (const job of jobs.values()) {
			if (job.status === "running") finish(job, "interrupted", "Pi stopped or reloaded before this subagent finished. Check any file changes before retrying.");
			else if (!delivered.has(job.id)) {
				try { notify(job); } catch { /* Next session start can retry. */ }
			}
		}
		updateIndicator();
	}

	pi.registerMessageRenderer<{ id: string; name: string; agent?: string; status: Status; cost?: number; startedAt?: number; finishedAt?: number }>(
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
			box.addChild(new Markdown(body, 0, 0, getMarkdownTheme(), {
				color: (text) => theme.fg("customMessageText", text),
			}));
			return box;
		},
	);

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
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
				const tracked = [...jobs.values()].map((job) => formatJob(job, false)).join("\n\n");
				return { content: [{ type: "text" as const, text: tracked || "No background subagents tracked." }], details: { jobs: [...jobs.values()].map((job) => ({ ...job })) } };
			}
			const job = jobs.get(name);
			if (!job) return { content: [{ type: "text" as const, text: `Unknown job ${name}. Tracked: ${[...jobs.keys()].join(", ") || "none"}.` }], details: {} };
			return { content: [{ type: "text" as const, text: formatJob(job, true) }], details: { job: { ...job } } };
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { job?: Job; jobs?: Job[] } | undefined;
			if (details?.job) return new Text(theme.fg("toolOutput", formatJob(details.job, expanded)), 0, 0);
			if (details?.jobs) {
				const text = details.jobs.map((job) => formatJob(job, expanded)).join("\n\n");
				return new Text(theme.fg("toolOutput", text || "No background subagents tracked."), 0, 0);
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
				if (jobs.size === 1) name = [...jobs.keys()][0];
				else {
					const selected = await ctx.ui.select("Choose background subagent:", [...jobs.values()].map((job) => `${job.name} (${job.agent}): ${job.status}`));
					if (!selected) return;
					name = selected.split(" (")[0];
				}
			}
			const job = jobs.get(name);
			if (!job) {
				ctx.ui.notify(`Unknown background subagent: ${name}`, "warning");
				return;
			}
			const report = formatJob(job, true);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(report, "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => new JobStatusDialog(report, theme, done));
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
