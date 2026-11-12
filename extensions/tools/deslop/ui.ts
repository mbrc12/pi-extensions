/**
 * Rendering. Two surfaces share one snapshot type:
 *   - the tool row (renderCall/renderResult), updated as the loop progresses
 *   - the full-screen progress and preview screens used by /deslop
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { summarize, type ScoreReport } from "./score.ts";

export interface ProgressSnapshot {
	phase: "measure" | "audit" | "pass" | "done" | "error";
	audit?: string;
	label: string;
	profile: string;
	score?: number;
	band?: string;
	previous?: number;
	pass?: number;
	passes?: number;
	sections?: number;
	sectionsDone?: number;
	rules?: number;
	report?: ScoreReport;
	message?: string;
	elapsedMs?: number;
}

const BAR_WIDTH = 12;

function bar(fraction: number, theme: any): string {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
	return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
}

/** Green at or above the default target of 90, amber in the 80s, red below. */
function scoreColor(score: number): string {
	if (score >= 90) return "success";
	if (score >= 80) return "warning";
	return "error";
}

function seconds(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Lines shown inside the tool row while the loop runs. */
export function renderProgress(snapshot: ProgressSnapshot, theme: any): string[] {
	const lines: string[] = [];
	const score = snapshot.score ?? snapshot.report?.total;
	const fraction = Math.min(1, Math.max(0, (score ?? 0) / 100));
	const passText =
		snapshot.pass !== undefined
			? theme.fg("muted", `pass ${snapshot.pass}/${snapshot.passes ?? "?"}`)
			: theme.fg("muted", snapshot.phase === "measure" ? "measuring" : snapshot.phase === "audit" ? "auditing" : "starting");

	const scoreText = score === undefined ? "" : theme.fg(scoreColor(score), score.toFixed(1));
	const delta =
		snapshot.previous !== undefined && score !== undefined && score !== snapshot.previous
			? theme.fg("muted", ` ← ${snapshot.previous.toFixed(1)}`)
			: "";

	lines.push(`${bar(fraction, theme)} ${scoreText}${delta} ${passText}`);

	if (snapshot.phase === "audit") {
		lines.push(theme.fg("muted", `auditing structure${snapshot.sections ? ` across ${snapshot.sections} sections` : ""}`));
	} else if (snapshot.phase === "pass" && snapshot.sections) {
		lines.push(
			theme.fg(
				"muted",
				`${snapshot.sectionsDone ?? 0}/${snapshot.sections} sections · ${snapshot.rules ?? 0} rules flagged · ${snapshot.profile}`,
			),
		);
	} else if (snapshot.phase === "measure") {
		lines.push(theme.fg("muted", `measuring ${snapshot.profile}`));
	}
	if (snapshot.message) lines.push(theme.fg("warning", snapshot.message));
	return lines;
}

/** One-line summary for the settled tool row and the command footer. */
export function renderSummary(snapshot: ProgressSnapshot, theme: any): string {
	const report = snapshot.report;
	if (!report) {
		return snapshot.phase === "error"
			? theme.fg("error", snapshot.message ?? "failed")
			: theme.fg("muted", snapshot.message ?? "unchanged");
	}
	const delta = snapshot.previous !== undefined ? report.total - snapshot.previous : 0;
	const sign = delta > 0 ? "+" : "";
	const change = snapshot.previous !== undefined ? theme.fg("muted", ` (${sign}${delta.toFixed(1)})`) : "";
	const status = snapshot.phase === "error" ? theme.fg("error", "✗ ") : theme.fg(scoreColor(report.total), "● ");
	const elapsed = snapshot.elapsedMs ? theme.fg("dim", ` · ${seconds(snapshot.elapsedMs)}`) : "";
	return `${status}${theme.fg(scoreColor(report.total), report.total.toFixed(1))}${change}${elapsed} ${theme.fg("muted", `${report.band} · ${snapshot.label}`)}`;
}

export function renderExpandedDetails(report: ScoreReport, theme: any): string[] {
	const lines = [
		theme.fg("muted", `plain ${report.axes.plain} · human ${report.axes.human} · structured ${report.axes.structured} · dense ${report.axes.dense}`),
		theme.fg("dim", `${report.words} words · ${report.sentences} sentences · grade ${report.metrics.gradeLevel} · ${report.profile}`),
	];
	for (const hit of report.hits.slice(0, 8)) {
		lines.push(`  ${theme.fg("warning", hit.label)} ${theme.fg("dim", `(${(hit.penalty * 100).toFixed(0)}%)`)}`);
		if (hit.evidence[0]) lines.push(`    ${theme.fg("dim", truncateToWidth(hit.evidence[0], 90))}`);
	}
	return lines;
}

/** Full-screen live progress for /deslop. */
export class ProgressScreen implements Component {
	private snapshot: ProgressSnapshot;
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private frameIndex = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private startedAt = Date.now();

	constructor(
		private tui: any,
		private theme: any,
		initial: ProgressSnapshot,
		private done: (value: { aborted?: boolean }) => void,
	) {
		this.snapshot = initial;
		// A model call can run for 30 seconds. Without its own clock the spinner
		// stops between progress events and the screen looks hung.
		this.timer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.requestRender();
		}, 110);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private requestRender(): void {
		try {
			this.tui.requestRender();
		} catch {
			// The screen may be closing; a missed frame is harmless.
		}
	}

	/** Call before done(): the interval must not outlive the screen. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	update(snapshot: ProgressSnapshot): void {
		this.snapshot = snapshot;
		this.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const spinner = theme.fg("accent", this.frames[this.frameIndex]);
		const body = renderProgress(this.snapshot, theme);
		const elapsed = seconds(Date.now() - this.startedAt);
		const lines = [
			"",
			truncateToWidth(
				`  ${spinner} ${theme.bold("deslop")} ${theme.fg("muted", this.snapshot.label)} ${theme.fg("dim", elapsed)}`,
				width,
			),
			"",
			...body.map((line) => truncateToWidth(`  ${line}`, width)),
			"",
			truncateToWidth(`  ${theme.fg("dim", "esc to cancel")}`, width),
			"",
		];
		return lines;
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "\u0003") {
			this.stop();
			this.done({ aborted: true });
		}
	}

	invalidate(): void {}
}

export interface PreviewResult {
	action: "close" | "edit" | "save";
}

/** Scrollable preview of a long rewrite, used by /deslop. Renders as Markdown. */
export class PreviewScreen implements Component {
	private offset = 0;
	private markdown: Markdown | undefined;
	private lines: string[] = [];

	constructor(
		private tui: any,
		private theme: any,
		private header: string[],
		private body: string,
		private done: (value: PreviewResult) => void,
	) {}

	private height(): number {
		const rows = (this.tui?.terminal?.rows as number | undefined) ?? (process.stdout.rows || 40);
		return Math.max(6, rows - this.header.length - 6);
	}

	private clampOffset(): void {
		const max = Math.max(0, this.lines.length - this.height());
		this.offset = Math.min(Math.max(0, this.offset), max);
	}

	private rendered(width: number): string[] {
		// Markdown caches per width internally; keep one instance so scrolling stays cheap.
		if (!this.markdown) this.markdown = new Markdown(this.body, 0, 0, getMarkdownTheme());
		return this.markdown.render(Math.max(24, width - 2));
	}

	render(width: number): string[] {
		this.lines = this.rendered(width);
		this.clampOffset();

		const theme = this.theme;
		const height = this.height();
		const visible = this.lines.slice(this.offset, this.offset + height);
		const percent = this.lines.length ? Math.round(((this.offset + height) / this.lines.length) * 100) : 100;
		const scrollNote = theme.fg(
			"dim",
			`${Math.min(percent, 100)}%  ${this.offset + 1}-${Math.min(this.offset + height, this.lines.length)}/${this.lines.length}`,
		);
		const rule = theme.fg("border", "─".repeat(Math.max(0, Math.min(width - 2, 100))));

		const out: string[] = [""];
		for (const line of this.header) out.push(truncateToWidth(`  ${line}`, width));
		out.push(truncateToWidth(`  ${scrollNote}`, width));
		out.push(rule);
		// Markdown output is already wrapped and styled; do not re-truncate it.
		out.push(...visible.map((line) => `  ${line}`));
		out.push(rule);
		out.push(truncateToWidth(`  ${theme.fg("dim", "j/k scroll · g/G top/bottom · e editor · s save · q close")}`, width));
		return out;
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.height() - 2);
		if (data === "j" || data === "\u001b[B") this.offset += 1;
		else if (data === "k" || data === "\u001b[A") this.offset -= 1;
		else if (data === " " || data === "\u0004" || data === "\u001b[6~") this.offset += page;
		else if (data === "b" || data === "\u0015" || data === "\u001b[5~") this.offset -= page;
		else if (data === "g") this.offset = 0;
		else if (data === "G") this.offset = this.lines.length;
		else if (data === "e") return this.done({ action: "edit" });
		else if (data === "s") return this.done({ action: "save" });
		else if (data === "q" || data === "\u001b" || data === "\u0003") return this.done({ action: "close" });
		this.clampOffset();
		this.tui.requestRender();
	}

	invalidate(): void {
		this.markdown?.invalidate();
	}
}

export { summarize };
