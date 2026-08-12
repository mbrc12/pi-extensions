import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { UserMessage } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { completeWithModelFallback } from "../shared/model-config.ts";

const WebUseParams = Type.Object({
  mode: Type.Union([Type.Literal("search"), Type.Literal("fetch"), Type.Literal("full")]),
  query: Type.Optional(Type.String({ description: "Search query to run in search mode" })),
  url: Type.Optional(Type.String({ description: "URL to fetch in fetch or full mode" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of search results" })),
});

const FETCH_SYSTEM_PROMPT = [
  "You extract the important content from a fetched webpage.",
  "Return valid JSON only.",
  "JSON keys: summary, key_points, important_text.",
  "summary: short string.",
  "key_points: array of short strings.",
  "important_text: concise plain text containing the key material from the page, not boilerplate.",
  "Do not wrap the JSON in markdown fences.",
].join(" ");

function formatSearchResult(result: {
  title?: string;
  url?: string;
  description?: string;
}) {
  return `${result.title ?? "(untitled)"}\nURL: ${result.url ?? ""}\nDescription: ${result.description ?? ""}`;
}

function formatFetchResult(result: {
  url?: string;
  page_title?: string;
  summary_model?: string;
  summary?: string;
  key_points?: string[];
  important_text?: string;
}) {
  return [
    `Title: ${result.page_title ?? ""}`,
    `URL: ${result.url ?? ""}`,
    `Model: ${result.summary_model ?? ""}`,
    "",
    `Summary: ${result.summary ?? ""}`,
    "",
    "Key points:",
    ...((result.key_points ?? []).map((point) => `- ${point}`)),
    "",
    "Important text:",
    result.important_text ?? "",
  ].join("\n").trim();
}

function getHelperPaths() {
  const base = join(getAgentDir(), "extensions", "web-use");
  return {
    base,
    scriptPath: join(base, "web_use.py"),
  };
}

function resolvePython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function runScript(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const abortHandler = () => {
      child.kill("SIGTERM");
      reject(new Error("web_use aborted"));
    };

    signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", abortHandler);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `web_use exited with code ${code}`));
    });
  });
}

function extractText(message: { content?: Array<{ type?: string; text?: string }> }): string {
  return (message.content ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

async function summarizeFetchedPage(ctx: any, url: string, pageTitle: string, pageText: string) {
  const userMessage: UserMessage = {
    role: "user",
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: [
          `URL: ${url}`,
          `Page title: ${pageTitle || "(none)"}`,
          "",
          "Extract the important content from this page:",
          pageText,
        ].join("\n"),
      },
    ],
  };

  const { response, model } = await completeWithModelFallback(
    ctx,
    "webSummarization",
    { systemPrompt: FETCH_SYSTEM_PROMPT, messages: [userMessage] },
    { signal: ctx.signal },
    { fallbackToCurrent: true, fallbackToAnyAvailable: true },
  );

  if (response.stopReason === "aborted") {
    throw new Error("web_use fetch summarization aborted");
  }

  const rawText = extractText(response);
  const parsed = extractJsonObject(rawText);

  return {
    summary_model: `${model.provider}/${model.id}`,
    summary: typeof parsed?.summary === "string" ? parsed.summary : rawText,
    key_points: Array.isArray(parsed?.key_points)
      ? parsed.key_points.map((item) => String(item)).filter(Boolean)
      : [],
    important_text: typeof parsed?.important_text === "string" ? parsed.important_text : rawText,
  };
}

