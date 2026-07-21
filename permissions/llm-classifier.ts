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

Classify by the command's actual semantics, not by whether the syntax looks complex or by whether you recognize the exact program name. Do not require an allow-list match. If the visible operation is clearly read-only/non-mutating, choose "allow" even when it uses shell pipelines, loops, heredocs, one-liners, variables, globbing, filters, dataframes, database SELECTs, HTTP fetches, or subprocess wrappers.

Meanings:
- "allow": the command only reads, inspects, searches, formats, transforms, prints, counts, summarizes, validates, fetches data without saving/executing it, or runs build/test/check/lint-style tasks; OR it writes only inside the working directory; OR it writes only under /tmp or /var/tmp.
- "dangerous": the command clearly writes/deletes/modifies something outside the working directory or temp dirs, performs privileged/system-level changes, force-pushes/deletes remote refs, resets/cleans destructively, executes fetched code, or otherwise has obvious external destructive effects.
- "escalate": use only for genuine ambiguity where you cannot tell whether it mutates important state or where the command may affect external systems and is not clearly read-only.

Decision rules:
- Prefer "allow" for clearly read-only inspection, even if multiple commands are composed with &&, ;, pipes, command substitution, for/while loops, or language snippets.
- Redirection to /dev/null, stdout, stderr, or a temp path is "allow". Redirection to a project-relative path is "allow". Redirection to an unclear or non-temp absolute path is "escalate" or "dangerous" depending on whether it is clearly outside the working directory.
- Relative file writes/deletes are inside the working directory and are "allow". Absolute writes/deletes under /tmp or /var/tmp are "allow" for writes and "escalate" for deletes. Absolute writes/deletes elsewhere outside the working directory are "dangerous".
- Version-control reads are "allow". Operations that update branches, working tree, index, history, stash, or remotes are "escalate" unless clearly destructive, such as force/delete push, hard reset, or clean, which are "dangerous".
- Package/dependency installs, updates, removes, publishing, deployment, service control, and process signaling are "escalate" unless clearly destructive/system-wide, then "dangerous". Build/test/check/lint commands are "allow".
- Network downloads/fetches that only display data are "allow". Saving a download to a file follows the path rules above. Piping fetched content to a shell/interpreter is "dangerous".
- For Python/node/ruby/go snippets, judge the operations inside. Pure reads/transforms/prints are "allow". Dataframe reads/scans/describes/collects, JSON formatting, filesystem stats/listing, and SELECT-only database queries are "allow". Writes/deletes follow the path rules above.
- For subprocess.run/subprocess.call/spawn/exec wrappers, classify the wrapped command by the same semantic rules instead of escalating just because a subprocess is used.
- Database queries that are visibly read-only, such as SELECT/SHOW/EXPLAIN/DESCRIBE, are "allow". INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE or unknown SQL is "escalate".

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
