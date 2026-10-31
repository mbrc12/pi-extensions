import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatSessionDisplay, getSessionDisplayEntries, renderSessionDisplayEntries } from "./session-display.ts";

test("formats system/user content, assistant text, calls, and results chronologically", () => {
	const messages = [
		{ role: "system", content: "Rules\n\nBe helpful" },
		{ role: "user", content: [{ type: "text", text: "Question" }, { type: "image", data: "private" }] },
		{ role: "assistant", content: [{ type: "text", text: "Thinking is not shown" }, { type: "thinking", thinking: "secret" }, { type: "toolCall", name: "lookup", arguments: { query: "x", limit: 2 } }] },
		{ role: "toolResult", toolName: "lookup", content: [{ type: "text", text: "Found it" }] },
		{ role: "toolResult", toolName: "broken", isError: true, content: [{ type: "text", text: "Nope" }] },
	];
	const entries = getSessionDisplayEntries(messages);
	assert.deepEqual(entries.map(({ type, label }) => [type, label]), [
		["user", "user"], ["assistant", "assistant"], ["tool", "lookup"], ["tool", "lookup result"], ["tool", "broken result"],
	]);
	assert.equal(entries[2].body, 'query = "x", limit = 2');
	const rendered = formatSessionDisplay(messages);
	assert.match(rendered, /\[tool\] lookup: query = "x", limit = 2/);
	assert.match(rendered, /\[tool\] broken result: Error: Nope/);
	assert.doesNotMatch(rendered, /secret|private/);
	assert.match(rendered, /-----\nThinking is not shown\n-----/);
	assert.doesNotMatch(rendered, /\n\n/);
});

test("omits system prompts and keeps nested tool arguments intact", () => {
	const messages = [
		{ role: "system", content: "", sections: { preamble: "Start", rules: "Rules" } },
		{ role: "assistant", content: [{ type: "toolCall", name: "find", arguments: { path: "/tmp", options: { depth: 2 }, patterns: ["*.ts"] } }] },
	];
	const text = formatSessionDisplay(messages);
	assert.doesNotMatch(text, /\[system\]/);
	assert.doesNotMatch(text, /Start Rules/);
	assert.match(text, /\[tool\] find: path = "\/tmp", options = \{"depth":2\}, patterns = \["\*\.ts"\]/);
});

test("truncates entries and keeps tool calls and results capped when expanded", () => {
	const long = "x".repeat(250);
	const messages = [
		{ role: "user", content: long },
		{ role: "assistant", content: long },
		{ role: "toolResult", toolName: "read", content: [{ type: "text", text: long }] },
	];
	const compact = getSessionDisplayEntries(messages);
	assert.equal(compact[0].body.length, 200);
	assert.ok(compact[0].body.endsWith("…"));
	assert.equal(compact[1].body.length, 200);
	assert.ok(compact[1].body.endsWith("…"));
	assert.equal(compact[2].body.length, 200);
	assert.equal(getSessionDisplayEntries(messages, { expanded: true })[0].body.length, 250);
	assert.equal(getSessionDisplayEntries(messages, { expanded: true })[1].body.length, 250);
	const expandedTool = getSessionDisplayEntries(messages, { expanded: true })[2];
	assert.equal(expandedTool.body.length, 200);
	assert.equal(expandedTool.fixed, true);
});

test("retains expanded multiline user content and renders manually supplied entries", () => {
	const entries = getSessionDisplayEntries([{ role: "user", content: "alpha\nbeta" }], { expanded: true });
	assert.equal(entries[0].body, "alpha\nbeta");
	assert.equal(renderSessionDisplayEntries(entries), "[user] alpha\nbeta");
});
