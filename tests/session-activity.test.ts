import { describe, expect, test } from "bun:test";
import { compactActivityText, extractSessionActivity, formatDuration, formatSessionTranscript, renderRecentActivity, renderSessionActivity } from "../agents/shared/session-activity.ts";

describe("shared session activity primitives", () => {
	test("preserves both existing duration display conventions", () => {
		expect(formatDuration(9_600)).toBe("9.6s");
		expect(formatDuration(65_000)).toBe("1m05s");
		expect(formatDuration(3_661_000)).toBe("1h01m");
		expect(formatDuration(65_000, "clock")).toBe("1m05s");
		expect(formatDuration(3_661_000, "clock")).toBe("1h01m01s");
		expect(formatDuration(-1, "clock")).toBe("0s");
	});

	test("extracts bounded activity and the latest draft", () => {
		const messages: any[] = [
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/a" } }] },
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: " file contents " }] },
			{ role: "assistant", content: [{ type: "text", text: "  Current\n draft " }] },
		];
		expect(extractSessionActivity(messages)).toEqual({
			activity: ['Called read: {"path":"/tmp/a"}', "Finished read: file contents"],
			draft: "Current draft",
		});
		expect(compactActivityText("abcdef", 3)).toBe("abc…");
	});

	test("renders a reusable compact or expanded transcript summary", () => {
		const session = { activity: ["Called read: {\"path\":\"a\"}", "Finished read: contents"], draft: "Current assistant thought" };
		expect(renderSessionActivity(session, false)).toEqual([
			"Last activity: Finished read: contents",
			"Assistant:",
			"Current assistant thought",
		]);
		expect(renderSessionActivity(session, true)).toEqual([
			"Last activity: Finished read: contents",
			"Recent activity:",
			'- Called read: {"path":"a"}',
			"Latest assistant text:",
			"Current assistant thought",
		]);
		expect(renderSessionActivity({ activity: [], draft: "" }, true)).toEqual([]);
	});

	test("renders recent activity with the established collapsed and expanded labels", () => {
		expect(renderRecentActivity(["one", "two"], false)).toEqual(["Last activity: two"]);
		expect(renderRecentActivity(["one", "two"], true)).toEqual(["Last activity: two", "Recent activity:", "- one"]);
		expect(renderRecentActivity([], true)).toEqual([]);
	});

	test("formats a chronological readable transcript and omits private thinking", () => {
		const messages: any[] = [
			{ role: "user", content: [{ type: "text", text: "Please inspect this.\nKeep the output readable." }] },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "private chain of thought" },
				{ type: "text", text: "I’ll inspect it now." },
				{ type: "toolCall", name: "read", arguments: { path: "src/file.ts" } },
			] },
			{ role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "first line\nsecond line\nthird line" }] },
			{ role: "assistant", content: [{ type: "text", text: "Done." }] },
		];
		expect(formatSessionTranscript(messages)).toBe([
			"USER\nPlease inspect this.\nKeep the output readable.",
			"ASSISTANT\nI’ll inspect it now.",
			"TOOL CALL · read\n  {\"path\":\"src/file.ts\"}",
			"RESULT · read\n  first line\n  second line\n  third line",
			"ASSISTANT\nDone.",
		].join("\n\n"));
		expect(formatSessionTranscript(messages)).not.toContain("private chain of thought");
	});

	test("renders the full Markdown session without truncating messages or tool output", () => {
		const messages: any[] = Array.from({ length: 55 }, (_, i) => ({ role: "user", content: `Assignment ${i}` }));
		messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: `${"x".repeat(3000)}\n\`\`\`\nend` }] });
		const text = formatSessionTranscript(messages, { messageLimit: Infinity, entryLimit: Infinity, textChars: Infinity, markdown: true });
		expect(text).toContain("### Assignment\n\nAssignment 0");
		expect(text).toContain("Assignment 54");
		expect(text).toContain("x".repeat(3000));
		expect(text).toContain("\n```\nend\n````");
	});

	test("bounds message history, entries, and multiline block size", () => {
		const messages: any[] = [
			{ role: "user", content: [{ type: "text", text: "older" }] },
			{ role: "assistant", content: [{ type: "text", text: "123456789" }] },
			{ role: "toolResult", toolName: "run", isError: true, content: [{ type: "text", text: "failure\ndetails" }] },
		];
		expect(formatSessionTranscript(messages, { messageLimit: 2, textChars: 8 })).toBe([
			"ASSISTANT\n12345678…",
			"ERROR · run\n  failure…",
		].join("\n\n"));
		expect(formatSessionTranscript(messages, { entryLimit: 1 })).toBe("ERROR · run\n  failure\n  details");
		expect(formatSessionTranscript(messages, { messageLimit: 0 })).toBe("");
		expect(formatSessionTranscript(messages, { entryLimit: 0 })).toBe("");
	});
});
