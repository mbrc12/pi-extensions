import assert from "node:assert/strict";
import {
  normalModeToolNames,
  PLAN_EXIT_TOOL,
  planModeBlockReason,
  planModeToolNames,
} from "./plan-mode";

const active = [
  "read",
  "bash",
  "edit",
  "write",
  "ask_question",
  "web_use",
  "memory_search",
  "task_status",
  "subagent",
  "notes",
  "todo",
  PLAN_EXIT_TOOL,
];

assert.deepEqual(planModeToolNames(active), [
  "read",
  "ask_question",
  "web_use",
  "notes",
  "todo",
  PLAN_EXIT_TOOL,
]);

for (const toolName of ["read", "ask_question", "web_use", PLAN_EXIT_TOOL]) {
  assert.equal(planModeBlockReason(toolName, {}), undefined);
}

assert.equal(planModeBlockReason("notes", { action: "read" }), undefined);
assert.equal(planModeBlockReason("todo", { action: "list" }), undefined);

for (const [toolName, input] of [
  ["bash", { command: "git status" }],
  ["edit", { path: "src/main.ts" }],
  ["write", { path: "README.md" }],
  ["subagent", { agent: "worker" }],
  ["memory_search", { query: "plan" }],
  ["task_status", {}],
  ["notes", { action: "write" }],
  ["todo", { action: "add" }],
  ["unknown_tool", {}],
] as Array<[string, Record<string, unknown>]>) {
  assert.match(planModeBlockReason(toolName, input) ?? "", /Plan mode blocks tool/);
}

assert.deepEqual(
  normalModeToolNames(["read", PLAN_EXIT_TOOL, "write"]),
  ["read", "write"],
);

console.log("Plan mode policy tests passed");
