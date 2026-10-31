import { describe, expect, mock, test } from "bun:test";

// The extension imports shared/model-config.ts, which calls getAgentDir() at load.
// Point the mock at the real agent dir so the real model-config.json is read.
mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => `${process.env.HOME}/.pi/agent`,
}));

// Replace the ask_question picker with a scriptable stand-in. The real component
// needs a live TUI, and the tests only need to know what was offered and chosen.
interface AskParams {
	question: string;
	mode: string;
	options: Array<{ label: string; description?: string }>;
	allowOther: boolean;
}
let askCalls: AskParams[] = [];
let askAnswer: (params: AskParams) => { answers: string[]; cancelled: boolean; got_custom: boolean } | null =
	(params) => ({ answers: [params.options[0]?.label ?? ""], cancelled: false, got_custom: false });

mock.module("../tools/ask-question.ts", () => ({
	askViaUI: async (params: AskParams) => {
		askCalls.push(params);
		return askAnswer(params);
	},
}));

const {
	default: register,
	fallbackSessionName,
	formatCost,
	normalizeSessionName,
	parseProposedNames,
	proposalLabel,
} = await import("../session/rename.ts");
const { getModelFallbacksForProfile, getModelFallbacks } = await import("../shared/model-config.ts");

const PROPOSALS = [
	"CSV to Parquet converter CLI",
	"CSV to Parquet conversion pipeline",
	"Missing header row handling",
];

function harness() {
	const commands = new Map<string, any>();
	const pi: any = {
		registerCommand: (name: string, command: any) => commands.set(name, command),
		setSessionName: (name: string) => {
			pi._name = name;
		},
		getSessionName: () => pi._name,
	};
	register(pi);
	askCalls = [];
	askAnswer = (params) => ({ answers: [params.options[0]?.label ?? ""], cancelled: false, got_custom: false });
	return { pi, commands, command: commands.get("rename") };
}

// A model that the home profile allows, so a candidate survives profile filtering.
const RENAME_MODEL = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

function ctxFor(
	messages: Array<{ role: string; content: string }>,
	options: { mode?: string; reply?: string } = {},
) {
	const notices: Array<[string, string]> = [];
	// Captured prompts, so tests can check what the model was actually asked.
	const prompts: string[] = [];
	// Widget writes, so tests can check the progress spinner appears and clears.
	const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
	const ctx: any = {
		mode: options.mode ?? "tui",
		sessionManager: {
			getBranch: () => messages.map((message, index) => ({
				type: "message",
				id: `e${index}`,
				message: { role: message.role, content: [{ type: "text", text: message.content }] },
			})),
		},
		ui: {
			notify: (text: string, kind: string) => notices.push([kind, text]),
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (key: string, lines: string[] | undefined) => widgets.push({ key, lines }),
		},
		modelRegistry: {
			getAvailable: async () => [RENAME_MODEL],
			find: () => RENAME_MODEL,
			getApiKeyAndHeaders: async () => ({ ok: true }),
			complete: async (_model: unknown, request: any) => {
				prompts.push(request.messages[0].content[0].text);
				return {
					stopReason: "stop",
					content: [{ type: "text", text: options.reply ?? JSON.stringify(PROPOSALS) }],
					usage: { cost: { total: 0.000234 } },
				};
			},
		},
	};
	return { ctx, notices, prompts, widgets };
}

