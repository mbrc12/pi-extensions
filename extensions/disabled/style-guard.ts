/**
 * Style guard: detect a complex final answer, drop it from model context,
 * ask for a simpler rewrite in a hidden message, and let that rewrite stand
 * as the answer.
 *
 * Deliberately conservative: only long, genuinely dense prose is resampled.
 * Manual rewrites are available from the /simple prompt template.
 *
 * Env:
 *   STYLE_GUARD_OFF=1     disable
 *   STYLE_GUARD_FORCE=1   treat every long answer as complex (testing)
 *   STYLE_GUARD_DEBUG=1   append decisions to /tmp/style-guard.log
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "style-guard";
const CUSTOM_TYPE = "style-guard";
const STATUS_TEXT = "Complex output detected, simplification requested";

/** Only substantial answers are considered. */
const MIN_PROSE_WORDS = 120;
/** Signals of density. Two of the three must fire before a resample. */
const FLESCH_MAX = 40;
const MEAN_SENTENCE_MAX = 22;
const BANNED_MIN = 4;
const MIN_SIGNALS = 2;
/** Skip answers that are mostly code or tables. */
const MAX_CODE_SHARE = 0.25;
const MAX_TABLE_ROWS = 6;
/** One resample per user turn. */
const MAX_RETRIES = 1;

const BANNED =
	/\b(should|would|may|might|could|utilise|utilize|leverage|robust|comprehensive|crucial|seamless|holistic|paradigm|notwithstanding|aforementioned|endeavour)\b/gi;

function debug(line: string): void {
	if (!process.env.STYLE_GUARD_DEBUG) return;
	try {
		appendFileSync("/tmp/style-guard.log", `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never break a run
	}
}

function textOf(message: any): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function proseOf(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/^\s*\|.*$/gm, " ")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+\.\s+/gm, "")
		.replace(/[#*_>]/g, " ")
		.replace(/\bhttps?:\/\/\S+/g, " ");
}

function sentences(prose: string): string[] {
	return prose
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function syllables(word: string): number {
	let w = word.toLowerCase().replace(/[^a-z]/g, "");
	if (!w) return 0;
	if (w.length <= 3) return 1;
	w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
	const groups = w.match(/[aeiouy]{1,2}/g);
	return Math.max(1, groups ? groups.length : 1);
}

interface Score {
	proseWords: number;
	flesch: number;
	meanSentence: number;
	banned: number;
	complex: boolean;
	reason: string;
}

function score(text: string): Score {
	const codeChars = (text.match(/```[\s\S]*?```/g) ?? []).join("").length;
	const codeShare = text.length > 0 ? codeChars / text.length : 0;
	const tableRows = (text.match(/^\s*\|.*$/gm) ?? []).length;
	const prose = proseOf(text);
	const toks = prose.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
	const proseWords = toks.length;
	const sentList = sentences(prose);
	const meanSentence = sentList.length ? proseWords / sentList.length : proseWords;
	const syl = toks.reduce((sum, t) => sum + syllables(t), 0);
	const flesch = proseWords ? 206.835 - 1.015 * meanSentence - 84.6 * (syl / proseWords) : 100;
	const banned = (prose.match(BANNED) ?? []).length;
	const forced = !!process.env.STYLE_GUARD_FORCE;

	const skip =
		proseWords < MIN_PROSE_WORDS || codeShare > MAX_CODE_SHARE || tableRows > MAX_TABLE_ROWS
			? proseWords < MIN_PROSE_WORDS
				? "short"
				: codeShare > MAX_CODE_SHARE
					? "code heavy"
					: "table heavy"
			: "";
	const signals =
		Number(flesch < FLESCH_MAX) +
		Number(meanSentence > MEAN_SENTENCE_MAX) +
		Number(banned >= BANNED_MIN);
	const dense = signals >= MIN_SIGNALS;
	const complex = forced ? skip === "" : skip === "" && dense;
	const reason = skip
		? skip
		: complex
			? `dense (${signals} signals: flesch ${flesch.toFixed(0)}, ${meanSentence.toFixed(0)}w/sentence, ${banned} flagged)`
			: `ok (flesch ${flesch.toFixed(0)}, ${meanSentence.toFixed(0)}w/sentence)`;
	return { proseWords, flesch, meanSentence, banned, complex, reason };
}

interface TurnState {
	retries: number;
	awaitingRewrite: boolean;
}

export default function (pi: ExtensionAPI) {
	if (process.env.STYLE_GUARD_OFF) return;

	let turn: TurnState = { retries: 0, awaitingRewrite: false };
	let pending: string | null = null;

	// The answer is still on screen while it streams. Replacing it here makes the
	// TUI collapse that block before the rewrite starts, so only the rewrite reads
	// as the answer.
	pi.on("message_end", async (event, ctx) => {
		const message: any = event.message;
		if (!message || message.role !== "assistant") return;
		if (turn.retries >= MAX_RETRIES) return;
		const parts = Array.isArray(message.content) ? message.content : [];
		if (parts.some((part: any) => part?.type === "toolCall")) return;
		const text = textOf(message);
		if (!text) return;
		const result = score(text);
		debug(`finished answer ${result.proseWords} prose words: ${result.reason}`);
		if (!result.complex) return;

		pending = text;
		turn.retries += 1;
		turn.awaitingRewrite = true;
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, STATUS_TEXT);
			ctx.ui.setWorkingMessage(STATUS_TEXT);
		}
		return {
			message: {
				...message,
				content: [{ type: "text", text: "Complex output detected, simplification requested." }],
			},
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType === "user") turn = { retries: 0, awaitingRewrite: false };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const projected = event.context.contextEntries;

		let lastAssistant: { id: string; text: string } | undefined;
		for (let i = projected.length - 1; i >= 0; i--) {
			const source = projected[i].sourceEntry;
			if (source.type !== "message") continue;
			if (source.message.role !== "assistant") break;
			const text = textOf(source.message);
			if (text) lastAssistant = { id: source.id, text };
			break;
		}
		if (!lastAssistant) return;

		// The rewrite landed: drop the hidden instruction so it stays out of later turns.
		if (turn.awaitingRewrite && !pending) {
			turn.awaitingRewrite = false;
			if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.setWorkingMessage();
			}
			debug(`rewrite landed: ${score(lastAssistant.text).reason}`);
			const instruction = [...projected]
				.reverse()
				.find((p) => p.sourceEntry.type === "custom_message" && p.sourceEntry.customType === CUSTOM_TYPE);
			if (instruction) {
				return { entries: [{ type: "context_edit", targetId: instruction.sourceEntry.id, replacement: null }] };
			}
			return;
		}

		if (!pending) return;
		const draft = pending;
		pending = null;
		debug("resampling");

		const instruction =
			"That answer is too dense for the reader. Rewrite it in simple English. " +
			"Keep every fact, number, name and technical term. Use short sentences, " +
			"active voice, simple tenses, and one idea per sentence. " +
			"Put the answer first. Return the rewritten answer only, in the same overall shape.\n\n" +
			"Answer to rewrite:\n<<<\n" +
			draft +
			"\n>>>";

		return {
			entries: [{ type: "custom_message", customType: CUSTOM_TYPE, content: instruction, display: false }],
			continue: true,
		};
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWorkingMessage();
		}
	});
}