export default function webUseExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_use",
    label: "Web Use",
    description: "Search the web (Exa primary, DuckDuckGo fallback), fetch a URL and extract important text, or fetch the full HTML of a page.",
    promptSnippet: "Search the web, fetch a URL and summarize the important content, or fetch the full HTML of a page.",
    promptGuidelines: [
      "Use web_use with mode=search when the user wants web search results with titles, URLs, and short descriptions.",
      "Use web_use with mode=fetch when the user provides a URL and wants the important text extracted from that page.",
      "Use web_use with mode=full when the user needs the raw full HTML of a page (fetched via curl).",
    ],
    parameters: WebUseParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.mode === "search" && !params.query) {
        throw new Error("web_use search mode requires query");
      }
      if ((params.mode === "fetch" || params.mode === "full") && !params.url) {
        throw new Error(`web_use ${params.mode} mode requires url`);
      }

      const { scriptPath } = getHelperPaths();
      if (!existsSync(scriptPath)) {
        throw new Error(`Missing helper script: ${scriptPath}`);
      }

      const python = resolvePython();
      const args = [scriptPath];

      if (params.mode === "search") {
        args.push("--search", params.query!);
        args.push("--limit", String(params.limit ?? 5));
        onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }] });
      } else if (params.mode === "full") {
        args.push("--full", params.url!);
        onUpdate?.({ content: [{ type: "text", text: `Fetching full HTML with curl: ${params.url}` }] });
      } else {
        args.push("--fetch", params.url!);
        onUpdate?.({ content: [{ type: "text", text: `Fetching URL with curl: ${params.url}` }] });
      }

      const raw = await runScript(python, args, ctx.cwd, signal);
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      if (params.mode === "search") {
        const results = Array.isArray(parsed.results) ? parsed.results as Array<Record<string, string>> : [];
        const text = [
          `Search results for: ${String(parsed.query ?? params.query ?? "")}`,
          "",
          ...results.map((result, index) => `${index + 1}. ${formatSearchResult(result)}`),
        ].join("\n\n");

        return {
          content: [{ type: "text", text }],
          details: { ...parsed, resultCount: results.length },
        };
      }

      if (params.mode === "full") {
        const html = String(parsed.html ?? "");
        const htmlLength = Number(parsed.html_length ?? html.length);
        const MAX_HTML_DISPLAY = 8000;
        const displayHtml = html.length > MAX_HTML_DISPLAY
          ? html.slice(0, MAX_HTML_DISPLAY) + `\n\n... (truncated in display, full HTML is ${htmlLength} bytes)`
          : html;

        return {
          content: [{ type: "text", text: `Full HTML from ${params.url} (${htmlLength} bytes):\n\n${displayHtml}` }],
          details: parsed,
        };
      }

      const pageTitle = String(parsed.page_title ?? "");
      const pageText = String(parsed.page_text ?? "");
      if (!pageText) {
        throw new Error("Fetched page did not return readable text");
      }

      onUpdate?.({ content: [{ type: "text", text: "Summarizing fetched page with a pi model..." }] });
      const summary = await summarizeFetchedPage(ctx, params.url!, pageTitle, pageText);

      const result = {
        mode: "fetch",
        url: params.url,
        page_title: pageTitle,
        text_length: parsed.text_length,
        truncated: parsed.truncated,
        ...summary,
      };

      return {
        content: [{ type: "text", text: formatFetchResult(result) }],
        details: result,
      };
    },

    renderCall(args, theme, _context) {
      if (args.mode === "search") {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("web_use"))} ${theme.fg("accent", "search")}: ${theme.fg("toolOutput", args.query ?? "...")}`,
          0,
          0,
        );
      }
      if (args.mode === "full") {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("web_use"))} ${theme.fg("accent", "full")}: ${theme.fg("toolOutput", args.url ?? "...")}`,
          0,
          0,
        );
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_use"))} ${theme.fg("accent", "fetch")}: ${theme.fg("toolOutput", args.url ?? "...")}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, _context) {
      // Collapsed: show minimal summary
      if (!expanded) {
        const details = result.details as Record<string, unknown> | undefined;
        if (details?.mode === "fetch") {
          const title = String(details.page_title ?? "");
          const truncated = details.truncated ? " (truncated)" : "";
          return new Text(theme.fg("muted", ` → fetched${title ? `: ${title}` : ""}${truncated}`), 0, 0);
        }
        if (details?.resultCount !== undefined) {
          const count = Number(details.resultCount) || 0;
          return new Text(theme.fg("muted", ` → ${count} result${count !== 1 ? "s" : ""}`), 0, 0);
        }
        if (details?.html_length !== undefined) {
          const len = Number(details.html_length) || 0;
          return new Text(theme.fg("muted", ` → ${len} bytes`), 0, 0);
        }
        return new Text("", 0, 0);
      }

      // Expanded: show full output
      const textContent = result.content.find((c) => c.type === "text");
      if (!textContent || textContent.type !== "text") {
        return new Text("", 0, 0);
      }

      const lines = textContent.text.split("\n");
      const output = lines.map((line) => theme.fg("toolOutput", line)).join("\n");
      return new Text(`\n${output}`, 0, 0);
    },
  });
}
