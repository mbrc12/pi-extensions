import { describe, expect, mock, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// Pi resolves these packages when it loads extensions. Mock them for a standalone Bun test.
mock.module("@earendil-works/pi-ai", () => ({ StringEnum: () => ({}) }));
mock.module("typebox", () => ({ Type: { Object: () => ({}), String: () => ({}), Integer: () => ({}), Optional: () => ({}) } }));
const { recall, default: registerContext } = await import("../context.ts");

function user(id: string, content: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content, timestamp: 0 } };
}

function assistant(id: string): SessionEntry {
	return {
		type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00Z",
		message: { role: "assistant", content: [
			{ type: "thinking", thinking: "private phrase" },
			{ type: "text", text: "visible phrase" },
			{ type: "toolCall", id: "call1", name: "read", arguments: { path: "notes.txt" } },
		], timestamp: 0 },
	} as SessionEntry;
}

const compacted: SessionEntry = {
	type: "compaction", id: "compacted", parentId: "old", timestamp: "2026-01-01T00:00:00Z",
	summary: "Summary missed my preference", firstKeptEntryId: "new", tokensBefore: 1000,
};

describe("context recall", () => {
	test("registers a read-only tool using the current branch, not all session entries", async () => {
		let tool: any;
		registerContext({ registerTool: (definition: any) => { tool = definition; } } as any);
		expect(tool.name).toBe("context_recall");
		const ctx = { sessionManager: { getBranch: () => [user("active", "active phrase")],
			getEntries: () => [user("other", "secret other branch")] } };
		const result = await tool.execute("call", { action: "search", query: "other branch" }, undefined, undefined, ctx);
		expect(result.content[0].text).toContain("No exact text matches");
		expect(result.details).toEqual({});
	});

	test("finds old entries even across a compaction; does not search its summary", () => {
		const entries = [user("old", "I prefer polars tables"), compacted, user("new", "Continue")];
		expect(recall(entries, { action: "search", query: "POLARS" })).toContain("[old] user: I prefer polars tables");
		expect(recall(entries, { action: "search", query: "summary missed" })).toContain("No exact text matches");
	});

	test("searches only entries supplied by the active branch", () => {
		expect(recall([user("main", "choice B")], { action: "read", entryId: "other-branch" })).toContain("not found");
		expect(recall([user("main", "choice B")], { action: "search", query: "choice A" })).toContain("No exact text matches");
	});

	test("paginates newest first with bounded results", () => {
		const entries = Array.from({ length: 10 }, (_, i) => user(`id${i}`, `target ${i}`));
		const first = recall(entries, { action: "search", query: "target" });
		expect(first).toContain("page 1/2, 10 entries");
		expect(first).toContain("[id9]");
		expect(first).not.toContain("[id0]");
		const second = recall(entries, { action: "search", query: "target", page: 2 });
		expect(second).toContain("[id0]");
		expect(second).not.toContain("[id9]");
	});

	test("paginates a long exact entry and rejects bad offsets", () => {
		const entries = [user("long", "a".repeat(9000))];
		const first = recall(entries, { action: "read", entryId: "long" });
		expect(first).toContain("characters 0–8000 of 9000");
		expect(first).toContain("offset=8000");
		expect(recall(entries, { action: "read", entryId: "long", offset: 8000 })).toContain("characters 8000–9000");
		expect(recall(entries, { action: "read", entryId: "long", offset: 9001 })).toContain("Offset must");
	});

	test("does not expose assistant thinking or system messages", () => {
		const entries: SessionEntry[] = [assistant("a"), {
			type: "message", id: "sys", parentId: "a", timestamp: "2026-01-01T00:00:00Z",
			message: { role: "system", content: "system phrase", timestamp: 0 },
		} as SessionEntry];
		expect(recall(entries, { action: "search", query: "private phrase" })).toContain("No exact text matches");
		expect(recall(entries, { action: "search", query: "system phrase" })).toContain("No exact text matches");
		expect(recall(entries, { action: "search", query: "notes.txt" })).toContain("[a] assistant");
		expect(recall(entries, { action: "read", entryId: "a" })).toContain("visible phrase");
	});

	test("does not index its own searches or returned results", () => {
		const entries = [
			{ type: "message", id: "self-call", parentId: null, timestamp: "2026-01-01T00:00:00Z",
				message: { role: "assistant", content: [{ type: "toolCall", id: "self", name: "context_recall", arguments: { action: "search", query: "rare-word" } }], timestamp: 0 } } as SessionEntry,
			{ type: "message", id: "self-result", parentId: "self-call", timestamp: "2026-01-01T00:00:00Z",
				message: { role: "toolResult", toolCallId: "self", toolName: "context_recall", isError: false,
					content: [{ type: "text", text: "Found rare-word" }], timestamp: 0 } } as SessionEntry,
		];
		expect(recall(entries, { action: "search", query: "rare-word" })).toContain("No exact text matches");
	});

	test("includes tool output without indexing image data", () => {
		const entry = {
			type: "message", id: "tool", parentId: null, timestamp: "2026-01-01T00:00:00Z",
			message: { role: "toolResult", toolCallId: "call1", toolName: "bash", isError: false,
				content: [{ type: "text", text: "exit status 1" }, { type: "image", mimeType: "image/png", data: "private-image-payload" }], timestamp: 0 },
		} as SessionEntry;
		expect(recall([entry], { action: "search", query: "status 1" })).toContain("[tool] toolResult:bash");
		expect(recall([entry], { action: "read", entryId: "tool" })).not.toContain("private-image-payload");
	});
});
