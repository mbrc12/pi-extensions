import type { UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { completeWithModelFallback } from "../shared/model-config.ts";
import { curlFetchFull, runFetch, runSearch } from "./web.ts";

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

/** Collapsed-result suffix naming the backend that answered, for example " (curl)". */
function engineSuffix(details: Record<string, unknown> | undefined, extra?: string): string {
  const parts = [details?.engine, extra]
    .filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

export default function webUseExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_use",
    label: "Web Use",
    description: "Search the web, fetch a URL and extract important text, or fetch the full HTML of a page.",
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

      if (params.mode === "search") {
        onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }], details: {} });
        const payload = await runSearch(params.query!, params.limit ?? 5, "auto", signal);
        const text = [
          `Search results for: ${payload.query} (via ${payload.engine})`,
          "",
          ...payload.results.map((result, index) => `${index + 1}. ${formatSearchResult(result)}`),
        ].join("\n\n");

        return {
          content: [{ type: "text", text }],
          details: { ...payload, resultCount: payload.results.length },
        };
      }

      if (params.mode === "full") {
        onUpdate?.({ content: [{ type: "text", text: `Fetching full HTML with curl: ${params.url}` }], details: {} });
        const payload = await curlFetchFull(params.url!, signal);
        const MAX_HTML_DISPLAY = 8000;
        const displayHtml = payload.html.length > MAX_HTML_DISPLAY
          ? payload.html.slice(0, MAX_HTML_DISPLAY) + `\n\n... (truncated in display, full HTML is ${payload.html_length} bytes)`
          : payload.html;

        return {
          content: [{ type: "text", text: `Full HTML from ${params.url} (${payload.html_length} bytes):\n\n${displayHtml}` }],
          details: payload,
        };
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching URL: ${params.url}` }], details: {} });
      const payload = await runFetch(params.url!, "auto", signal);
      const pageTitle = payload.page_title;
      const pageText = payload.page_text;
      if (!pageText) {
        throw new Error("Fetched page did not return readable text");
      }

      onUpdate?.({ content: [{ type: "text", text: "Summarizing fetched page with a pi model..." }], details: {} });
      const summary = await summarizeFetchedPage(ctx, params.url!, pageTitle, pageText);

      const result = {
        mode: "fetch",
        engine: payload.engine,
        url: params.url,
        page_title: pageTitle,
        text_length: payload.text_length,
        truncated: payload.truncated,
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
          const suffix = engineSuffix(details, details.truncated ? "truncated" : undefined);
          return new Text(theme.fg("muted", ` → fetched${title ? `: ${title}` : ""}${suffix}`), 0, 0);
        }
        if (details?.resultCount !== undefined) {
          const count = Number(details.resultCount) || 0;
          return new Text(
            theme.fg("muted", ` → ${count} result${count !== 1 ? "s" : ""}${engineSuffix(details)}`),
            0,
            0,
          );
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
