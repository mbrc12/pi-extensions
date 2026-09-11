import type { PermissionMode } from "./types";

export type NormalPermissionMode = Exclude<PermissionMode, "plan">;

export const PLAN_EXIT_TOOL = "plan_exit";

/**
 * Plan mode is deny-by-default. These tools either read state, ask the user,
 * or enforce their own read-only execution boundary.
 */
export const PLAN_ALLOWED_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "ask_question",
  "quiz",
  "web_use",
  "py_explore",
  PLAN_EXIT_TOOL,
]);

const PLAN_CONDITIONAL_TOOLS = new Set(["notes", "todo"]);

export const PLAN_MODE_SYSTEM_PROMPT = `## Plan mode

Plan mode is active. The user has not approved implementation.

- Explore the project and resolve discoverable facts before asking questions.
- Do not edit files, run shell commands, launch subagents, or change external state.
- Use ask_question for decisions and preferences that materially affect the plan.
- Produce a decision-complete implementation plan with scope, concrete changes, risks, and verification.
- When the plan is ready, call plan_exit with the complete Markdown plan.
- Do not ask for plan approval in normal text; plan_exit handles approval.
- After plan_exit reports approval, end the response without calling more tools. Pi will start implementation in a fresh turn.

These restrictions remain active even if a user message asks you to implement. Only an approved plan_exit call or an explicit user mode change can schedule the transition out of plan mode.`;

export function uniqueToolNames(names: string[]): string[] {
  return [...new Set(names)];
}

/** Hide every tool that is not explicitly safe during planning. */
export function planModeToolNames(availableNames: string[]): string[] {
  return uniqueToolNames(
    availableNames.filter(
      (name) => PLAN_ALLOWED_TOOLS.has(name) || PLAN_CONDITIONAL_TOOLS.has(name),
    ),
  );
}

/** Restore the prior tool surface while hiding the plan-only exit control. */
export function normalModeToolNames(previousNames: string[]): string[] {
  return uniqueToolNames(
    previousNames.filter((name) => name !== PLAN_EXIT_TOOL),
  );
}

/**
 * Return a block reason for a tool call that is not safe in plan mode.
 * A few mixed read/write metadata tools are allowed only for their read action.
 */
export function planModeBlockReason(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (PLAN_ALLOWED_TOOLS.has(toolName)) return undefined;
  if (toolName === "notes" && input.action === "read") return undefined;
  if (toolName === "todo" && input.action === "list") return undefined;

  return `Plan mode blocks tool "${toolName}". Finish the plan and call ${PLAN_EXIT_TOOL} for approval before implementation.`;
}
