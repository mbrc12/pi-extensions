/**
 * LLM-based (Stage 2) classifier.
 *
 * Used when rule-based checks return "review" or undefined.
 * Calls a cheap classification model to decide: allow / dangerous / review.
 *
 * Model selection priority:
 *  1. Ordered fallbacks from extensions/model-config.json (permissionClassification)
 *  2. Fall back to current session model
 *  3. Fall back to "review" (ask user)
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Classification, LlmClass, ClassificationResult } from "./types";
import { getEffectiveCwdForCommand } from "./cwd";
import { COMMAND_PREVIEW_LENGTH } from "./types";
import { selectConfiguredModelWithAuth } from "../shared/model-config.ts";

// ---------------------------------------------------------------------------
// System prompt for the classifier
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for a coding agent. You receive a tool call the rule-based system could not classify. Output ONE word.

Rules:
- Shell commands that only read/inspect/display → "allow"
- Shell commands writing/deleting files OUTSIDE the working directory → "dangerous", except reads/writes under /tmp or /var/tmp are "allow"
- Shell commands writing/deleting files INSIDE the working directory → "allow"
- Shell commands with file redirections (>, >>) to a real file → "escalate" (unless clearly safe like >/dev/null)
- git push --force/--delete, git reset --hard, git clean → "dangerous"
- git push (no force flag), git checkout, git rebase, git merge, git stash → "escalate"
- git operations that are read-only (status, log, diff, show, branch) → "allow"
- Package manager commands that only run/build/test → "allow"
- Package manager installs (npm install, pip install) → "escalate"
- curl/wget piping to shell → "dangerous"
- curl/wget fetching data with no file output → "allow"
- curl -O / wget (saving files) → "escalate"
- Python/node/ruby/go one-liners that write/delete files (write_parquet, write_csv, write_excel, sink_parquet, sink_csv, write_text, to_csv, to_excel, open w mode, os.remove, shutil operations) → if the target path is relative (inside the working directory) → "allow"; if it writes an absolute path under /tmp or /var/tmp → "allow"; if it deletes under /tmp or /var/tmp → "escalate"; if it writes/deletes another absolute path outside the working directory → "dangerous"; if unclear → "escalate"
- subprocess.run / subprocess.call → judge by the command inside: if clearly read-only (ls, cat, echo, git status, git log, git diff) or a build/test command (npm test, cargo test, go test, make, pytest) → "allow"; if destructive (rm, mv, dd, sudo) → "dangerous"; otherwise → "escalate"
- Python/node/ruby/go one-liners that only read/transform (read_parquet, read_csv, scan_csv, scan_parquet, head, describe, collect, print, dumps, SELECT queries) → "allow"
- Commands that delete files (rm, rmdir) or move/copy files (mv, cp) → "escalate" (need to verify target)
- Signal commands (kill, pkill) → "escalate"
- Temp directory override: any command/tool call that only reads or writes files under /tmp or /var/tmp is "allow". This includes Python Path('/tmp/...').write_text(...), open('/tmp/...', 'w'), dataframe write_parquet('/tmp/...'), and shell redirects to /tmp. Do not escalate merely because it writes to /tmp. Deleting temp dirs/files remains "escalate".
- Database read queries (SELECT only) → "allow"
- Database writes (INSERT/UPDATE/DELETE/DROP) → "escalate"

Reply with exactly ONE word: allow, dangerous, or escalate.`;

const LLM_COMMAND_PREVIEW_LENGTH = 8000;

// ---------------------------------------------------------------------------
// Build user message for classification
// ---------------------------------------------------------------------------

export function buildClassificationPrompt(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  let inputSummary: string;

  switch (toolName) {
    case "bash": {
      const cmd = input.command as string ?? "";
      cwd = getEffectiveCwdForCommand(cmd, cwd);
      const truncated =
        cmd.length > LLM_COMMAND_PREVIEW_LENGTH
          ? cmd.slice(0, LLM_COMMAND_PREVIEW_LENGTH) +
            `... [${cmd.length - LLM_COMMAND_PREVIEW_LENGTH} more chars]`
          : cmd;
      inputSummary = `command:\n\`\`\`\n${truncated}\n\`\`\``;
      break;
    }
    case "write":
    case "edit": {
      const rawPath = input.path as string ?? "?";
      inputSummary = `path: ${rawPath}`;
      break;
    }
    case "read":
    case "grep":
    case "find":
    case "ls":
      inputSummary = `path: ${input.path ?? "?"}`;
      break;
    default:
      inputSummary = JSON.stringify(input).slice(0, COMMAND_PREVIEW_LENGTH);
  }

  return [
    `Working directory: ${cwd}`,
    `Tool: ${toolName}`,
    inputSummary,
    "",
    "Classify:",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parse classification response
// ---------------------------------------------------------------------------

function parseClassification(text: string): LlmClass {
  const clean = text.trim().toLowerCase();
  if (clean.includes("allow")) return "allow";
  if (clean.includes("dangerous") || clean.includes("block") || clean.includes("deny")) return "dangerous";
  if (clean.includes("escalate") || clean.includes("review") || clean.includes("ask") || clean.includes("unclear")) return "escalate";
  // Default: if we can't parse, escalate to user
  return "escalate";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool call using an LLM.
 * Returns undefined if no cheap model is available (→ fall back to ask user).
 */
export async function classifyWithLLM(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ClassificationResult | undefined> {
  try {
    const selected = await selectConfiguredModelWithAuth(ctx, "permissionClassification", {
      fallbackToCurrent: true,
    });
    if (!selected) return undefined;
    const { model, auth } = selected;

    const userMessage: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: buildClassificationPrompt(toolName, input, cwd),
        },
      ],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      {
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [userMessage],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal,
      },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join(" ")
      .trim();

    const classification = parseClassification(text);

    return {
      classification,
      reason: `LLM: ${text.slice(0, 100)}`,
    };
  } catch {
    // Model call failed → fall back to review
    return undefined;
  }
}
