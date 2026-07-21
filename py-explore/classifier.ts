/**
 * py_explore write classifier.
 *
 * Two-stage gate:
 *   1. Regex deny-list catches obvious file writes/deletes cheaply.
 *   2. A cheap LLM answers "does this code write/delete anything?" as a failsafe.
 *
 * Regex is intentionally conservative (low false-positive rate). It is OK if it
 * misses some obfuscated writes — the LLM catches those.
 */

import type { UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, Model, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { selectConfiguredModelWithAuth } from "../shared/model-config.ts";

export interface WriteCheckResult {
  allowed: boolean;
  reason: string;
  source: "regex" | "llm" | "error";
}

export interface WriteCheckContext {
  model: Model;
  modelRegistry: ModelRegistry;
  cwd?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Regex deny-list: unambiguous file-system write/delete/create operations.
// These block immediately without calling the LLM.
// ---------------------------------------------------------------------------

export const WRITE_INDICATORS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bopen\s*\(\s*[^)]*['"][^'"]*['"]\s*,\s*['"][^'"]*[wax+]/, reason: "open() with write/append mode" },
  { pattern: /\bwrite_parquet\b/, reason: "polars/pandas write_parquet" },
  { pattern: /\bwrite_csv\b/, reason: "polars/pandas write_csv" },
  { pattern: /\bwrite_excel\b/, reason: "write_excel" },
  { pattern: /\bwrite_json\b/, reason: "write_json" },
  { pattern: /\bwrite_ipc\b/, reason: "write_ipc" },
  { pattern: /\bwrite_ndjson\b/, reason: "write_ndjson" },
  { pattern: /\bwrite_avro\b/, reason: "write_avro" },
  { pattern: /\bwrite_delta\b/, reason: "write_delta" },
  { pattern: /\bwrite_table\b/, reason: "pyarrow write_table" },
  { pattern: /\bsink_parquet\b/, reason: "polars sink_parquet" },
  { pattern: /\bsink_csv\b/, reason: "polars sink_csv" },
  { pattern: /\bsink_ipc\b/, reason: "polars sink_ipc" },
  { pattern: /\bsink_ndjson\b/, reason: "polars sink_ndjson" },
  { pattern: /\.to_csv\s*\(/, reason: "pandas to_csv" },
  { pattern: /\.to_excel\s*\(/, reason: "pandas to_excel" },
  { pattern: /\.to_parquet\s*\(/, reason: "pandas to_parquet" },
  { pattern: /\.to_feather\s*\(/, reason: "pandas to_feather" },
  { pattern: /\.to_pickle\s*\(/, reason: "pandas to_pickle" },
  { pattern: /\.to_hdf\s*\(/, reason: "pandas to_hdf" },
  { pattern: /\.to_sql\s*\(/, reason: "pandas to_sql" },
  { pattern: /\.to_stata\s*\(/, reason: "pandas to_stata" },
  { pattern: /\bos\.remove\s*\(/, reason: "os.remove" },
  { pattern: /\bos\.unlink\s*\(/, reason: "os.unlink" },
  { pattern: /\bos\.rmdir\s*\(/, reason: "os.rmdir" },
  { pattern: /\bos\.mkdir\s*\(/, reason: "os.mkdir" },
  { pattern: /\bos\.makedirs\s*\(/, reason: "os.makedirs" },
  { pattern: /\bos\.rename\s*\(/, reason: "os.rename" },
  { pattern: /\bos\.replace\s*\(/, reason: "os.replace" },
  { pattern: /\bshutil\.rmtree\s*\(/, reason: "shutil.rmtree" },
  { pattern: /\bshutil\.move\s*\(/, reason: "shutil.move" },
  { pattern: /\bshutil\.copy\s*\(/, reason: "shutil.copy" },
  { pattern: /\bshutil\.copytree\s*\(/, reason: "shutil.copytree" },
  { pattern: /\.write_text\s*\(/, reason: "Path.write_text" },
  { pattern: /\.write_bytes\s*\(/, reason: "Path.write_bytes" },
  { pattern: /\.unlink\s*\(/, reason: "Path.unlink" },
  { pattern: /\.rmdir\s*\(/, reason: "Path.rmdir" },
  { pattern: /\.mkdir\s*\(/, reason: "Path.mkdir" },
  { pattern: /\.rename\s*\(/, reason: "Path.rename" },
  { pattern: /\.replace\s*\(/, reason: "Path.replace" },
  { pattern: /\bpickle\.dump\s*\(/, reason: "pickle.dump" },
  { pattern: /\bjson\.dump\s*\(/, reason: "json.dump" },
  { pattern: /\bcsv\.writer\s*\(/, reason: "csv.writer" },
  { pattern: /\.savefig\s*\(/, reason: "matplotlib savefig" },
  { pattern: /\.save\s*\(/, reason: "PIL/soup save" },
];

export function regexSuggestsWrite(code: string): { matches: boolean; reason: string } {
  for (const { pattern, reason } of WRITE_INDICATORS) {
    if (pattern.test(code)) {
      return { matches: true, reason };
    }
  }
  return { matches: false, reason: "" };
}

// ---------------------------------------------------------------------------
// LLM failsafe
// ---------------------------------------------------------------------------

export const WRITE_CHECK_SYSTEM_PROMPT = `You are a security gate for a read-only Python execution tool.

Your job: decide whether the provided Python code performs any filesystem write, delete, rename, move, copy, create, or overwrite operation — either directly or by spawning a subprocess/external command that would do so.

Output requirements:
- Reply with exactly one line.
- Start with either YES or NO, followed by a colon and a one-sentence reason.

Examples of correct replies:
NO: it only reads a parquet file and prints the head.
YES: it calls write_parquet with a file path.
NO: it only runs subprocess.run(['ls', '-la']) which is read-only.
YES: subprocess.run(['rm', 'file.txt']) deletes a file.
NO: it only transforms data in memory and prints it.
YES: open('out.txt', 'w').write('x') creates a file.

Treat writes to stdout/stderr as safe. Treat network reads (requests.get, urllib) as safe unless they upload data.

Treat read-only or build/test subprocesses as safe: ls, cat, echo, git status/log/diff/show, npm test, cargo test, go test, make, pytest. Treat subprocesses that modify files or state as unsafe: rm, mv, cp, git push, git reset --hard, npm install/add/update/remove, pip install.

Code:`;

function extractText(message: {
  content?: Array<{ type?: string; text?: string }>;
}): string {
  return (message.content ?? [])
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function llmSaysWrite(
  code: string,
  ctx: WriteCheckContext,
): Promise<{ writes: boolean; raw: string }> {
  const selected = await selectConfiguredModelWithAuth(ctx, "pythonWriteClassification", {
    fallbackToCurrent: true,
  });
  if (!selected) {
    throw new Error("No API key available for LLM write check");
  }
  const { model, auth } = selected;

  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: `\`\`\`python\n${code}\n\`\`\``, 
      },
    ],
  };

  const { complete } = await import("@earendil-works/pi-ai/compat");

  const response = await complete(
    model,
    { systemPrompt: WRITE_CHECK_SYSTEM_PROMPT, messages: [userMessage] },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal: ctx.signal,
    },
  );

  const raw = extractText(response);
  const clean = raw.toUpperCase();
  const writes = clean.startsWith("YES");

  return { writes, raw };
}

// ---------------------------------------------------------------------------
// Public gate
// ---------------------------------------------------------------------------

export async function checkWriteAllowed(
  code: string,
  ctx: WriteCheckContext,
): Promise<WriteCheckResult> {
  const trimmed = code.trim();
  if (!trimmed) {
    return { allowed: true, reason: "Empty code", source: "regex" };
  }

  const regex = regexSuggestsWrite(trimmed);
  if (regex.matches) {
    return {
      allowed: false,
      reason: `Regex flagged write/delete indicator: ${regex.reason}`,
      source: "regex",
    };
  }

  try {
    const llm = await llmSaysWrite(trimmed, ctx);
    if (llm.writes) {
      return {
        allowed: false,
        reason: `LLM write check failed: ${llm.raw}`,
        source: "llm",
      };
    }
    return {
      allowed: true,
      reason: `LLM write check passed: ${llm.raw}`,
      source: "llm",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      allowed: false,
      reason: `Write-check error (failing closed): ${message}`,
      source: "error",
    };
  }
}

// ---------------------------------------------------------------------------
// Adapter for the standard ExtensionContext passed to pi tools/commands
// ---------------------------------------------------------------------------

export function checkWriteAllowedFromExtension(
  code: string,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "cwd" | "signal">,
): Promise<WriteCheckResult> {
  return checkWriteAllowed(code, {
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    cwd: ctx.cwd,
    signal: ctx.signal,
  });
}
