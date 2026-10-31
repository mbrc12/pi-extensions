import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

const piDir = process.env.PI_CODING_AGENT_DIR ?? "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const requireFromPi = createRequire(`${piDir}/package.json`);
const codingAgent = await import(`${piDir}/dist/index.js`);
const tui = await import(requireFromPi.resolve("@earendil-works/pi-tui"));
const ai = await import(`${piDir}/node_modules/@earendil-works/pi-ai/dist/index.js`);
const typebox = await import(requireFromPi.resolve("typebox"));
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
mock.module("@earendil-works/pi-tui", () => tui);
mock.module("@earendil-works/pi-ai", () => ai);
mock.module("typebox", () => typebox);
const { createSubagentTool } = await import("../agents/subagent/index.ts");

const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
const path = "a".repeat(250);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
const result = { agent: "scout", task: "Look", exitCode: 0, usage, messages: [
  { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path, options: { depth: 2 } } }] },
  { role: "toolResult", toolName: "read", content: [{ type: "text", text: path }] },
  { role: "assistant", content: [{ type: "text", text: "Done." }] },
] };

describe("subagent compact session display", () => {
  for (const mode of ["single", "parallel", "chain"]) {
    test(`shows compact and expanded ${mode} sessions`, () => {
      const tool = createSubagentTool({} as any);
      const rendered = { content: [{ type: "text", text: "Done." }], details: { mode, results: [result] } };
      const compact = tool.renderResult(rendered as any, { expanded: false } as any, theme as any, {} as any).render(500).join("\n");
      const expanded = tool.renderResult(rendered as any, { expanded: true } as any, theme as any, {} as any).render(500).join("\n");
      expect(compact).toContain("[tool] read: path = ");
      expect(compact).toContain("…");
      expect(compact).not.toContain(path);
      expect(expanded).not.toContain(path);
      expect(expanded).toContain("…");
      expect(expanded).toContain("[tool] read result: ");
      expect(expanded).not.toContain(`[tool] read result: ${path}`);
      expect(expanded).toContain("Done.");
      expect(expanded).not.toContain("Session activity");
    });
  }
});