describe("normalizeSessionName", () => {
	test("drops labels, quotes, and trailing punctuation", () => {
		expect(normalizeSessionName('Name: "Fix flaky polars join."')).toBe("Fix flaky polars join");
		expect(normalizeSessionName("**Rename extension**")).toBe("Rename extension");
		expect(normalizeSessionName("`Title: EPUB pipeline`")).toBe("EPUB pipeline");
		expect(normalizeSessionName("- Session title: Bug hunt\n")).toBe("Bug hunt");
	});

	test("flattens newlines and caps length at a word boundary", () => {
		expect(normalizeSessionName("one\ntwo\tthree")).toBe("one two three");
		const long = normalizeSessionName(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "));
		expect(long.length).toBeLessThanOrEqual(100);
		expect(long).toMatch(/^word\d+( word\d+)*$/);
	});

	test("returns an empty string when nothing usable remains", () => {
		expect(normalizeSessionName("   \n\t ")).toBe("");
		expect(normalizeSessionName('""')).toBe("");
	});
});

describe("parseProposedNames", () => {
	test("reads a JSON array in order", () => {
		expect(parseProposedNames(JSON.stringify(PROPOSALS))).toEqual(PROPOSALS);
	});

	test("reads a JSON array wrapped in prose or a code fence", () => {
		const raw = `Here are the names:\n\`\`\`json\n${JSON.stringify(PROPOSALS.slice(0, 3))}\n\`\`\``;
		expect(parseProposedNames(raw)).toEqual(PROPOSALS.slice(0, 3));
	});

	test("falls back to one name per line, stripping numbering and bullets", () => {
		const raw = "1. Whole session goal\n- Narrower recent focus\n* Latest step\n\n";
		expect(parseProposedNames(raw)).toEqual(["Whole session goal", "Narrower recent focus", "Latest step"]);
	});

	test("drops duplicates and empty names, and caps the count", () => {
		const raw = JSON.stringify(["Same name", "", "  ", "same name", "a", "b", "c", "d"]);
		expect(parseProposedNames(raw)).toEqual(["Same name", "a", "b"]);
		expect(parseProposedNames(raw, 5)).toEqual(["Same name", "a", "b", "c", "d"]);
	});

	test("ignores junk that is not a name list", () => {
		expect(parseProposedNames("```json\n[not valid\n```")).toEqual([]);
		expect(parseProposedNames("")).toEqual([]);
	});
});

describe("proposalLabel", () => {
	test("marks the ends of the ladder", () => {
		expect(proposalLabel(0, 3)).toContain("Broadest");
		expect(proposalLabel(2, 3)).toContain("Narrowest");
		expect(proposalLabel(0, 1)).toBe("Only proposal");
	});

	test("describes the middle step of three as broad", () => {
		expect(proposalLabel(1, 3)).toContain("Broad");
		expect(proposalLabel(1, 4)).toContain("Broad");
		expect(proposalLabel(2, 4)).toContain("Narrow");
	});
});

describe("formatCost", () => {
	test("keeps small costs visible", () => {
		expect(formatCost(0.000234)).toBe("$0.0002");
		expect(formatCost(0.0123)).toBe("$0.012");
		expect(formatCost(1.5)).toBe("$1.50");
		expect(formatCost(0)).toBe("$0");
	});

	test("returns undefined for missing or invalid costs", () => {
		expect(formatCost(undefined)).toBeUndefined();
		expect(formatCost(Number.NaN)).toBeUndefined();
		expect(formatCost(-1)).toBeUndefined();
	});
});

describe("fallbackSessionName", () => {
	test("uses the first user message, at most 10 words", () => {
		const name = fallbackSessionName([
			{ role: "user", text: "Make a rename extension that reads the session and names it" },
			{ role: "assistant", text: "Done." },
		]);
		expect(name).toBe("Make a rename extension that reads the session and names");
	});

	test("returns undefined without a user message", () => {
		expect(fallbackSessionName([])).toBeUndefined();
		expect(fallbackSessionName([{ role: "assistant", text: "hello" }])).toBeUndefined();
	});
});

describe("conversation sampling", () => {
	test("keeps the opening purpose and the recent work, not only the tail", async () => {
		const h = harness();
		const messages = [
			{ role: "user", content: "Build an EPUB reader for scanned books" },
			...Array.from({ length: 60 }, (_, i) => ({ role: "assistant", content: `Step ${i}: ${"x".repeat(400)}` })),
			{ role: "user", content: "Now fix the footnote popover" },
		];
		const { ctx, prompts } = ctxFor(messages);
		await h.command.handler("", ctx);
		const prompt = prompts[0];
		expect(prompt).toContain("Build an EPUB reader for scanned books");
		expect(prompt).toContain("Now fix the footnote popover");
		expect(prompt).toContain("[... middle of the session omitted ...]");
	});

	test("does not mark omitted messages when the whole session fits", async () => {
		const h = harness();
		const { ctx, prompts } = ctxFor([
			{ role: "user", content: "Rename the extension" },
			{ role: "assistant", content: "Renamed." },
		]);
		await h.command.handler("", ctx);
		expect(prompts[0]).toContain("Rename the extension");
		expect(prompts[0]).not.toContain("middle of the session omitted");
	});

	test("asks for a ladder of names, broadest first", async () => {
		const h = harness();
		const { ctx, prompts } = ctxFor([{ role: "user", content: "Name this session" }]);
		await h.command.handler("", ctx);
		const prompt = prompts[0];
		expect(prompt).toContain("ordered from broadest to narrowest");
		expect(prompt).toContain("Return only a JSON array of 3 strings");
		expect(prompt).toContain("Name 1 states the purpose of the whole conversation");
		expect(prompt).toContain("Name 3 states the purpose of the most recent discussion");
	});

	test("passes the hint to the model", async () => {
		const h = harness();
		const { ctx, prompts } = ctxFor([{ role: "user", content: "Name this session" }]);
		await h.command.handler("focus on the polars rewrite", ctx);
		expect(prompts[0]).toContain("Bias every name toward this focus from the user: focus on the polars rewrite");
	});
});

describe("sessionRename model list", () => {
	test("home profile uses deepseek-v4.1-flash then gpt-6-luna", () => {
		expect(getModelFallbacksForProfile("sessionRename", "home"))
			.toEqual([["opencode-go", "deepseek-v4.1-flash"], ["openai-codex", "gpt-6-luna"]]);
	});

	test("work profile uses openai-codex-2/gpt-6-luna", () => {
		expect(getModelFallbacksForProfile("sessionRename", "work"))
			.toEqual([["openai-codex-2", "gpt-6-luna"]]);
	});

	test("configured purpose exists for the active profile", () => {
		expect(getModelFallbacks("sessionRename").length).toBeGreaterThan(0);
	});
});

describe("/rename command", () => {
	test("offers every proposal in order, labelled by generality", async () => {
		const h = harness();
		const { ctx } = ctxFor([{ role: "user", content: "Name this session" }]);
		await h.command.handler("", ctx);
		expect(askCalls).toHaveLength(1);
		expect(askCalls[0].mode).toBe("single");
		expect(askCalls[0].allowOther).toBe(true);
		expect(askCalls[0].options.map((option) => option.label)).toEqual(PROPOSALS);
		expect(askCalls[0].options[0].description).toContain("Broadest");
		expect(askCalls[0].options[2].description).toContain("Narrowest");
	});

	test("shows a progress spinner while the model runs, then clears it", async () => {
		const h = harness();
		const { ctx, widgets } = ctxFor([{ role: "user", content: "Name this session" }]);
		let spinnerDuringRequest: string[] | undefined;
		const complete = ctx.modelRegistry.complete;
		ctx.modelRegistry.complete = async (model: unknown, request: any) => {
			spinnerDuringRequest = widgets.at(-1)?.lines;
			return complete(model, request);
		};
		await h.command.handler("", ctx);
		expect(spinnerDuringRequest?.join("")).toContain("Naming this session");
		expect(widgets.at(-1)).toEqual({ key: "rename-progress", lines: undefined });
	});

	test("uses the chosen proposal", async () => {
		const h = harness();
		const { ctx, notices } = ctxFor([{ role: "user", content: "Name this session" }]);
		askAnswer = () => ({ answers: [PROPOSALS[2]], cancelled: false, got_custom: false });
		await h.command.handler("", ctx);
		expect(h.pi._name).toBe(PROPOSALS[2]);
		expect(notices.at(-1)?.[0]).toBe("info");
		expect(notices.at(-1)?.[1]).toContain("(opencode-go/deepseek-v4.1-flash, $0.0002)");
	});

	test("accepts a typed custom answer", async () => {
		const h = harness();
		const { ctx } = ctxFor([{ role: "user", content: "Name this session" }]);
		askAnswer = () => ({ answers: ['"Polars rewrite"'], cancelled: false, got_custom: true });
		await h.command.handler("", ctx);
		expect(h.pi._name).toBe("Polars rewrite");
	});

	test("leaves the name unchanged when the picker is cancelled", async () => {
		const h = harness();
		const { ctx, notices } = ctxFor([{ role: "user", content: "Name this session" }]);
		askAnswer = () => null;
		await h.command.handler("", ctx);
		expect(h.pi._name).toBeUndefined();
		expect(notices.at(-1)?.[0]).toBe("info");
		expect(notices.at(-1)?.[1]).toContain("unchanged");
	});

	test("leaves the name unchanged when nothing was chosen", async () => {
		const h = harness();
		const { ctx } = ctxFor([{ role: "user", content: "Name this session" }]);
		askAnswer = () => ({ answers: [], cancelled: false, got_custom: false });
		await h.command.handler("", ctx);
		expect(h.pi._name).toBeUndefined();
	});

	test("takes the broadest proposal without a picker outside TUI mode", async () => {
		const h = harness();
		const { ctx, notices } = ctxFor([{ role: "user", content: "Name this session" }], { mode: "rpc" });
		await h.command.handler("", ctx);
		expect(askCalls).toHaveLength(0);
		expect(h.pi._name).toBe(PROPOSALS[0]);
		expect(notices.at(-1)?.[1]).toContain("picker needs interactive mode");
	});

	test("uses the first prompt when the model fails", async () => {
		const h = harness();
		const { ctx, notices } = ctxFor([{ role: "user", content: "Investigate the EPUB build failure" }], {
			mode: "rpc",
		});
		ctx.modelRegistry.complete = async () => {
			throw new Error("no capacity");
		};
		await h.command.handler("", ctx);
		expect(h.pi._name).toBe("Investigate the EPUB build failure");
		expect(notices.at(-1)?.[0]).toBe("warning");
		expect(notices.at(-1)?.[1]).toContain("model unavailable");
	});

	test("warns when the session has nothing to name", async () => {
		const h = harness();
		const { ctx, notices } = ctxFor([]);
		await h.command.handler("", ctx);
		expect(h.pi._name).toBeUndefined();
		expect(notices.at(-1)?.[0]).toBe("warning");
	});
});
