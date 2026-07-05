/**
 * LLM-based (Stage 2) classifier.
 *
 * Used when rule-based checks return "review" or undefined.
 * Calls a cheap classification model to decide: allow / dangerous / review.
 *
 * Model selection priority:
 *  1. Cheap opencode-go models (deepseek-v4-flash, mimo-v2.5, minimax-m2.7, kimi-k2.6)
 *  2. Standard API cheap models (openai gpt-4o-mini, anthropic haiku, etc.)
 *  3. Fall back to current session model
 *  4. Fall back to "review" (ask user)
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent";
import type { Classification, LlmClass, ClassificationResult } from "./types";
import { COMMAND_PREVIEW_LENGTH } from "./types";

// ---------------------------------------------------------------------------
// System prompt for the classifier
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM_PROMPT = `You are a security classifier for a coding agent. You receive a tool call the rule-based system could not classify. Output ONE word.

Rules:
- Shell commands that only read/inspect/display → "allow"
- Shell commands writing/deleting files OUTSIDE the working directory → "dangerous"
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
- Python/node/ruby/go one-liners that write/delete files (write_parquet, write_csv, write_excel, sink_parquet, sink_csv, write_text, to_csv, to_excel, open w mode, os.remove, shutil operations) → if the target path is relative (inside the working directory) → "allow"; if an absolute path outside the working directory → "dangerous"; if unclear → "escalate"
- subprocess.run / subprocess.call → judge by the command inside: if clearly read-only (ls, cat, echo, git status, git log, git diff) or a build/test command (npm test, cargo test, go test, make, pytest) → "allow"; if destructive (rm, mv, dd, sudo) → "dangerous"; otherwise → "escalate"
- Python/node/ruby/go one-liners that only read/transform (read_parquet, read_csv, scan_csv, scan_parquet, head, describe, collect, print, dumps, SELECT queries) → "allow"
- Commands that delete files (rm, rmdir) or move/copy files (mv, cp) → "escalate" (need to verify target)
- Signal commands (kill, pkill) → "escalate"
- Commands operating on temp dirs (/tmp) → "escalate"
- Database read queries (SELECT only) → "allow"
- Database writes (INSERT/UPDATE/DELETE/DROP) → "escalate"

Reply with exactly ONE word: allow, dangerous, or escalate.`;

// ---------------------------------------------------------------------------
// Cheap model candidates
// ---------------------------------------------------------------------------

const CHEAP_MODEL_CANDIDATES: Array<[provider: string, id: string]> = [
  // OpenCode Go (cheap subscription-backed models)
  ["opencode-go", "deepseek-v4-flash"],
  ["opencode-go", "mimo-v2.5"],
  ["opencode-go", "minimax-m2.7"],
  ["opencode-go", "kimi-k2.6"],
  // Standard API-based cheap models
  ["openai", "gpt-4o-mini"],
  ["openai", "gpt-4.1-mini"],
  ["anthropic", "claude-haiku-3-5"],
  ["google", "gemini-2.0-flash"],
];

// ---------------------------------------------------------------------------
// Find an available cheap model
// ---------------------------------------------------------------------------

function findCheapModel(ctx: ExtensionContext): Model | undefined {
  // Try well-known cheap models first (exact match)
  for (const [provider, idPattern] of CHEAP_MODEL_CANDIDATES) {
    const model = ctx.modelRegistry.find(provider, idPattern);
    if (model) return model;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Build user message for classification
// ---------------------------------------------------------------------------

function buildClassificationPrompt(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  let inputSummary: string;

  switch (toolName) {
    case "bash": {
      const cmd = input.command as string ?? "";
      const truncated =
        cmd.length > COMMAND_PREVIEW_LENGTH
          ? cmd.slice(0, COMMAND_PREVIEW_LENGTH) +
            `... [${cmd.length - COMMAND_PREVIEW_LENGTH} more chars]`
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
  const model = findCheapModel(ctx) ?? ctx.model;
  if (!model) return undefined;

  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;

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
